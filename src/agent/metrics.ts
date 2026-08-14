import { db } from '../db/database'
import { getSetting, setSetting } from '../db/crud'
import type { Transaction } from '../types'
import { platformOf, isImpulsive } from '../utils/impulseEngine'

// ==================== 本地工具 ====================

function pad2(n: number): string { return String(n).padStart(2, '0') }

function dateKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function isIncome(tx: Transaction): boolean { return tx.txType === 'income' }

/** 储蓄转入记录（仅记账展示，不参与消费统计） */
function isTransfer(tx: Transaction): boolean { return tx.note === '储蓄转入' }

/** 深夜判定：22:00-06:00 */
function isDeepNight(h: number): boolean { return h >= 22 || h < 6 }

/** 场景时间标签（用于模式命名） */
function timeSceneLabel(h: number): string { return isDeepNight(h) ? '深夜' : '白天' }

/** 2小时时段桶：23 → {start:22, end:24}；0 → {start:0, end:2} */
export function hourBucket(h: number): { start: number; end: number } {
  const start = Math.floor(h / 2) * 2
  return { start, end: Math.min(24, start + 2) }
}

export function bucketLabel(start: number, end: number): string {
  return `${pad2(start)}:00-${pad2(end % 24)}:00`
}

/** 行为推断：深夜/凌晨 → 刷手机；白天 → 日常浏览 */
function behaviorOf(h: number): string {
  return isDeepNight(h) ? '刷手机' : '日常浏览'
}

// ==================== 实时指标结果 ====================

/**
 * 一次冲动消费的实时分析结果。
 * 前 7 项为指标层核心输出（全部本地代码计算，LLM 只翻译语言），
 * 其余为动作池 / 文案 / 前瞻预测所需联动数据。
 */
export interface ReviewMetrics {
  // ---- ① 冲动强度 0-100（复用已存 impulseScore + 命中维度数归一化） ----
  impulseStrength: number
  impulseScoreRaw: number
  hitDimensions: number
  // ---- ② 预算压力：今日支出 ÷ 日均预算（预算÷月天数）；>1 已超日均 ----
  budgetPressure: number
  dailyAvgBudgetMinor: number
  todayExpenseMinor: number
  // ---- ③ 储蓄伤害 %：这笔金额 ÷ 本月储蓄目标金额 ×100 ----
  savingDamage: number | null
  monthSavingsTargetMinor: number | null
  // ---- ④ 历史重复率：近30天同「时段+平台+分类」场景出现次数（含本笔） ----
  repeatRate: number
  repeatMinor: number
  // ---- ⑤ 触发场景标签：时间+平台+行为 聚类成模式名 ----
  triggerScene: string
  sceneLabel: string
  // ---- ⑥ 冷静期抵抗 %：欲望清单同分类物品放弃率 ----
  coolingResistance: number | null
  coolingSample: number
  // ---- ⑦ 时段脆弱度 %：该2小时窗口近30天冲动占比；>50 高频窗口 ----
  timeFragility: number
  highRiskSlot: boolean
  slotWindowLabel: string
  // ---- 联动数据 ----
  debtTotalMinor: number
  budgetMinor: number
  monthExpenseMinor: number
  /** 这笔会让储蓄进度从多少掉到多少（当前+这笔 / 当前，占目标百分比） */
  savingsGoalPctBefore: number | null
  savingsGoalPctAfter: number | null
  // ---- 便捷字段 ----
  isDeepNight: boolean
  platform: string | null
  hour: number
  category: string
}

// ==================== ① computeMetrics：七项实时指标 ====================

/**
 * 对一笔已保存的冲动消费实时计算 7 项指标 + 联动数据。
 * 联动：transactions（今日流水）/ wishlist（冷静期放弃率）/ 预算 / 储蓄 / 负债。
 * 全部本地代码计算；LLM 只负责把结果翻译成人话。
 */
export async function computeMetrics(tx: Transaction): Promise<ReviewMetrics> {
  const allTxs = await db.transactions.toArray()
  const goal = await db.savingsGoals.toArray().then(list => list.find(g => g.isActive) ?? list[0] ?? null)
  const debts = await db.debts.toArray()
  const wishlist = await db.wishlist.toArray()

  const now = Date.now()
  const DAY = 86_400_000
  const h = new Date(tx.time).getHours()
  const platform = platformOf(tx.merchant)
  const deepNight = isDeepNight(h)

  // ---- 本月 / 今日支出（含本笔） ----
  const nowD = new Date()
  const mk = `${nowD.getFullYear()}-${pad2(nowD.getMonth() + 1)}`
  const today = `${mk}-${pad2(nowD.getDate())}`
  let monthExpenseMinor = 0
  let todayExpenseMinor = 0
  for (const t of allTxs) {
    if (isIncome(t) || isTransfer(t)) continue
    const k = dateKey(t.time)
    if (k.startsWith(mk)) monthExpenseMinor += t.amountMinor
    if (k === today) todayExpenseMinor += t.amountMinor
  }

  // ---- ① 冲动强度：复用已存冲动指数 + 命中维度数（from 本地规则引擎 reasons） ----
  // 维度命中数直接取已存冲动指数（评分时已计入各维度）；这里做轻微归一化增强
  const hitDimensions = tx.impulseScore > 0 ? Math.min(5, Math.round(tx.impulseScore / 20)) : 0
  const impulseStrength = Math.max(0, Math.min(100, Math.round(tx.impulseScore + hitDimensions * 2)))

  // ---- ② 预算压力：今日支出 ÷ 日均预算 ----
  const daysInMonth = new Date(nowD.getFullYear(), nowD.getMonth() + 1, 0).getDate()
  const budgetRaw = await db.settings.get('monthlyBudget')
  const budgetMinor = typeof budgetRaw?.value === 'number' ? budgetRaw.value : 1000_00
  const dailyAvgBudgetMinor = daysInMonth > 0 ? budgetMinor / daysInMonth : 0
  const budgetPressure = dailyAvgBudgetMinor > 0
    ? Math.round((todayExpenseMinor / dailyAvgBudgetMinor) * 100) / 100
    : 0

  // ---- ③ 储蓄伤害：这笔金额 ÷ 本月储蓄目标金额 ×100 ----
  // 本月储蓄目标：有截止日期按剩余月份均摊，否则按年化（目标/12）
  let monthSavingsTargetMinor: number | null = null
  if (goal && goal.targetMinor > 0) {
    if (goal.deadline) {
      const dl = new Date(goal.deadline)
      const monthsLeft = Math.max(1, (dl.getFullYear() - nowD.getFullYear()) * 12 + (dl.getMonth() - nowD.getMonth()))
      monthSavingsTargetMinor = Math.round(goal.targetMinor / monthsLeft)
    } else {
      monthSavingsTargetMinor = Math.round(goal.targetMinor / 12)
    }
  }
  const savingDamage = monthSavingsTargetMinor && monthSavingsTargetMinor > 0
    ? Math.round((tx.amountMinor / monthSavingsTargetMinor) * 1000) / 10
    : null

  // ---- ④ 历史重复率：近30天 同「深夜/白天 + 平台 + 分类」场景出现次数（含本笔） ----
  const slotTag = timeSceneLabel(h)
  let repeatRate = 1
  let repeatMinor = tx.amountMinor
  for (const t of allTxs) {
    if (isIncome(t) || isTransfer(t)) continue
    if (t.id === tx.id) continue
    const tTime = new Date(t.time).getTime()
    if (tTime > now || now - tTime > 30 * DAY) continue
    if (timeSceneLabel(new Date(t.time).getHours()) !== slotTag) continue
    if (platformOf(t.merchant) !== platform) continue
    if (t.category !== tx.category) continue
    repeatRate++
    repeatMinor += t.amountMinor
  }

  // ---- ⑤ 触发场景标签：时间 + 平台 + 行为，聚类成模式名 ----
  const behavior = behaviorOf(h)
  const sceneLabel = `${slotTag}${platform ? '·' + platform : ''}·${behavior}`
  const triggerScene = platform ? `${slotTag}${platform}模式` : `${slotTag}${behavior}模式`

  // ---- ⑥ 冷静期抵抗：欲望清单同类商品（同分类/同平台/同商家）放弃率 ----
  const matchedWish = wishlist.filter(w => {
    if (platform && platformOf(w.name) === platform) return true
    if (tx.category && w.name.includes(tx.category)) return true
    if (tx.merchant && w.name.includes(tx.merchant)) return true
    return false
  })
  const decided = matchedWish.filter(w => w.status === 'confirmed' || w.status === 'abandoned')
  const abandoned = decided.filter(w => w.status === 'abandoned').length
  const coolingResistance = decided.length > 0 ? Math.round((abandoned / decided.length) * 100) : null

  // ---- ⑦ 时段脆弱度：该2小时窗口近30天冲动频次占全天比例 ----
  const { start, end } = hourBucket(h)
  const slotWindowLabel = bucketLabel(start, end)
  let slotCount = 0
  let totalImpulses = 0
  for (const t of allTxs) {
    if (isIncome(t) || isTransfer(t)) continue
    if (!isImpulsive(t.impulseLevel)) continue
    const tTime = new Date(t.time).getTime()
    if (tTime > now || now - tTime > 30 * DAY) continue
    totalImpulses++
    const b = hourBucket(new Date(t.time).getHours())
    if (b.start === start && b.end === end) slotCount++
  }
  const timeFragility = totalImpulses > 0 ? Math.round((slotCount / totalImpulses) * 100) : 0
  const highRiskSlot = timeFragility > 50

  // ---- 联动：负债 / 储蓄进度 ----
  const debtTotalMinor = debts.reduce((s, d) => s + d.remainingMinor, 0)
  const goalPct = goal && goal.targetMinor > 0
    ? (currentMinor: number) => Math.round((currentMinor / goal.targetMinor) * 100)
    : null
  const savingsGoalPctBefore = goalPct && goal ? goalPct(goal.currentMinor + tx.amountMinor) : null
  const savingsGoalPctAfter = goalPct && goal ? goalPct(goal.currentMinor) : null

  return {
    impulseStrength,
    impulseScoreRaw: tx.impulseScore,
    hitDimensions,
    budgetPressure,
    dailyAvgBudgetMinor,
    todayExpenseMinor,
    savingDamage,
    monthSavingsTargetMinor,
    repeatRate,
    repeatMinor,
    triggerScene,
    sceneLabel,
    coolingResistance,
    coolingSample: decided.length,
    timeFragility,
    highRiskSlot,
    slotWindowLabel,
    debtTotalMinor,
    budgetMinor,
    monthExpenseMinor,
    savingsGoalPctBefore,
    savingsGoalPctAfter,
    isDeepNight: deepNight,
    platform,
    hour: h,
    category: tx.category,
  }
}

// ==================== 今日冲动概览（复盘总结卡用） ====================

export interface DayImpulseOverview {
  count: number
  totalMinor: number
  maxTx: { merchant: string; amountMinor: number; time: string } | null
}

/** 今日冲动概览（从交易表实时算，供总结卡顶部引用） */
export async function buildDayOverview(): Promise<DayImpulseOverview> {
  const txs = await db.transactions.toArray()
  const now = new Date()
  let count = 0
  let totalMinor = 0
  let max: DayImpulseOverview['maxTx'] = null
  for (const t of txs) {
    if (t.txType !== 'expense' || t.note === '储蓄转入') continue
    const d = new Date(t.time)
    if (d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth() || d.getDate() !== now.getDate()) continue
    if (!isImpulsive(t.impulseLevel)) continue
    count++
    totalMinor += t.amountMinor
    if (!max || t.amountMinor > max.amountMinor) {
      max = { merchant: t.merchant, amountMinor: t.amountMinor, time: t.time }
    }
  }
  return { count, totalMinor, maxTx: max }
}

// ==================== 高频冲动窗口分析（时段脆弱度 → 预测） ====================

export interface RiskWindow {
  /** 0=周日 … 6=周六 */
  dayOfWeek: number
  dayLabel: string
  startHour: number
  endHour: number
  windowLabel: string
  count: number
  avgMinor: number
  /** 占近30天全部冲动的比例（%） */
  share: number
}

const DAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * 统计近 days 天冲动消费的（星期 × 2小时窗口）分布，返回出现 ≥2 次的高频窗口（按次数降序）。
 * 这是"时段脆弱度"在时间轴上的聚合，供前瞻提醒与首页提示条使用。
 */
export async function findHighRiskWindows(days = 30): Promise<RiskWindow[]> {
  const txs = await db.transactions.toArray()
  const now = Date.now()
  const map = new Map<string, { day: number; start: number; end: number; count: number; minor: number }>()
  let total = 0
  for (const tx of txs) {
    if (isIncome(tx) || isTransfer(tx)) continue
    if (!isImpulsive(tx.impulseLevel)) continue
    const t = new Date(tx.time)
    const ts = t.getTime()
    if (ts > now || now - ts > days * 86_400_000) continue
    total++
    const b = hourBucket(t.getHours())
    const key = `${t.getDay()}-${b.start}`
    const row = map.get(key) ?? { day: t.getDay(), start: b.start, end: b.end, count: 0, minor: 0 }
    row.count++
    row.minor += tx.amountMinor
    map.set(key, row)
  }
  return [...map.values()]
    .filter(w => w.count >= 2)
    .sort((a, b) => b.count - a.count || b.minor - a.minor)
    .map(w => ({
      dayOfWeek: w.day,
      dayLabel: DAY_LABELS[w.day],
      startHour: w.start,
      endHour: w.end,
      windowLabel: bucketLabel(w.start, w.end),
      count: w.count,
      avgMinor: w.count > 0 ? Math.round(w.minor / w.count) : 0,
      share: total > 0 ? Math.round((w.count / total) * 100) : 0,
    }))
}

// ==================== 高频冲动窗口（按小时桶，主动拦截用） ====================

export interface FragileWindow {
  start: number
  end: number
  label: string
  count: number
  /** 占近30天全部冲动的比例（%） */
  share: number
}

const FRAGILE_WINDOWS_KEY = 'fragileWindows'

/**
 * 统计近30天冲动消费的时段分布（按2小时桶，不区分星期），
 * 找出占比最高的 1-2 个时段，持久化到 settings `fragileWindows`。
 * 记账页/设置页据此做"花之前拦你"的主动拦截。
 */
export async function computeFragileWindows(days = 30): Promise<FragileWindow[]> {
  const txs = await db.transactions.toArray()
  const now = Date.now()
  const map = new Map<number, { start: number; end: number; count: number }>()
  let total = 0
  for (const tx of txs) {
    if (isIncome(tx) || isTransfer(tx)) continue
    if (!isImpulsive(tx.impulseLevel)) continue
    const t = new Date(tx.time).getTime()
    if (t > now || now - t > days * 86_400_000) continue
    total++
    const b = hourBucket(new Date(tx.time).getHours())
    const row = map.get(b.start) ?? { start: b.start, end: b.end, count: 0 }
    row.count++
    map.set(b.start, row)
  }
  if (total === 0) return []

  const buckets = [...map.values()].sort((a, b) => b.count - a.count)
  const top = buckets[0]
  // 第二个窗口需 ≥2 次且占比 ≥20%（否则只有 1 个高频窗口）
  const second = buckets[1] && buckets[1].count >= 2 && buckets[1].count / total >= 0.2 ? buckets[1] : null
  const picks = second ? [top, second] : [top]

  const result: FragileWindow[] = picks.map(w => ({
    start: w.start,
    end: w.end,
    label: bucketLabel(w.start, w.end),
    count: w.count,
    share: Math.round((w.count / total) * 100),
  }))
  await setSetting(FRAGILE_WINDOWS_KEY, JSON.stringify(result))
  return result
}

/** 当前时间是否落在高频冲动窗口内（读取 settings fragileWindows，返回命中的窗口） */
export async function getFragileWindowNow(now = new Date()): Promise<FragileWindow | null> {
  const raw = await getSetting(FRAGILE_WINDOWS_KEY)
  if (typeof raw !== 'string') return null
  try {
    const list = JSON.parse(raw) as FragileWindow[]
    if (!Array.isArray(list) || list.length === 0) return null
    const h = now.getHours()
    return list.find(w => h >= w.start && h < (w.end === 0 ? 24 : w.end)) ?? null
  } catch {
    return null
  }
}

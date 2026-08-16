import { db } from '../db/database'
import { getSetting } from '../db/crud'
import type { Transaction, SavingsGoal } from '../types'
import { isImpulsive, SHOP_CATEGORIES, platformOf } from './impulseEngine'
import { buildDebtSnapshot } from '../debt/debtContext'
import { simulateClearDays } from '../debt/calc'

// ==================== 工具 ====================

const BUDGET_KEY = 'monthlyBudget'
const DEFAULT_BUDGET = 1000_00 // ¥1,000

function pad2(n: number): string { return String(n).padStart(2, '0') }
function monthKey(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}` }
function monthKeyOffset(offset: number): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1 + offset)}`
}
function isIncome(tx: Transaction): boolean { return (tx as { txType?: string }).txType === 'income' }
// 储蓄转入记录（仅记账展示，不参与消费统计）
function isTransfer(tx: Transaction): boolean { return tx.note === '储蓄转入' }
function yuan(minor: number): number { return Math.round((minor / 100) * 100) / 100 }
function slotOf(h: number): string {
  if (h < 6) return '凌晨'
  if (h < 12) return '上午'
  if (h < 18) return '下午'
  if (h < 22) return '晚上'
  return '深夜'
}

async function getAllTxs(): Promise<Transaction[]> {
  return db.transactions.toArray()
}
async function getBudget(): Promise<number> {
  const raw = await getSetting(BUDGET_KEY)
  return typeof raw === 'number' ? raw : DEFAULT_BUDGET
}

/** 是否信贷支付（花呗/白条/抖音月付/先用后付/信用卡/信用支付） */
function isCreditPay(tx: Transaction): boolean {
  const pm = String(tx.paymentMethod ?? '')
  if (['花呗', '京东白条', '抖音月付', '先用后付', '信用卡', '信用支付'].includes(pm)) return true
  const fs = String((tx as { fundingSource?: string }).fundingSource ?? '')
  return ['huabei', 'baitiao', 'douyin_month', 'pdd_bnpl', 'credit_card'].includes(fs)
}

/**
 * 债务-冲动联合统计（区间内用信贷支付的冲动消费 + 清零日累计推迟天数）：
 * 逐账户取月还款计划（用户手填 → 本期应还 → 最低还款），用 simulateClearDays
 * 对比"含这些消费"与"不含这些消费"的清零天数差（全由代码算，AI 不得改动数字）。
 */
async function creditImpulseJoint(txs: Transaction[], startTs: number, endTs: number): Promise<{
  creditImpulseCount: number
  creditImpulseTotal: number
  creditClearDelayDays: number
}> {
  const creditTxs = txs.filter(tx =>
    !isIncome(tx) && !isTransfer(tx) &&
    new Date(tx.time).getTime() >= startTs && new Date(tx.time).getTime() <= endTs &&
    isImpulsive(tx.impulseLevel) && isCreditPay(tx)
  )
  const total = creditTxs.reduce((s, t) => s + t.amountMinor, 0)
  if (creditTxs.length === 0) return { creditImpulseCount: 0, creditImpulseTotal: 0, creditClearDelayDays: 0 }
  const snapshot = await buildDebtSnapshot()
  const byAccount = new Map<string, number>()
  for (const t of creditTxs) {
    const key = t.lienAccountId ?? ''
    if (key) byAccount.set(key, (byAccount.get(key) ?? 0) + t.amountMinor)
  }
  let delayDays = 0
  for (const acc of snapshot.accounts) {
    const amt = byAccount.get(acc.account.id)
    if (!amt || amt <= 0) continue
    const userInst = snapshot.installments
      .filter(i => i.accountId === acc.account.id && i.source === 'user')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
    const monthly = userInst?.principalPerMinor ?? acc.dueMinor ?? acc.minPaymentMinor ?? 0
    if (monthly <= 0) continue
    const before = simulateClearDays(Math.max(0, acc.principalRemMinor - amt), monthly, acc.dailyRate)
    const after = simulateClearDays(acc.principalRemMinor, monthly, acc.dailyRate)
    if (before === null || after === null) continue
    delayDays += Math.max(0, after - before)
  }
  return {
    creditImpulseCount: creditTxs.length,
    creditImpulseTotal: yuan(total),
    creditClearDelayDays: Math.round(delayDays),
  }
}
async function getGoal(): Promise<SavingsGoal | null> {
  const goals = await db.savingsGoals.toArray()
  return goals.find(g => g.isActive) ?? goals[0] ?? null
}

// 本月还款（日程 type=debt）
async function monthRepayAmount(): Promise<number> {
  const now = new Date()
  const mk = monthKey(now)
  const scheds = await db.schedules.toArray()
  let total = 0
  for (const s of scheds) {
    if (s.type !== 'debt') continue
    if (s.repeat === 'none') {
      if (s.date.startsWith(mk)) total += s.amountMinor
    } else if (s.repeat === 'monthly') {
      total += s.amountMinor
    } else {
      const d = new Date(s.date)
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) total += s.amountMinor
    }
  }
  return total
}

// ==================== 每日摘要 facts ====================

/** 当天冷静流程记录（settings key = dailyCooling，供每日报告引用） */
async function getDayCooling(): Promise<{
  hasCooling: boolean
  triggerCount: number
  blockedMinor: number
  insightSummary: string | null
}> {
  const now = new Date()
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  const raw = await getSetting('dailyCooling')
  const empty = { hasCooling: false, triggerCount: 0, blockedMinor: 0, insightSummary: null }
  if (typeof raw !== 'string') return empty
  try {
    const rec = JSON.parse(raw) as { date?: string; count?: number; blockedMinor?: number; insightSummary?: string | null }
    if (!rec || rec.date !== today) return empty
    const count = Number(rec.count) || 0
    const summary = typeof rec.insightSummary === 'string' && rec.insightSummary ? rec.insightSummary : null
    return { hasCooling: count > 0, triggerCount: count, blockedMinor: Number(rec.blockedMinor) || 0, insightSummary: summary }
  } catch {
    return empty
  }
}

export async function getDayFacts(): Promise<Record<string, unknown>> {
  const now = new Date()
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  const mk = monthKey(now)
  const budget = await getBudget()
  const txs = await getAllTxs()

  const dayTxs: Transaction[] = []
  let monthExpense = 0
  let monthIncome = 0
  let totalCount = 0
  let monthImpulseCount = 0
  for (const tx of txs) {
    const d = new Date(tx.time)
    if (monthKey(d) !== mk) continue
    if (isIncome(tx)) monthIncome += tx.amountMinor
    else if (isTransfer(tx)) continue
    else {
      monthExpense += tx.amountMinor
      totalCount++
      if (isImpulsive(tx.impulseLevel)) monthImpulseCount++
    }
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
      if (isIncome(tx)) {
        // 今日收入单独统计（在下方汇总）
      } else if (!isTransfer(tx)) {
        dayTxs.push(tx)
      }
    }
  }

  // 今日收入 / 支出
  let todayIncome = 0
  let todayCount = 0
  for (const tx of txs) {
    const d = new Date(tx.time)
    if (d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth() || d.getDate() !== now.getDate()) continue
    if (isTransfer(tx)) continue
    if (isIncome(tx)) todayIncome += tx.amountMinor
    else todayCount++
  }
  const expenses = dayTxs.filter(tx => !isIncome(tx))
  const todayExpense = expenses.reduce((s, tx) => s + tx.amountMinor, 0)
  const top3 = [...expenses].sort((a, b) => b.amountMinor - a.amountMinor).slice(0, 3)
    .map(tx => ({ merchant: tx.merchant, amount: yuan(tx.amountMinor) }))

  const restDays = Math.max(0, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate())
  const remaining = budget - monthExpense
  const dailyBudget = restDays > 0 ? Math.max(0, remaining / restDays) : 0

  // 今日支出时段分布（柱状图 + 下钻明细）
  const slotBase = ['凌晨', '上午', '下午', '晚上', '深夜'].map(name => ({ name, amount: 0, count: 0 }))
  for (const tx of expenses) {
    const row = slotBase.find(x => x.name === slotOf(new Date(tx.time).getHours()))
    if (row) { row.amount += tx.amountMinor; row.count++ }
  }
  const todaySlotDist = slotBase.map(r => ({ name: r.name, amount: yuan(r.amount), count: r.count }))

  // 今日全部交易明细（下钻/查看明细用）
  const todayTxs = [...expenses]
    .sort((a, b) => (a.time < b.time ? 1 : -1))
    .map(tx => ({
      merchant: tx.merchant, category: tx.category, amount: yuan(tx.amountMinor),
      time: new Date(tx.time).toTimeString().slice(0, 5), paymentMethod: tx.paymentMethod,
      impulseLevel: tx.impulseLevel, impulseScore: tx.impulseScore,
    }))

  // 本月分类占比（环形图：≤6 分类，超的合并"其他"）
  const catMap: Record<string, number> = {}
  for (const tx of txs) {
    if (isIncome(tx) || isTransfer(tx)) continue
    if (monthKey(new Date(tx.time)) !== mk) continue
    catMap[tx.category] = (catMap[tx.category] || 0) + tx.amountMinor
  }
  const catSorted = Object.entries(catMap).sort((a, b) => b[1] - a[1])
  const catTop = catSorted.slice(0, 6).map(([name, v]) => ({ name, amount: yuan(v) }))
  const catOther = catSorted.slice(6).reduce((s, [, v]) => s + v, 0)
  if (catOther > 0) catTop.push({ name: '其他', amount: yuan(catOther) })

  // 今日冷静流程记录（触发过冷静流程时，报告增加"🧊 今日冷静记录"区块）
  const cooling = await getDayCooling()
  // 债务-冲动联动（今日信贷冲动消费 → 清零日推迟，沉淀为复盘素材；信贷记一笔即自动纳入）
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const creditJoint = await creditImpulseJoint(txs, dayStart.getTime(), now.getTime())

  return {
    date: today,
    todayExpense: yuan(todayExpense),
    todayIncome: yuan(todayIncome),
    todayCount,
    top3,
    impulseCount: expenses.filter(tx => isImpulsive(tx.impulseLevel)).length,
    budget: yuan(budget),
    monthExpense: yuan(monthExpense),
    remaining: yuan(remaining),
    restDays,
    dailyBudget: yuan(dailyBudget),
    totalTxCount: totalCount,
    monthImpulseCount,
    // 图表数据（前端代码计算）
    todaySlotDist,
    todayTxs,
    monthCategoryDist: catTop,
    // 昨天复盘时定下的明日计划（供今天报告引用）
    yesterdayPromise: await getYesterdayPromise(),
    // 今天触发过冷静流程 → 报告追加"🧊 今日冷静记录"（triggerCount/blockedMinor 单位为元）
    coolingStats: cooling.hasCooling
      ? {
          triggerCount: cooling.triggerCount,
          blockedMinor: yuan(cooling.blockedMinor),
          insightSummary: cooling.insightSummary,
        }
      : null,
    // 今日债务-冲动联动（信贷冲动消费笔数/金额/清零日累计推迟天数）
    ...creditJoint,
  }
}

// ==================== 每日互动复盘 facts ====================

/** 昨日复盘承诺（settings key = dailyReview_日期，取 planLabel） */
async function getYesterdayPromise(): Promise<string | null> {
  const now = new Date()
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  const key = `dailyReview_${y.getFullYear()}-${pad2(y.getMonth() + 1)}-${pad2(y.getDate())}`
  const raw = await getSetting(key)
  if (typeof raw !== 'string') return null
  try {
    const rec = JSON.parse(raw) as { planLabel?: string }
    return rec && typeof rec.planLabel === 'string' && rec.planLabel ? rec.planLabel : null
  } catch {
    return null
  }
}

export interface DayReviewFacts {
  date: string
  impulseCount: number
  impulseTotal: number
  maxImpulse: { merchant: string; amount: number } | null
  dayShopTotal: number
  hasImpulseEvent: boolean
}

/**
 * 检测当天是否有冲动事件（等级2/3累计预警、支付陷阱、或当天冲动记录≥2笔），
 * 并收集互动复盘所需的当日冲动数据。
 */
export async function getDayReviewFacts(): Promise<DayReviewFacts> {
  const now = new Date()
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  const txs = await getAllTxs()
  const dayTxs = txs.filter(tx => {
    const d = new Date(tx.time)
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  })
  const expenses = dayTxs.filter(tx => !isIncome(tx) && !isTransfer(tx))
  const impulses = expenses.filter(tx => isImpulsive(tx.impulseLevel))
  const dayShopTotal = expenses
    .filter(tx => SHOP_CATEGORIES.includes(tx.category))
    .reduce((s, tx) => s + tx.amountMinor, 0)
  const hasDeferred = expenses.some(tx => tx.paymentMethod === '先用后付' || tx.paymentMethod === '分期')
  const maxImpulse = impulses.reduce<Transaction | null>((a, b) =>
    (a && a.amountMinor >= b.amountMinor) ? a : b, null)

  return {
    date: today,
    impulseCount: impulses.length,
    impulseTotal: yuan(impulses.reduce((s, tx) => s + tx.amountMinor, 0)),
    maxImpulse: maxImpulse ? { merchant: maxImpulse.merchant, amount: yuan(maxImpulse.amountMinor) } : null,
    dayShopTotal: yuan(dayShopTotal),
    // 有等级2/3累计预警（≥¥150）或支付陷阱，或当天冲动 ≥2 笔 → 视为"触发过冲动事件"
    hasImpulseEvent: impulses.length >= 2 || dayShopTotal >= 150_00 || hasDeferred,
  }
}

// ==================== 每周分析 facts ====================

function startOfWeek(d: Date): Date {
  const s = new Date(d)
  s.setHours(0, 0, 0, 0)
  const day = (s.getDay() + 6) % 7 // 周一 = 0
  s.setDate(s.getDate() - day)
  return s
}

export async function getWeekFacts(): Promise<Record<string, unknown>> {
  const now = new Date()
  const budget = await getBudget()
  const txs = await getAllTxs()

  const weekStart = startOfWeek(now)
  const lastWeekStart = new Date(weekStart)
  lastWeekStart.setDate(lastWeekStart.getDate() - 7)

  const weekTxs: Transaction[] = []
  const lastWeekTxs: Transaction[] = []
  let totalCount = 0
  for (const tx of txs) {
    if (isIncome(tx) || isTransfer(tx)) continue
    const t = new Date(tx.time).getTime()
    if (t >= weekStart.getTime() && t <= now.getTime()) weekTxs.push(tx)
    else if (t >= lastWeekStart.getTime() && t < weekStart.getTime()) lastWeekTxs.push(tx)
    totalCount++
  }

  const weekExpense = weekTxs.reduce((s, tx) => s + tx.amountMinor, 0)
  const lastWeekExpense = lastWeekTxs.reduce((s, tx) => s + tx.amountMinor, 0)
  const delta = weekExpense - lastWeekExpense
  const weekDeltaPct = lastWeekExpense > 0 ? Math.round((delta / lastWeekExpense) * 100) : null

  // 分类占比
  const catMap: Record<string, number> = {}
  for (const tx of weekTxs) catMap[tx.category] = (catMap[tx.category] || 0) + tx.amountMinor
  const categoryBreakdown = Object.entries(catMap)
    .map(([category, v]) => ({ category, amount: yuan(v), pct: weekExpense > 0 ? Math.round((v / weekExpense) * 100) : 0 }))
    .sort((a, b) => b.amount - a.amount)
  const topCategory = categoryBreakdown[0]?.category ?? '—'

  // 平台 Top
  const merMap: Record<string, number> = {}
  for (const tx of weekTxs) merMap[tx.merchant] = (merMap[tx.merchant] || 0) + tx.amountMinor
  const topMerchants = Object.entries(merMap)
    .map(([merchant, v]) => ({ merchant, amount: yuan(v) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3)

  // 冲动统计
  const impulses = weekTxs.filter(tx => isImpulsive(tx.impulseLevel))
  const impulseTotal = impulses.reduce((s, tx) => s + tx.amountMinor, 0)
  // 债务-冲动联合（本周用信贷支付的冲动消费 + 清零日累计推迟天数）
  const creditJoint = await creditImpulseJoint(weekTxs, weekStart.getTime(), now.getTime())
  const slotDist = ['凌晨', '上午', '下午', '晚上', '深夜'].map(name => ({ slot: name, count: 0 }))
  for (const tx of impulses) {
    const row = slotDist.find(x => x.slot === slotOf(new Date(tx.time).getHours()))
    if (row) row.count++
  }
  const lateNightCount = impulses.filter(tx => {
    const h = new Date(tx.time).getHours()
    return h >= 22 || h < 6
  }).length

  // ===== 图表数据：近7天每日支出 + 日均预算参考线 =====
  const dayArr: { date: string; amount: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    const amt = weekTxs
      .filter(tx => {
        const td = new Date(tx.time)
        return `${td.getFullYear()}-${pad2(td.getMonth() + 1)}-${pad2(td.getDate())}` === key
      })
      .reduce((s, tx) => s + tx.amountMinor, 0)
    dayArr.push({ date: key.slice(5), amount: yuan(amt) })
  }
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const dailyAvgBudget = yuan(budget / daysInMonth)

  // ===== 分类堆叠柱：本周 vs 上周 =====
  const lastCatMap: Record<string, number> = {}
  for (const tx of lastWeekTxs) lastCatMap[tx.category] = (lastCatMap[tx.category] || 0) + tx.amountMinor
  const allCats = [...new Set([...Object.keys(catMap), ...Object.keys(lastCatMap)])]
  const categoryStack = allCats.map(c => ({
    category: c,
    thisWeek: yuan(catMap[c] || 0),
    lastWeek: yuan(lastCatMap[c] || 0),
  })).sort((a, b) => (b.thisWeek + b.lastWeek) - (a.thisWeek + a.lastWeek))

  // ===== 本周模式识别 =====
  // 最高频冲动场景（时段×平台）
  const sceneMap: Record<string, number> = {}
  for (const tx of impulses) {
    const h = new Date(tx.time).getHours()
    const tag = (h >= 22 || h < 6) ? '深夜' : slotOf(h)
    const p = platformOf(tx.merchant)
    const key = p ? `${tag}${p}` : tag
    sceneMap[key] = (sceneMap[key] || 0) + 1
  }
  const topScene = Object.entries(sceneMap).sort((a, b) => b[1] - a[1])[0] ?? null

  // 最大变化分类
  const catDelta = Object.entries(lastCatMap).map(([c, lastAmt]) => {
    const curAmt = catMap[c] || 0
    return { category: c, deltaPct: lastAmt > 0 ? Math.round(((curAmt - lastAmt) / lastAmt) * 100) : null }
  }).filter(x => x.deltaPct !== null).sort((a, b) => Math.abs(b.deltaPct!) - Math.abs(a.deltaPct!))[0] ?? null

  // 储蓄率（本周储蓄 = 日均预算×7 - 本周支出，最低0）
  const weeklyBudget = budget / daysInMonth * 7
  const weekSaving = Math.max(0, weeklyBudget - weekExpense)
  const savingsRate = weeklyBudget > 0 ? Math.round((weekSaving / weeklyBudget) * 100) : 0
  // 环比：上周冲动总额 / 上周储蓄率
  const lastWeekImpulse = lastWeekTxs
    .filter(tx => isImpulsive(tx.impulseLevel))
    .reduce((s, tx) => s + tx.amountMinor, 0)
  const impulseDeltaPct = lastWeekImpulse > 0
    ? Math.round(((impulseTotal - lastWeekImpulse) / lastWeekImpulse) * 100)
    : (impulseTotal > 0 ? null : 0)
  const lastWeekSaving = Math.max(0, weeklyBudget - lastWeekExpense)
  const savingDeltaPct = lastWeekSaving > 0
    ? Math.round(((weekSaving - lastWeekSaving) / lastWeekSaving) * 100)
    : (weekSaving > 0 ? null : 0)

  // ===== 历史高消费日（近90天按星期几统计，找出最高1-2个） =====
  const weekdayTotal: Record<number, { amt: number; days: number }> = {}
  const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  for (const tx of txs) {
    if (isIncome(tx) || isTransfer(tx)) continue
    const d = new Date(tx.time)
    const ts = d.getTime()
    if (ts > now.getTime() || now.getTime() - ts > 90 * 86_400_000) continue
    const wd = d.getDay()
    const e = weekdayTotal[wd] ?? { amt: 0, days: 0 }
    e.amt += tx.amountMinor
    weekdayTotal[wd] = e
  }
  // 统计过去90天各星期几出现的次数
  const wdDays: Record<number, number> = {}
  for (let i = 0; i < 90; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    wdDays[d.getDay()] = (wdDays[d.getDay()] || 0) + 1
  }
  const highWeekdays = Object.entries(weekdayTotal)
    .map(([wd, e]) => ({
      day: dayNames[Number(wd)],
      avg: e.days > 0 ? e.amt / Math.max(1, wdDays[Number(wd)] || 1) : 0,
    }))
    .filter(x => x.avg > 0)
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 2)

  // 情绪模式（规则判断）
  const avgImpulse = impulses.length > 0 ? impulseTotal / impulses.length : 0
  let mood: string
  if (lateNightCount >= 2 && lateNightCount >= impulses.length * 0.4) {
    mood = '压力型 / 报复性熬夜购物'
  } else if (impulses.length >= 4 && avgImpulse < 5000) {
    mood = '无聊型（白天高频小额消费）'
  } else if (impulses.length <= 2 && avgImpulse >= 20000) {
    mood = 'FOMO 型（大额偶发冲动）'
  } else if (impulses.length === 0) {
    mood = '本周没有明显冲动消费，状态很好'
  } else {
    mood = '一般型（偶发冲动，需要留意）'
  }

  return {
    weekRange: `${weekStart.getMonth() + 1}/${weekStart.getDate()} - ${now.getMonth() + 1}/${now.getDate()}`,
    weekExpense: yuan(weekExpense),
    lastWeekExpense: yuan(lastWeekExpense),
    weekDeltaPct,
    categoryBreakdown,
    topCategory,
    impulseTotal: yuan(impulseTotal),
    impulseCount: impulses.length,
    lateNightCount,
    slotDist,
    mood,
    topMerchants,
    budget: yuan(budget),
    totalTxCount: totalCount,
    // 图表数据
    weekDailyTrend: dayArr,
    dailyAvgBudget,
    categoryStack,
    topScene: topScene ? { scene: topScene[0], count: topScene[1] } : null,
    catDelta,
    weekSaving: yuan(weekSaving),
    savingsRate,
    impulseDeltaPct,
    savingDeltaPct,
    highWeekdays,
    // 债务-冲动联合分析
    ...creditJoint,
  }
}

// ==================== 每月复盘 facts ====================

export async function getMonthFacts(): Promise<Record<string, unknown>> {
  const now = new Date()
  const curMk = monthKey(now)
  const prevMk = monthKeyOffset(-1)
  const budget = await getBudget()
  const txs = await getAllTxs()
  const debtSnapshot = await buildDebtSnapshot()
  const goal = await getGoal()
  const repay = await monthRepayAmount()

  let monthExpense = 0
  let lastMonthExpense = 0
  let income = 0
  const catThis: Record<string, number> = {}
  const catLast: Record<string, number> = {}
  let impulseThisTotal = 0
  let impulseThisCount = 0
  let impulseLastTotal = 0
  let impulseLastCount = 0
  let totalCount = 0
  const merMap: Record<string, number> = {}
  const nowTs = now.getTime()

  for (const tx of txs) {
    if (isIncome(tx)) {
      if (monthKey(new Date(tx.time)) === curMk) income += tx.amountMinor
      continue
    }
    if (isTransfer(tx)) continue
    const mk = monthKey(new Date(tx.time))
    totalCount++
    if (mk === curMk) {
      monthExpense += tx.amountMinor
      catThis[tx.category] = (catThis[tx.category] || 0) + tx.amountMinor
      merMap[tx.merchant] = (merMap[tx.merchant] || 0) + tx.amountMinor
      if (isImpulsive(tx.impulseLevel)) {
        impulseThisTotal += tx.amountMinor
        impulseThisCount++
      }
    } else if (mk === prevMk) {
      lastMonthExpense += tx.amountMinor
      catLast[tx.category] = (catLast[tx.category] || 0) + tx.amountMinor
      if (isImpulsive(tx.impulseLevel)) {
        impulseLastTotal += tx.amountMinor
        impulseLastCount++
      }
    }
    if (nowTs - new Date(tx.time).getTime() < 365 * 86_400_000) {
      // 近一年都算作样本，帮助报告说明
    }
  }

  const savings = budget - monthExpense
  const lastMonthSavings = budget - lastMonthExpense
  const expenseDelta = monthExpense - lastMonthExpense
  const expenseDeltaPct = lastMonthExpense > 0 ? Math.round((expenseDelta / lastMonthExpense) * 100) : null
  const budgetUsedPct = budget > 0 ? Math.round((monthExpense / budget) * 100) : 0

  const categoryDetail = Object.keys({ ...catThis, ...catLast })
    .map(category => ({
      category,
      amount: yuan(catThis[category] || 0),
      lastAmount: yuan(catLast[category] || 0),
      pct: monthExpense > 0 ? Math.round(((catThis[category] || 0) / monthExpense) * 100) : 0,
    }))
    .sort((a, b) => b.amount - a.amount)

  const topMerchants = Object.entries(merMap)
    .map(([merchant, v]) => ({ merchant, amount: yuan(v) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)

  const debtTotal = debtSnapshot.creditPrincipalMinor
  const debtCount = debtSnapshot.accounts.filter(a => a.principalRemMinor > 0).length
  const prevDebt = debtTotal + repay
  const debtDelta = debtTotal - prevDebt
  // 债务-冲动联合（本月用信贷支付的冲动消费 + 清零日累计推迟天数）
  const creditJoint = await creditImpulseJoint(txs, new Date(now.getFullYear(), now.getMonth(), 1).getTime(), now.getTime())

  const savingsPct = goal && goal.targetMinor > 0 ? Math.round((goal.currentMinor / goal.targetMinor) * 100) : null

  // ===== 近12个月支出/收入趋势（折线） =====
  const trend12: { month: string; expense: number; income: number }[] = []
  for (let off = 11; off >= 0; off--) {
    const d = new Date(now.getFullYear(), now.getMonth() - off, 1)
    const mk12 = monthKey(d)
    let exp12 = 0
    let inc12 = 0
    for (const tx of txs) {
      if (monthKey(new Date(tx.time)) !== mk12) continue
      if (isIncome(tx)) inc12 += tx.amountMinor
      else if (!isTransfer(tx)) exp12 += tx.amountMinor
    }
    trend12.push({ month: `${d.getMonth() + 1}月`, expense: yuan(exp12), income: yuan(inc12) })
  }

  // ===== 风险体检：自动扣费清单（近3月同商家同金额跨月重复 ≥2 个月，且存在对应订阅日程可一键取消）+ 分期/订阅 =====
  const scheds = await db.schedules.toArray()
  const threeMonthAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1).getTime()
  const dedupeMap = new Map<string, { merchant: string; amountMinor: number; count: number; months: Set<string> }>()
  for (const tx of txs) {
    if (isIncome(tx) || isTransfer(tx)) continue
    const ts = new Date(tx.time).getTime()
    if (ts < threeMonthAgo || ts > nowTs) continue
    const key = `${tx.merchant}|${tx.amountMinor}`
    const e = dedupeMap.get(key) ?? { merchant: tx.merchant, amountMinor: tx.amountMinor, count: 0, months: new Set<string>() }
    e.count++
    e.months.add(monthKey(new Date(tx.time)))
    dedupeMap.set(key, e)
  }
  const recurringDeductions = [...dedupeMap.values()]
    .filter(e => e.months.size >= 2)
    // 只保留有对应订阅日程的扣款，保证「取消此订阅」按钮真实生效（删除对应日程）
    .filter(e => scheds.some(s => s.type === 'subscription' &&
      (s.name.includes(e.merchant) || e.merchant.includes(s.name) || Math.abs(s.amountMinor - e.amountMinor) < 1)))
    .map(e => ({
      merchant: e.merchant,
      amount: yuan(e.amountMinor),
      months: e.months.size,
      suspicious: e.months.size >= 3 || (e.months.size === 2 && e.count >= 2),
    }))
    .sort((a, b) => b.amount - a.amount)

  // 分期/先用后付本月合计（警示金额）+ 明细（下钻用）
  let installmentTotal = 0
  let installmentCount = 0
  const installmentTxs: Array<{ merchant: string; amount: number; time: string; paymentMethod: string }> = []
  for (const tx of txs) {
    if (isIncome(tx) || isTransfer(tx)) continue
    if (monthKey(new Date(tx.time)) !== curMk) continue
    if (tx.paymentMethod === '分期' || tx.paymentMethod === '先用后付') {
      installmentTotal += tx.amountMinor
      installmentCount++
      installmentTxs.push({
        merchant: tx.merchant,
        amount: yuan(tx.amountMinor),
        time: tx.time.slice(5, 16),
        paymentMethod: tx.paymentMethod,
      })
    }
  }
  installmentTxs.sort((a, b) => b.amount - a.amount)

  // 订阅月成本（schedules type=subscription 合计）
  const subscriptionMonthly = scheds
    .filter(s => s.type === 'subscription')
    .reduce((s, x) => s + x.amountMinor, 0)

  // 近12个月负债 burn-down（估算：当前负债 + 回溯每月还款，随月份递增 = 还款前负债）
  const debtScheds = scheds.filter(s => s.type === 'debt' && s.repeat === 'monthly')
  const monthlyRepay = debtScheds.reduce((s, x) => s + x.amountMinor, 0)
  const debtTrend12: Array<{ month: string; debt: number }> = []
  for (let off = 11; off >= 0; off--) {
    const d = new Date(now.getFullYear(), now.getMonth() - off, 1)
    debtTrend12.push({ month: `${d.getMonth() + 1}月`, debt: yuan(Math.max(0, debtTotal + monthlyRepay * (11 - off))) })
  }

  // ===== 财务健康分（0-100 五维：预算/储蓄/负债/冲动/记录） =====
  const dimBudget = Math.max(0, 100 - Math.max(0, budgetUsedPct - 40) * 1.6)
  const dimSaving = goal && goal.targetMinor > 0 ? Math.min(100, savingsPct ?? 0) : 50
  const dimDebt = debtTotal <= 0 ? 100 : Math.max(20, 100 - Math.round(Math.log1p(debtTotal / 100) * 9))
  const dimImpulse = impulseThisCount === 0 ? 100 : Math.max(30, 100 - impulseThisCount * 9)
  const dimRecord = Math.min(100, totalCount * 3)
  const healthDims = [
    { name: '预算', score: Math.round(dimBudget) },
    { name: '储蓄', score: Math.round(dimSaving) },
    { name: '负债', score: Math.round(dimDebt) },
    { name: '冲动', score: Math.round(dimImpulse) },
    { name: '记录', score: Math.round(dimRecord) },
  ]
  const healthScore = Math.round(healthDims.reduce((s, d) => s + d.score, 0) / healthDims.length)

  return {
    month: curMk,
    monthExpense: yuan(monthExpense),
    lastMonthExpense: yuan(lastMonthExpense),
    expenseDeltaPct,
    budget: yuan(budget),
    budgetUsedPct,
    income: yuan(income),
    savings: yuan(savings),
    lastMonthSavings: yuan(lastMonthSavings),
    categoryDetail,
    topMerchants,
    savingsGoal: goal ? { name: goal.name, current: yuan(goal.currentMinor), target: yuan(goal.targetMinor), pct: savingsPct } : null,
    debtTotal: yuan(debtTotal),
    prevDebt: yuan(prevDebt),
    debtDelta: yuan(debtDelta),
    debtCount,
    impulseThisTotal: yuan(impulseThisTotal),
    impulseThisCount,
    impulseLastTotal: yuan(impulseLastTotal),
    impulseLastCount,
    totalTxCount: totalCount,
    // 图表数据
    trend12,
    recurringDeductions,
    installmentTotal: yuan(installmentTotal),
    installmentCount,
    installmentTxs,
    subscriptionMonthly: yuan(subscriptionMonthly),
    debtTrend12,
    healthScore,
    healthDims,
    // 债务-冲动联合分析
    ...creditJoint,
  }
}

// ==================== 冲动消费解读 facts ====================

export async function getImpulseFacts(): Promise<Record<string, unknown>> {
  const now = new Date()
  const mk = monthKey(now)
  const txs = await getAllTxs()
  const impulses: Transaction[] = []
  let totalCount = 0

  for (const tx of txs) {
    if (isIncome(tx) || isTransfer(tx)) continue
    if (monthKey(new Date(tx.time)) !== mk) continue
    totalCount++
    if (isImpulsive(tx.impulseLevel)) impulses.push(tx)
  }

  const total = impulses.reduce((s, tx) => s + tx.amountMinor, 0)
  const avgScore = impulses.length > 0
    ? Math.round(impulses.reduce((s, tx) => s + tx.impulseScore, 0) / impulses.length)
    : 0
  const maxImpulse = impulses.reduce<Transaction | null>((a, b) =>
    (a && a.amountMinor >= b.amountMinor) ? a : b, null)

  const slotDist = ['凌晨', '上午', '下午', '晚上', '深夜'].map(name => ({ slot: name, count: 0 }))
  const levelDist = { low: 0, medium: 0, high: 0, veryHigh: 0 }
  const merMap: Record<string, number> = {}
  const slotTxMap: Record<string, Array<{ merchant: string; amount: number; time: string; impulseScore: number }>> = {
    凌晨: [], 上午: [], 下午: [], 晚上: [], 深夜: [],
  }
  for (const tx of impulses) {
    const slot = slotOf(new Date(tx.time).getHours())
    const row = slotDist.find(x => x.slot === slot)
    if (row) row.count++
    levelDist[tx.impulseLevel]++
    merMap[tx.merchant] = (merMap[tx.merchant] || 0) + tx.amountMinor
    slotTxMap[slot].push({
      merchant: tx.merchant,
      amount: yuan(tx.amountMinor),
      time: new Date(tx.time).toTimeString().slice(0, 5),
      impulseScore: tx.impulseScore,
    })
  }
  const topMerchants = Object.entries(merMap)
    .map(([merchant, v]) => ({ merchant, amount: yuan(v) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3)

  // 平台冲动金额（横向条形图 + 环形图数据）
  const pMap: Record<string, number> = {}
  for (const tx of impulses) {
    const p = platformOf(tx.merchant) ?? '其他'
    pMap[p] = (pMap[p] || 0) + tx.amountMinor
  }
  const platformAmounts = Object.entries(pMap)
    .map(([platform, v]) => ({ platform, amount: yuan(v) }))
    .sort((a, b) => b.amount - a.amount)

  // 冲动强度分布（迷你条形图：高/中/低三档）
  const strengthDist = {
    high: (levelDist.veryHigh || 0) + (levelDist.high || 0),
    medium: levelDist.medium || 0,
    low: levelDist.low || 0,
  }

  // 近30天冲动金额（日历热力图：每天一格，颜色深浅=金额）
  const heat30 = new Array(30).fill(0).map((_, i) => {
    const d = new Date(now)
    d.setDate(d.getDate() - (29 - i))
    return { date: `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`, amount: 0 }
  })
  for (const tx of impulses) {
    const d = new Date(tx.time)
    const key = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    const cell = heat30.find(c => c.date === key)
    if (cell) cell.amount += yuan(tx.amountMinor)
  }

  // 时段下钻明细 + 最近5笔冲动记录
  const slotDetails = ['凌晨', '上午', '下午', '晚上', '深夜']
    .map(slot => ({ slot, txs: slotTxMap[slot].sort((a, b) => b.impulseScore - a.impulseScore) }))
  const recentImpulses = [...impulses]
    .sort((a, b) => (a.time < b.time ? 1 : -1))
    .slice(0, 5)
    .map(tx => {
      const d = new Date(tx.time)
      return {
        merchant: tx.merchant,
        amount: yuan(tx.amountMinor),
        time: `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
        impulseScore: tx.impulseScore,
        impulseLevel: tx.impulseLevel,
      }
    })

  return {
    month: mk,
    count: impulses.length,
    total: yuan(total),
    avgScore,
    maxImpulse: maxImpulse
      ? { merchant: maxImpulse.merchant, amount: yuan(maxImpulse.amountMinor), score: maxImpulse.impulseScore }
      : null,
    slotDist,
    levelDist,
    topMerchants,
    totalTxCount: totalCount,
    // 图表数据（前端代码计算）
    platformAmounts,
    strengthDist,
    heatmap: heat30,
    slotDetails,
    recentImpulses,
  }
}

// ==================== 预设查询 ====================

export interface QueryResult {
  intent: string
  facts: Record<string, unknown>
  /** 本地算好的答案（AI 不可用时的降级） */
  answer: string
}

/** 把用户问题匹配到可查询的数据（预设查询集） */
export async function resolveQuery(question: string): Promise<QueryResult | null> {
  const now = new Date()
  const mk = monthKey(now)
  const prevMk = monthKeyOffset(-1)
  const q = question.replace(/\s+/g, '')
  const budget = await getBudget()
  const txs = await getAllTxs()
  const debtSnapshot = await buildDebtSnapshot()
  const goal = await getGoal()

  let monthExpense = 0
  let lastMonthExpense = 0
  let monthIncome = 0
  let impulseCount = 0
  let impulseTotal = 0
  const catMap: Record<string, number> = {}
  const merMap: Record<string, number> = {}

  for (const tx of txs) {
    if (isIncome(tx)) {
      if (monthKey(new Date(tx.time)) === mk) monthIncome += tx.amountMinor
      continue
    }
    if (isTransfer(tx)) continue
    const k = monthKey(new Date(tx.time))
    if (k === mk) {
      monthExpense += tx.amountMinor
      catMap[tx.category] = (catMap[tx.category] || 0) + tx.amountMinor
      merMap[tx.merchant] = (merMap[tx.merchant] || 0) + tx.amountMinor
      if (isImpulsive(tx.impulseLevel)) {
        impulseCount++
        impulseTotal += tx.amountMinor
      }
    } else if (k === prevMk) {
      lastMonthExpense += tx.amountMinor
    }
  }

  const debtTotal = debtSnapshot.creditPrincipalMinor
  const debtCount = debtSnapshot.accounts.filter(a => a.principalRemMinor > 0).length
  const remaining = budget - monthExpense

  // 本月支出
  if (/本月支出|这个月花了|这个月支出|本月花了|花了多少|支出多少/.test(q) && /上月|上个月|昨天/.test(q) === false) {
    return {
      intent: 'monthExpense',
      facts: { monthExpense: yuan(monthExpense), budget: yuan(budget), remaining: yuan(remaining) },
      answer: `本月支出 ${fmtYuan(monthExpense)}，预算 ${fmtYuan(budget)}，剩余 ${fmtYuan(remaining)}。`,
    }
  }
  // 上月支出
  if (/上月支出|上个月花了|上个月支出/.test(q)) {
    return {
      intent: 'lastMonthExpense',
      facts: { lastMonthExpense: yuan(lastMonthExpense), thisMonthExpense: yuan(monthExpense) },
      answer: `上月支出 ${fmtYuan(lastMonthExpense)}，本月已支出 ${fmtYuan(monthExpense)}。`,
    }
  }
  // 本月收入
  if (/本月收入|这个月收入|收入多少/.test(q)) {
    return {
      intent: 'monthIncome',
      facts: { monthIncome: yuan(monthIncome), monthExpense: yuan(monthExpense) },
      answer: `本月收入 ${fmtYuan(monthIncome)}，支出 ${fmtYuan(monthExpense)}。`,
    }
  }
  // 冲动
  if (/冲动/.test(q)) {
    return {
      intent: 'impulse',
      facts: { impulseCount, impulseTotal: yuan(impulseTotal), monthExpense: yuan(monthExpense) },
      answer: `本月冲动消费 ${impulseCount} 笔，共 ${fmtYuan(impulseTotal)}。`,
    }
  }
  // 负债
  if (/负债|欠款|欠多少/.test(q)) {
    return {
      intent: 'debt',
      facts: { debtTotal: yuan(debtTotal), debtCount },
      answer: debtCount > 0
        ? `当前负债共 ${debtCount} 笔，合计 ${fmtYuan(debtTotal)}。`
        : '当前没有负债，零负债保持住！',
    }
  }
  // 储蓄
  if (/储蓄|存了|存款|进度/.test(q)) {
    const current = goal?.currentMinor ?? 0
    const target = goal?.targetMinor ?? 0
    const p = target > 0 ? Math.round((current / target) * 100) : 0
    return {
      intent: 'savings',
      facts: { goalName: goal?.name ?? '无', current: yuan(current), target: yuan(target), pct: p },
      answer: goal
        ? `储蓄目标「${goal.name}」进度 ${p}%，已存 ${fmtYuan(current)} / ${fmtYuan(target)}。`
        : '还没有储蓄目标，先去存第一笔吧。',
    }
  }
  // 预算剩余
  if (/预算|还剩|剩余/.test(q)) {
    return {
      intent: 'budget',
      facts: { budget: yuan(budget), monthExpense: yuan(monthExpense), remaining: yuan(remaining) },
      answer: `本月预算 ${fmtYuan(budget)}，已用 ${fmtYuan(monthExpense)}，剩余 ${fmtYuan(remaining)}。`,
    }
  }
  // 某分类本月总额（如"餐饮花了多少"）
  const catName = Object.keys(catMap).find(c => q.includes(c))
  if (catName) {
    const v = catMap[catName]
    return {
      intent: 'category',
      facts: { category: catName, amount: yuan(v), monthExpense: yuan(monthExpense) },
      answer: `本月「${catName}」共支出 ${fmtYuan(v)}，占本月总支出的 ${monthExpense > 0 ? Math.round((v / monthExpense) * 100) : 0}%。`,
    }
  }
  // 某平台本月总额（如"拼多多花了多少"）
  const merchantName = Object.keys(merMap).find(m => q.includes(m))
  if (merchantName) {
    const v = merMap[merchantName]
    return {
      intent: 'merchant',
      facts: { merchant: merchantName, amount: yuan(v), monthExpense: yuan(monthExpense) },
      answer: `本月在「${merchantName}」共消费 ${fmtYuan(v)}。`,
    }
  }

  return null
}

/** 分析建议：算出关键 facts，供 AI 生成建议 */
export async function getAdviceFacts(): Promise<Record<string, unknown>> {
  const now = new Date()
  const mk = monthKey(now)
  const budget = await getBudget()
  const txs = await getAllTxs()
  const debtSnapshot = await buildDebtSnapshot()
  const goal = await getGoal()

  let monthExpense = 0
  const catMap: Record<string, number> = {}
  const merMap: Record<string, number> = {}
  let impulseCount = 0
  let impulseTotal = 0
  let lateNightCount = 0

  for (const tx of txs) {
    if (isIncome(tx) || isTransfer(tx)) continue
    if (monthKey(new Date(tx.time)) !== mk) continue
    monthExpense += tx.amountMinor
    catMap[tx.category] = (catMap[tx.category] || 0) + tx.amountMinor
    merMap[tx.merchant] = (merMap[tx.merchant] || 0) + tx.amountMinor
    if (isImpulsive(tx.impulseLevel)) {
      impulseCount++
      impulseTotal += tx.amountMinor
      const h = new Date(tx.time).getHours()
      if (h >= 22 || h < 6) lateNightCount++
    }
  }

  const topCategories = Object.entries(catMap)
    .map(([category, v]) => ({ category, amount: yuan(v), pct: monthExpense > 0 ? Math.round((v / monthExpense) * 100) : 0 }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3)
  const topMerchant = Object.entries(merMap)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—'

  return {
    month: mk,
    monthExpense: yuan(monthExpense),
    budget: yuan(budget),
    remaining: yuan(budget - monthExpense),
    topCategories,
    topMerchant,
    impulseCount,
    impulseTotal: yuan(impulseTotal),
    lateNightCount,
    debtTotal: yuan(debtSnapshot.creditPrincipalMinor),
    savingsGoal: goal ? { current: yuan(goal.currentMinor), target: yuan(goal.targetMinor) } : null,
  }
}

function fmtYuan(minor: number): string {
  return '¥' + (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

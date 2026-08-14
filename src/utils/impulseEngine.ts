import { db } from '../db/database'
import { getSetting } from '../db/crud'
import type { Transaction } from '../types'
import { checkWarnings, type Warning } from './warningEngine'

export type ImpulseLevel = Transaction['impulseLevel']
// 保存前记录还没有 id，统一用"未入库交易"
export type PendingTx = Omit<Transaction, 'id'>

const BUDGET_KEY = 'monthlyBudget'
const DEFAULT_BUDGET_MINOR = 1000_00

// 购物类分类（频率/平台维度只统计这类）
export const SHOP_CATEGORIES = ['购物', '娱乐', '虚拟消费']

// ==================== 平台识别 ====================

// 平台关键词（按先后顺序匹配，更具体的放前面）
const PLATFORM_KEYWORDS: Array<[string, string]> = [
  ['淘宝闪购', '淘宝闪购'],
  ['拼多多', '拼多多'],
  ['京东', '京东'],
  ['淘宝', '淘宝'],
  ['抖音', '抖音'],
  ['美团', '美团'],
]

/** 从商家名匹配出平台关键词（无匹配返回 null） */
export function platformOf(merchant: string): string | null {
  if (!merchant) return null
  for (const [kw, name] of PLATFORM_KEYWORDS) {
    if (merchant.includes(kw)) return name
  }
  return null
}

// ==================== 上下文（统计数据，由代码从数据库算出） ====================

export interface ImpulseContext {
  /** 交易当天购物类（购物/娱乐/虚拟消费）总笔数（含本笔） */
  dayShoppingCount: number
  /** 当天购物类总金额（分，含本笔，跨平台累计） */
  dayShopTotalMinor: number
  /** 当天各平台购物类笔数（平台名→笔数，含本笔） */
  dayPlatformCounts: Record<string, number>
  /** 当天购物类记录明细（含本笔，冷静流程"账单复盘"用） */
  dayShopTxs: { merchant: string; platform: string | null; amountMinor: number; time: string }[]
  /** 近90天同分类金额中位数（分） */
  categoryMedian: number
  /** 近90天各平台购物类笔数（平台名→笔数） */
  platform90: Record<string, number>
  /** 近30天各平台购物类笔数 */
  platform30: Record<string, number>
  /** 本月预算（分，预警用） */
  monthlyBudget: number
  /** 本月已支出（分，不含本笔，预警用） */
  monthExpenseBefore: number
  /** 深夜消费二次确认（settings: nightLock=true，22:00-06:00 购物类记账二次确认） */
  nightLock: boolean
  /** 消费锁时段覆盖（settings: nightLockWindow = JSON {start, end}，如凌晨锁 0-2；为 null 用默认 22:00-06:00） */
  nightLockWindow: { start: number; end: number } | null
  /** 平台每日限额（settings: platformLimit = JSON 数组 [{platform, amountMinor}]，多平台，超限记账弹确认） */
  platformLimit: { platform: string; amountMinor: number }[]
  /** 非必要支出冻结期（settings: freezeNonEssential=true + freezeNonEssentialUntil >= 今天） */
  freezeNonEssential: boolean
  /** 同类商品提醒分类（settings: similarReminder=分类名，该类记账提醒） */
  similarReminder: string | null
  /** 明日额度覆盖（settings: dailyLimitOverride = JSON {amountMinor, date}，明日预算卡显示新额度） */
  dailyLimitOverride: { amountMinor: number; date: string } | null
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function dateKeyOf(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isIncome(tx: Transaction): boolean {
  return (tx as { txType?: string }).txType === 'income'
}

/**
 * 纯函数：基于全部历史交易构建一笔交易的冲动上下文（不含预算，预算由 prepareImpulseContext 补上）。
 * 统计口径：购物类 = 购物/娱乐/虚拟消费。
 */
export function buildImpulseContext(tx: PendingTx, allTxs: Transaction[]): ImpulseContext {
  const now = Date.now()
  const DAY = 86_400_000
  const txDay = dateKeyOf(tx.time)
  const txPlatform = platformOf(tx.merchant)
  const isShopTx = SHOP_CATEGORIES.includes(tx.category)

  // 当日口径（含本笔）：笔数 / 跨平台金额累计 / 同平台笔数 / 明细
  let dayShoppingCount = isShopTx ? 1 : 0
  let dayShopTotalMinor = isShopTx ? tx.amountMinor : 0
  const dayPlatformCounts: Record<string, number> = {}
  if (isShopTx && txPlatform) dayPlatformCounts[txPlatform] = 1
  const dayShopTxs = isShopTx
    ? [{ merchant: tx.merchant, platform: txPlatform, amountMinor: tx.amountMinor, time: tx.time }]
    : []

  const catAmounts: number[] = []
  const p90: Record<string, number> = {}
  const p30: Record<string, number> = {}

  for (const t of allTxs) {
    if (isIncome(t)) continue
    const selfId = (tx as { id?: string }).id
    if (selfId && t.id === selfId) continue
    const tTime = new Date(t.time).getTime()
    if (tTime > now) continue

    // 当日购物类：笔数 / 金额累计 / 同平台笔数 / 明细
    if (SHOP_CATEGORIES.includes(t.category) && dateKeyOf(t.time) === txDay) {
      dayShoppingCount++
      dayShopTotalMinor += t.amountMinor
      const tp = platformOf(t.merchant)
      if (tp) dayPlatformCounts[tp] = (dayPlatformCounts[tp] || 0) + 1
      dayShopTxs.push({ merchant: t.merchant, platform: tp, amountMinor: t.amountMinor, time: t.time })
    }
    // 近90天：同分类金额中位数 + 平台购物笔数
    if (now - tTime <= 90 * DAY) {
      if (t.category === tx.category) catAmounts.push(t.amountMinor)
      if (SHOP_CATEGORIES.includes(t.category)) {
        const p = platformOf(t.merchant)
        if (p) p90[p] = (p90[p] || 0) + 1
      }
    }
    // 近30天：平台购物笔数
    if (now - tTime <= 30 * DAY && SHOP_CATEGORIES.includes(t.category)) {
      const p = platformOf(t.merchant)
      if (p) p30[p] = (p30[p] || 0) + 1
    }
  }

  return {
    dayShoppingCount,
    dayShopTotalMinor,
    dayPlatformCounts,
    dayShopTxs,
    categoryMedian: median(catAmounts),
    platform90: p90,
    platform30: p30,
    monthlyBudget: 0,
    monthExpenseBefore: 0,
    nightLock: false,
    nightLockWindow: null,
    platformLimit: [],
    freezeNonEssential: false,
    similarReminder: null,
    dailyLimitOverride: null,
  }
}

/** 异步：从数据库准备完整上下文（含预算与本月已支出） */
export async function prepareImpulseContext(tx: PendingTx): Promise<ImpulseContext> {
  const allTxs = await db.transactions.toArray()
  const ctx = buildImpulseContext(tx, allTxs)

  const budgetRaw = await getSetting(BUDGET_KEY)
  ctx.monthlyBudget = typeof budgetRaw === 'number' ? budgetRaw : DEFAULT_BUDGET_MINOR

  const now = new Date()
  const mk = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  let spent = 0
  for (const t of allTxs) {
    if (isIncome(t)) continue
    const d = new Date(t.time)
    if (`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === mk) spent += t.amountMinor
  }
  ctx.monthExpenseBefore = spent

  // 行为教练设置：深夜二次确认 / 平台限额 / 非必要支出冻结期 / 同类提醒 / 明日额度覆盖
  const nightLock = await getSetting('nightLock')
  ctx.nightLock = nightLock === 'true'

  const windowRaw = await getSetting('nightLockWindow')
  if (typeof windowRaw === 'string' && windowRaw) {
    try {
      const parsed = JSON.parse(windowRaw) as { start?: unknown; end?: unknown }
      if (parsed && typeof parsed.start === 'number' && typeof parsed.end === 'number') {
        ctx.nightLockWindow = { start: parsed.start, end: parsed.end }
      }
    } catch { /* 数据损坏则忽略 */ }
  }

  // 平台每日限额：支持数组（多平台），兼容旧版单对象 {platform, amountMinor}
  const platformLimitRaw = await getSetting('platformLimit')
  if (typeof platformLimitRaw === 'string' && platformLimitRaw) {
    try {
      const parsed = JSON.parse(platformLimitRaw)
      if (Array.isArray(parsed)) {
        ctx.platformLimit = parsed.filter(
          (x): x is { platform: string; amountMinor: number } =>
            x && typeof x.platform === 'string' && typeof x.amountMinor === 'number'
        )
      } else if (parsed && typeof parsed.platform === 'string' && typeof parsed.amountMinor === 'number') {
        ctx.platformLimit = [{ platform: parsed.platform, amountMinor: parsed.amountMinor }]
      }
    } catch { /* 数据损坏则忽略 */ }
  }

  const freezeNonEssential = await getSetting('freezeNonEssential')
  const freezeUntil = await getSetting('freezeNonEssentialUntil')
  const now2 = new Date()
  const todayKey = `${now2.getFullYear()}-${String(now2.getMonth() + 1).padStart(2, '0')}-${String(now2.getDate()).padStart(2, '0')}`
  ctx.freezeNonEssential = freezeNonEssential === 'true' &&
    typeof freezeUntil === 'string' && freezeUntil.length > 0 && freezeUntil >= todayKey

  const similarReminder = await getSetting('similarReminder')
  ctx.similarReminder = typeof similarReminder === 'string' && similarReminder ? similarReminder : null

  const dailyOverrideRaw = await getSetting('dailyLimitOverride')
  if (typeof dailyOverrideRaw === 'string' && dailyOverrideRaw) {
    try {
      const parsed = JSON.parse(dailyOverrideRaw) as { amountMinor?: unknown; date?: unknown }
      if (parsed && typeof parsed.amountMinor === 'number' && typeof parsed.date === 'string') {
        ctx.dailyLimitOverride = { amountMinor: parsed.amountMinor, date: parsed.date }
      }
    } catch { /* 数据损坏则忽略 */ }
  }

  return ctx
}

// ==================== 冲动指数评分（满分 100） ====================

/**
 * 计算一笔交易的冲动指数（0-100）与等级。
 * 维度：时间(25) / 频率(20) / 金额(20) / 平台(15) / 支付方式(20)。
 * 等级：0-30 low（理智）/ 31-50 medium（轻度）/ 51-70 high（中度）/ 71-100 veryHigh（高度）。
 */
export function calculateImpulseScore(
  tx: PendingTx,
  ctx: ImpulseContext
): { score: number; level: ImpulseLevel; reasons: string[] } {
  const reasons: string[] = []
  let score = 0

  // 1. 时间维度（25）：深夜 22:00-06:00 → 25；21:00-22:00 → 15；其他 → 0
  const h = new Date(tx.time).getHours()
  if (h >= 22 || h < 6) {
    score += 25
    reasons.push('深夜购物')
  } else if (h >= 21 && h < 22) {
    score += 15
    reasons.push('晚间购物')
  }

  // 2. 频率维度（20）：同平台拆单 + 跨平台金额累计（两个子维度可叠加，封顶20分）
  let freq = 0
  const fp = platformOf(tx.merchant)
  if (fp) {
    const sameP = ctx.dayPlatformCounts[fp] || 0
    if (sameP >= 3) {
      freq += 20
      reasons.push(`${fp}当日第${sameP}笔`)
    } else if (sameP === 2) {
      freq += 10
      reasons.push(`${fp}当日第2笔`)
    }
  }
  if (ctx.dayShopTotalMinor >= 200_00) {
    freq += 20
    reasons.push('当日购物累计超¥200')
  } else if (ctx.dayShopTotalMinor >= 100_00) {
    freq += 10
    reasons.push('当日购物累计超¥100')
  }
  score += Math.min(20, freq)
  // 等级3 标记（不计分）：当日购物类累计 ≥ ¥200 → 进入冷静流程
  if (ctx.dayShopTotalMinor >= 200_00) reasons.push('当日购物累计超标')

  // 3. 金额维度（20）：超近90天同类目中位数 3 倍 → 20；2 倍 → 10
  const medianAmt = ctx.categoryMedian
  if (medianAmt > 0 && tx.amountMinor >= medianAmt) {
    const ratio = tx.amountMinor / medianAmt
    if (ratio >= 3) {
      score += 20
      reasons.push('超同类目平时3倍')
    } else if (ratio >= 2) {
      score += 10
      reasons.push('超同类目平时2倍')
    }
  }

  // 4. 平台维度（15，动态）：历史频次(8) + 近期热度(7)
  const p = platformOf(tx.merchant)
  if (p) {
    const c90 = ctx.platform90[p] || 0
    const c30 = ctx.platform30[p] || 0
    // ① 历史消费频率：近90天该平台购物笔数排名（第1名8分 / 第2名5分 / 第3名及以后2分 / 无历史0分）
    const ranks = Object.entries(ctx.platform90).sort((a, b) => b[1] - a[1])
    const idx = ranks.findIndex(([name]) => name === p)
    if (idx === 0) {
      score += 8
      reasons.push(`${p}购物频次高`)
    } else if (idx === 1) {
      score += 5
      reasons.push(`${p}购物频次高`)
    } else if (idx >= 2 && c90 > 0) {
      score += 2
    }
    // ② 近期消费热度：近30天该平台购物笔数（≥5笔7分 / 3-4笔4分 / 1-2笔2分 / 0笔0分）
    if (c30 >= 5) {
      score += 7
      reasons.push(`近30天在${p}买了${c30}次`)
    } else if (c30 >= 3) {
      score += 4
      reasons.push(`近30天在${p}买了${c30}次`)
    } else if (c30 >= 1) {
      score += 2
    }
  }

  // 5. 支付方式维度（20）：先用后付 → 20；分期 → 15；花呗/白条/月付/信用卡等负债支付 → 10；直接支付 → 0
  if (tx.paymentMethod === '拼多多先用后付' || tx.paymentMethod === '先用后付') {
    score += 20
    reasons.push('先用后付')
  } else if (tx.paymentMethod === '分期') {
    score += 15
    reasons.push('分期付款')
  } else if (tx.paymentMethod === '花呗' || tx.paymentMethod === '京东白条' || tx.paymentMethod === '抖音月付' || tx.paymentMethod === '信用卡' || tx.paymentMethod === '信用支付') {
    score += 10
    reasons.push('负债支付（借来的钱）')
  }

  score = Math.max(0, Math.min(100, score))
  const level: ImpulseLevel = score <= 30 ? 'low' : score <= 50 ? 'medium' : score <= 70 ? 'high' : 'veryHigh'
  return { score, level, reasons }
}

/** 是否为冲动消费（medium/high/veryHigh） */
export function isImpulsive(level: Transaction['impulseLevel']): boolean {
  return level === 'medium' || level === 'high' || level === 'veryHigh'
}

// ==================== 保存前统一入口 ====================

/** 冷静流程所需的上下文（账单复盘 + 心理拆解模板 + AI 深度分析 facts） */
export interface CoolingInfo {
  todayShopTxs: { merchant: string; platform: string | null; amountMinor: number; time: string }[]
  totalMinor: number
  amountMinor: number
  merchant: string
  isLateNight: boolean
  isDeferred: boolean
  platform: string | null
  budgetRemainingAfter: number
  budgetTight: boolean
  overMedianTimes: number | null
  dayShoppingCount: number
  /** 触发冷静流程的预警文案（如支付陷阱），在流程内展示 */
  coolMessages: string[]
  // ---- 以下字段供 AI 深度分析（心理拆解 + 个性化三问）----
  category: string
  paymentMethod: string
  score: number
  level: ImpulseLevel
  reasons: string[]
}

export interface GuardResult {
  score: number
  level: ImpulseLevel
  reasons: string[]
  warnings: Warning[]
  /** 需要进入冷静流程时的上下文（等级3累计 或 支付陷阱触发） */
  cooling: CoolingInfo | null
}

/**
 * 保存前统一守卫：计算冲动指数 + 检查预警。
 * 供手动记账 / OCR / 语音 / 聊天记账共用。
 */
export async function guardTransaction(tx: PendingTx): Promise<GuardResult> {
  const ctx = await prepareImpulseContext(tx)
  const { score, level, reasons } = calculateImpulseScore(tx, ctx)
  const warnings = checkWarnings(tx, ctx)

  const h = new Date(tx.time).getHours()
  const overMedianTimes = ctx.categoryMedian > 0 && tx.amountMinor >= ctx.categoryMedian
    ? Math.round((tx.amountMinor / ctx.categoryMedian) * 10) / 10
    : null
  const after = ctx.monthExpenseBefore + tx.amountMinor
  const cooling: CoolingInfo = {
    todayShopTxs: ctx.dayShopTxs,
    totalMinor: ctx.dayShopTotalMinor,
    amountMinor: tx.amountMinor,
    merchant: tx.merchant,
    isLateNight: h >= 22 || h < 6,
    isDeferred: ['拼多多先用后付', '先用后付', '分期', '花呗', '京东白条', '抖音月付', '信用卡', '信用支付'].includes(tx.paymentMethod),
    platform: platformOf(tx.merchant),
    budgetRemainingAfter: Math.max(0, ctx.monthlyBudget - after),
    budgetTight: ctx.monthlyBudget > 0 && after > ctx.monthlyBudget * 0.7,
    overMedianTimes,
    dayShoppingCount: ctx.dayShoppingCount,
    coolMessages: warnings.filter(w => w.tier === 'cool').map(w => w.message),
    category: tx.category,
    paymentMethod: tx.paymentMethod,
    score,
    level,
    reasons,
  }

  const needCooling = cooling.coolMessages.length > 0
  return { score, level, reasons, warnings, cooling: needCooling ? cooling : null }
}

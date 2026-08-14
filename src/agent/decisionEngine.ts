// ==================== 购买决策引擎（算法驱动，6 因素全实时计算） ====================
// calculatePurchaseRisk：0-100 风险分 = 时间(20) + 优惠诱导(30) + 财务压力(20)
//                                  + 重复购买(20) + 情绪消费(10) + 冲动速度(10)
// 智能冷静期：价格基准 × 风险修正 + 后悔率/负债加成
// 30 天购买反馈闭环：getPendingFeedback / submitPurchaseFeedback

import { db } from '../db/database'
import type { ConsumerEvent } from '../types'
import { platformOf } from '../utils/impulseEngine'
import { classifyCategory, nameKeywords } from './wishlistAgent'

const DAY = 86_400_000

// ==================== 商品与价格提取（本地规则，确定性） ====================

const STOPWORDS = [
  '该不该', '要不要', '想买', '买不买', '值不值', '值不值得', '值得买', '买吗', '应不应该',
  '能不能', '可以买', '看看', '帮我', '分析', '一下', '一个', '这个', '那个', '吗', '呢',
  '怎么样', '如何', '怎么办', '纠结', '有没有', '哪里', '什么', '打算', '准备', '考虑', '买', '的',
]

/** 常见商品关键词（用于把"机械键盘"规范化为"键盘"做同类匹配） */
const PRODUCT_KEYWORDS = [
  '键盘', '盲盒', '耳机', '手机', '电脑', '笔记本', '平板', '手表', '相机', '镜头',
  '球鞋', '鞋', '背包', '包', '手办', '游戏', '衣服', '外套', '裙子', '裤子',
  '面膜', '口红', '香水', '咖啡机', '吸尘器', '鼠标', '显示器', '电视', '电动牙刷', '台灯',
]

export interface ExtractedProduct {
  product: string | null
  priceMinor: number | null
  promoMentioned: boolean
}

/** 从用户消息中提取目标商品 / 价格 / 是否提到促销优惠 */
export function extractProductAndPrice(message: string): ExtractedProduct {
  const priceMinor = extractPrice(message)
  let rest = message
    .replace(/(?:¥|￥|rmb|人民币)\s*\d+(?:\.\d+)?/gi, ' ')
    .replace(/\d+(?:\.\d+)?\s*(?:元|块|块钱|rmb)/g, ' ')
  for (const w of STOPWORDS) rest = rest.replace(w, ' ')
  rest = rest.replace(/[，。！？、,.!?\s]+/g, ' ').trim()
  // 规范化：取已知商品关键词
  let product: string | null = null
  for (const kw of PRODUCT_KEYWORDS) {
    if (rest.includes(kw) || message.includes(kw)) {
      product = kw
      break
    }
  }
  if (!product && rest.length > 0) product = rest.slice(0, 6)
  const promoMentioned = /优惠|折扣|促销|活动|秒杀|满减|券|红包|降价|特价|补贴|打折/.test(message)
  return { product, priceMinor, promoMentioned }
}

function extractPrice(message: string): number | null {
  const m1 = message.match(/(?:¥|￥|rmb|人民币)\s*(\d+(?:\.\d+)?)/i)
  if (m1) return Math.round(parseFloat(m1[1]) * 100)
  const m2 = message.match(/(\d+(?:\.\d+)?)\s*(?:元|块|块钱|rmb)/i)
  if (m2) return Math.round(parseFloat(m2[1]) * 100)
  return null
}

// ==================== 同类历史匹配（180 天） ====================

export interface SimilarHistory {
  count: number
  totalMinor: number
  regretRate: number | null // 已标记后悔记录中的后悔占比
  recent: { merchant: string; amountMinor: number; time: string }[]
  sameCategoryQuality: number | null // 同分类 30 天反馈质量分均值
  sameCategoryQualityCount: number
}

/** 近 days 天同分类/同商家/同关键词的购买历史（含后悔率与质量分） */
export async function findSimilarPurchases(product: string, days = 180): Promise<SimilarHistory> {
  const txs = await db.transactions.toArray()
  const events = await db.consumerEvents.toArray()
  const now = Date.now()
  const category = classifyCategory(product)
  const kws = nameKeywords(product)

  let count = 0
  let totalMinor = 0
  let regretTrue = 0
  let regretTotal = 0
  const recent: SimilarHistory['recent'] = []
  for (const t of txs) {
    if (t.txType !== 'expense' || t.note === '储蓄转入') continue
    const ts = new Date(t.time).getTime()
    if (ts > now || now - ts > days * DAY) continue
    const sameCat = t.category === category
    const kwMatch = kws.some(k => k && (t.merchant.includes(k) || t.note.includes(k)))
    if (!sameCat && !kwMatch) continue
    count++
    totalMinor += t.amountMinor
    if (t.regretValue != null) {
      regretTotal++
      if (t.regretValue) regretTrue++
    }
    recent.push({ merchant: t.merchant, amountMinor: t.amountMinor, time: t.time })
  }
  recent.sort((a, b) => (a.time < b.time ? 1 : -1))

  // 同分类/关键词 30 天使用反馈质量分
  const matched = events.filter(e => {
    if (e.qualityScore == null) return false
    if (e.category === category) return true
    return kws.some(k => k && (e.product.includes(k) || e.category.includes(k)))
  })
  const sameCategoryQuality = matched.length > 0
    ? Math.round(matched.reduce((s, e) => s + (e.qualityScore ?? 0), 0) / matched.length)
    : null

  return {
    count,
    totalMinor,
    regretRate: regretTotal > 0 ? Math.round((regretTrue / regretTotal) * 100) : null,
    recent,
    sameCategoryQuality,
    sameCategoryQualityCount: matched.length,
  }
}

// ==================== 风险分计算 ====================

export interface RiskFactor {
  title: string
  points: number
  maxPoints: number
  detail: string
}

export interface PurchaseRiskResult {
  product: string
  priceMinor: number | null
  score: number
  factors: RiskFactor[]
  coolingHours: number
  coolingBasis: string[]
  similar: SimilarHistory
}

function yuan(minor: number): string {
  return (minor / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

/**
 * 6 因素实时计算购买风险（0-100）。全部数据从数据库实时取，不写死。
 */
export async function calculatePurchaseRisk(
  product: string,
  priceMinor: number | null,
  extras?: { promoMentioned?: boolean; consideredAgoHours?: number | null }
): Promise<PurchaseRiskResult> {
  const factors: RiskFactor[] = []
  const now = new Date()
  const h = now.getHours()

  // ---- ① 时间风险（20）：22:00-02:00 ----
  const inNightWindow = h >= 22 || h < 2
  factors.push({
    title: '时间风险',
    points: inNightWindow ? 20 : 0,
    maxPoints: 20,
    detail: inNightWindow
      ? `现在 ${String(h).padStart(2, '0')}:00，落在深夜冲动高发时段（22:00-02:00），+20`
      : `现在 ${String(h).padStart(2, '0')}:00，不在深夜时段`,
  })

  // ---- ② 优惠诱导（30）：提到促销/折扣，或促销型平台 ----
  const promo = extras?.promoMentioned ?? false
  const promoPlatform = platformOf(product) === '拼多多' || platformOf(product) === '抖音'
  const discountPoints = promo ? 30 : promoPlatform ? 15 : 0
  factors.push({
    title: '优惠诱导',
    points: discountPoints,
    maxPoints: 30,
    detail: promo
      ? '消息里提到优惠/折扣/活动等促销词，+30'
      : promoPlatform
        ? '目标在拼多多/抖音这类促销推送型平台，+15'
        : '未提及促销优惠',
  })

  // ---- ③ 财务压力（20）：金额 ÷ 可自由支配余额 ×20 ----
  const accounts = await db.accounts.toArray()
  const accountTotal = accounts.filter(a => a.type === 'asset').reduce((s, a) => s + a.balanceMinor, 0)
  const lockedSavings = accounts.filter(a => a.isLocked).reduce((s, a) => s + a.balanceMinor, 0)
  const schedules = await db.schedules.toArray()
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const futureFixed = schedules
    .filter(s => s.date >= todayKey)
    .reduce((s, x) => s + x.amountMinor, 0)
  const disposable = Math.max(1, accountTotal - futureFixed - lockedSavings)
  let financialPoints = 0
  let financialDetail = `可自由支配余额 ¥${yuan(disposable)}（账户 ¥${yuan(accountTotal)} - 未来固定支出 ¥${yuan(futureFixed)} - 已锁储蓄 ¥${yuan(lockedSavings)}）`
  if (priceMinor != null && priceMinor > 0) {
    financialPoints = Math.min(20, Math.round((priceMinor / disposable) * 20))
    financialDetail += `；目标 ¥${yuan(priceMinor)} 占其 ${Math.round((priceMinor / disposable) * 100)}%`
  } else {
    financialDetail += '；价格未提及，此项按 0 计（请追问价格）'
  }
  factors.push({ title: '财务压力', points: financialPoints, maxPoints: 20, detail: financialDetail })

  // ---- ④ 重复购买（20）：近180天同类笔数映射 ----
  const similar = await findSimilarPurchases(product, 180)
  const repeatPoints = similar.count >= 5 ? 20 : similar.count >= 4 ? 17 : similar.count >= 3 ? 14 : similar.count >= 2 ? 10 : similar.count === 1 ? 5 : 0
  factors.push({
    title: '重复购买',
    points: repeatPoints,
    maxPoints: 20,
    detail: similar.count > 0
      ? `近180天同类已买 ${similar.count} 笔、共 ¥${yuan(similar.totalMinor)}`
      : '近180天没有同类购买记录',
  })

  // ---- ⑤ 情绪消费（10）：近7天负面情绪 或 连续3晚购物 ----
  const moods = await db.moods.toArray()
  const events = await db.consumerEvents.toArray()
  const moodDays = new Set(moods
    .filter(m => ['stressed', 'bored', 'angry'].includes(m.mood) && Date.now() - new Date(m.date).getTime() <= 7 * DAY)
    .map(m => m.date))
  // 近7天连续3晚（含今晚）购物判定
  const nightDays = new Set(events
    .filter(e => {
      const eh = new Date(e.time).getHours()
      return (eh >= 22 || eh < 2) && Date.now() - new Date(e.time).getTime() <= 7 * DAY
    })
    .map(e => {
      const d = new Date(e.time)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }))
  const hasConsecutiveNights = (() => {
    let streak = 0
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() - i * DAY)
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      streak = nightDays.has(k) ? streak + 1 : 0
      if (streak >= 3) return true
    }
    return false
  })()
  const emotionPoints = moodDays.size > 0 || hasConsecutiveNights ? 10 : 0
  factors.push({
    title: '情绪消费',
    points: emotionPoints,
    maxPoints: 10,
    detail: moodDays.size > 0
      ? `近7天有 ${moodDays.size} 天负面情绪记录，+10`
      : hasConsecutiveNights
        ? '近7天连续3晚深夜购物，+10'
        : '近7天无负面情绪、无连续深夜购物',
  })

  // ---- ⑥ 冲动速度（10）：考虑→决策间隔；当天+10 / 3天+2 ----
  let speedPoints = 0
  let speedDetail = '未在欲望清单中看到该商品的考虑记录，默认按已考虑超3天计（可追问确认）'
  const wishlist = await db.wishlist.toArray()
  const kws = nameKeywords(product)
  const wishMatch = wishlist.find(w => {
    if (w.name.includes(product)) return true
    if (kws.some(k => k && w.name.includes(k))) return true
    return false
  })
  const consideredAgo = extras?.consideredAgoHours ?? null
  if (consideredAgo != null) {
    speedPoints = consideredAgo <= 24 ? 10 : consideredAgo <= 72 ? 2 : 0
    speedDetail = `从考虑购买到现在约 ${Math.round(consideredAgo / 60)} 小时`
  } else if (wishMatch) {
    const addedMs = new Date(wishMatch.addedAt).getTime()
    const agoH = (Date.now() - addedMs) / 3_600_000
    speedPoints = agoH <= 24 ? 10 : agoH <= 72 ? 2 : 0
    speedDetail = `「${wishMatch.name}」在清单中已考虑约 ${Math.round(agoH)} 小时`
  }
  factors.push({ title: '冲动速度', points: speedPoints, maxPoints: 10, detail: speedDetail })

  const score = Math.min(100, factors.reduce((s, f) => s + f.points, 0))

  // ---- 智能冷静期（动态计算） ----
  const debtTotal = await getDebtTotal()
  const { hours, basis } = computeCoolingHours(score, priceMinor, similar.regretRate, disposable, debtTotal)
  return {
    product,
    priceMinor,
    score,
    factors,
    coolingHours: hours,
    coolingBasis: basis,
    similar,
  }
}

/**
 * 智能冷静期：
 * 价格基准（<100→24h / 100-500→72h / 500-2000→7天 / >2000→14天）
 * × 风险修正（<40→0.5 / 40-70→1 / >70→2）
 * + 历史同类后悔率>50% → +24h；债务压力高（总负债>50%可支配余额）→ +24h
 */
export function computeCoolingHours(
  score: number,
  priceMinor: number | null,
  regretRate: number | null,
  disposable: number,
  debtTotal = 0
): { hours: number; basis: string[] } {
  const base = priceMinor == null ? 72
    : priceMinor < 100_00 ? 24
      : priceMinor < 500_00 ? 72
        : priceMinor < 2000_00 ? 168
          : 336
  const modifier = score < 40 ? 0.5 : score <= 70 ? 1 : 2
  let hours = Math.round(base * modifier)
  const basis: string[] = [
    priceMinor != null
      ? `价格 ¥${yuan(priceMinor)} 对应基础冷静期 ${base}h（<100→24h / 100-500→72h / 500-2000→7天 / >2000→14天）`
      : '价格未提供，按默认 72h 计算，告知价格后我会重新调整',
    `风险分 ${score} 对应修正系数 ×${modifier}（<40→0.5 / 40-70→1 / >70→2），${base}h × ${modifier} = ${hours}h`,
  ]
  if (regretRate != null && regretRate > 50) {
    hours += 24
    basis.push(`同类历史后悔率 ${regretRate}% > 50%，+24h`)
  }
  if (debtTotal > 0 && debtTotal / Math.max(1, disposable) > 0.5) {
    hours += 24
    basis.push(`总负债 ¥${yuan(debtTotal)} 超过可支配余额的 50%，+24h`)
  }
  return { hours, basis }
}

/** 负债总额（实时读取） */
export async function getDebtTotal(): Promise<number> {
  const debts = await db.debts.toArray()
  return debts.reduce((s, d) => s + d.remainingMinor, 0)
}

// ==================== 30 天购买反馈闭环 ====================

/**
 * 已满 30 天且未反馈的消费事件（供首页"待反馈"区块 / 使用频率反馈卡）。
 * 按购买时间升序（先买的先反馈），同一商品只保留最早一笔（去重）。
 */
export async function getPendingFeedback(limit = 20): Promise<ConsumerEvent[]> {
  const events = await db.consumerEvents.toArray()
  const now = Date.now()
  const pending = events
    .filter(e => e.feedbackStatus == null && e.qualityScore == null && now - new Date(e.time).getTime() >= 30 * DAY)
    .sort((a, b) => (a.time < b.time ? -1 : 1))
  // 按商品名去重，保留最早购买的那一笔
  const seen = new Set<string>()
  const unique: ConsumerEvent[] = []
  for (const e of pending) {
    const key = e.product || e.txId || e.id
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(e)
  }
  return unique.slice(0, limit)
}

/** 保存一条决策记录（购买决策引擎留档） */
export async function saveDecisionRecord(data: {
  relatedType: 'wishlist' | 'impulse' | 'transaction'
  relatedId: string
  questions: { question: string; options: string[]; answer: string | null }[]
  finalDecision: 'buy' | 'abandon' | 'delay'
}): Promise<string> {
  const { addDecisionRecord } = await import('../db/crud')
  return addDecisionRecord({ ...data, createdAt: new Date().toISOString() })
}

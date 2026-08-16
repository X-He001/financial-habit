// ==================== 消费画像与记忆系统 ====================
// 数据基础：consumer_events（每次消费事件一条）
// 画像引擎：全部统计计算（近30/90天口径），不写死任何数值
// 每次消费事件后调用 recordConsumerEvent → 实时重算画像 → 持久化

import { db } from '../db/database'
import {
  getAllConsumerEvents, addConsumerEvent, updateConsumerEvent,
  getConsumerEventByTx, saveBehaviorProfile, getBehaviorProfile,
  addInsight as addInsightRow,
} from '../db/crud'
import type {
  BehaviorProfile, ConsumerEvent, ConsumerTriggerType, Insight, Mood, Transaction, CoachNote,
} from '../types'
import { isImpulsive, platformOf } from '../utils/impulseEngine'

const DAY = 86_400_000
const PROFILE_ID = 'main'

// ==================== 本地工具 ====================

function pad2(n: number): string { return String(n).padStart(2, '0') }

export function dateKeyOf(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function isIncome(tx: Transaction): boolean { return tx.txType === 'income' }

/** 储蓄转入记录（仅记账展示，不参与消费统计） */
function isTransfer(tx: Transaction): boolean { return tx.note === '储蓄转入' }

/** 深夜判定：22:00-06:00 */
function isDeepNight(h: number): boolean { return h >= 22 || h < 6 }

/** 2 小时时段桶标签，如 22:00-24:00 */
function bucketLabel(h: number): string {
  const start = Math.floor(h / 2) * 2
  const end = Math.min(24, start + 2)
  return `${pad2(start)}:00-${pad2(end % 24)}:00`
}

const PROMO_KEYWORDS = ['优惠', '打折', '折扣', '促销', '秒杀', '满减', '补贴', '红包', '券', '限时', '特价', '降价', '活动']
const NEGATIVE_MOODS = ['stressed', 'bored', 'angry']

/**
 * 从交易数据推断消费触发类型（全部基于实时数据，规则可解释）：
 * 深夜时段 → 深夜；商家/备注含促销词 → 优惠；拼多多/抖音 → 促销推送；
 * 当天有负面情绪记录 → 情绪；当天已多笔购物 → 无聊；否则 → 其他
 */
export function inferTriggerType(
  tx: Transaction,
  moods: Mood[],
  dayShoppingCount: number
): ConsumerTriggerType {
  const h = new Date(tx.time).getHours()
  if (isDeepNight(h)) return '深夜'
  const text = `${tx.merchant}${tx.note}`
  if (PROMO_KEYWORDS.some(k => text.includes(k))) return '优惠'
  const p = platformOf(tx.merchant)
  if (p === '拼多多' || p === '抖音') return '促销推送'
  const day = dateKeyOf(tx.time)
  if (moods.some(m => m.date === day && NEGATIVE_MOODS.includes(m.mood))) return '情绪'
  if (dayShoppingCount >= 2) return '无聊'
  return '其他'
}

// ==================== 事件写入与增量回填 ====================

/** 把一笔已保存的交易记录成消费事件（幂等：同一交易只记一次） */
export async function recordConsumerEvent(tx: Transaction): Promise<ConsumerEvent | null> {
  if (isIncome(tx) || isTransfer(tx)) return null
  const existing = tx.id ? await getConsumerEventByTx(tx.id) : undefined
  if (existing) return existing

  const allTxs = await db.transactions.toArray()
  const moods = await db.moods.toArray()
  const txDay = dateKeyOf(tx.time)
  const dayShoppingCount = allTxs.filter(t =>
    !isIncome(t) && !isTransfer(t) && dateKeyOf(t.time) === txDay &&
    (t.category === '购物' || t.category === '娱乐' || t.category === '虚拟消费')).length

  const event: Omit<ConsumerEvent, 'id'> = {
    txId: tx.id,
    product: tx.merchant || '未知',
    amountMinor: tx.amountMinor,
    time: tx.time,
    platform: platformOf(tx.merchant),
    category: tx.category,
    triggerType: inferTriggerType(tx, moods, dayShoppingCount),
    riskScore: tx.impulseScore,
    isImpulse: isImpulsive(tx.impulseLevel),
    aiNotes: null,
    createdAt: new Date().toISOString(),
    qualityScore: null,
    feedbackStatus: null,
  }
  const id = await addConsumerEvent(event)
  await computeAndSaveProfile()
  return { ...event, id }
}

/** 增量回填：把已有交易（含导入/历史数据）补成消费事件，供画像统计 */
export async function syncConsumerEvents(): Promise<void> {
  const allTxs = await db.transactions.toArray()
  const events = await getAllConsumerEvents()
  const haveTxIds = new Set(events.map(e => e.txId).filter((x): x is string => !!x))
  const moods = await db.moods.toArray()
  let changed = false
  for (const tx of allTxs) {
    if (isIncome(tx) || isTransfer(tx)) continue
    if (!tx.id || haveTxIds.has(tx.id)) continue
    const dayShoppingCount = allTxs.filter(t =>
      !isIncome(t) && !isTransfer(t) && dateKeyOf(t.time) === dateKeyOf(tx.time) &&
      (t.category === '购物' || t.category === '娱乐' || t.category === '虚拟消费')).length
    const event: Omit<ConsumerEvent, 'id'> = {
      txId: tx.id,
      product: tx.merchant || '未知',
      amountMinor: tx.amountMinor,
      time: tx.time,
      platform: platformOf(tx.merchant),
      category: tx.category,
      triggerType: inferTriggerType(tx, moods, dayShoppingCount),
      riskScore: tx.impulseScore,
      isImpulse: isImpulsive(tx.impulseLevel),
      aiNotes: null,
      createdAt: new Date().toISOString(),
      qualityScore: null,
      feedbackStatus: null,
    }
    await addConsumerEvent(event)
    changed = true
  }
  if (changed) await computeAndSaveProfile()
}

// ==================== 画像统计引擎（纯统计，不写死） ====================

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0
}

/**
 * 从 consumer_events 实时重算行为画像并持久化。
 * 全部统计口径：
 * - nightRisk / discountSensitivity / impulseProbability：近30天占比
 * - repeatRisk：近30天同分类重复购买率 Σ(max(0, n_c-1))/总笔数
 * - highRiskWindows：近30天冲动时段直方图 Top2
 * - highRiskCategories：近30天冲动分类聚合 Top2
 * - delayedGratification：欲望清单已决策商品放弃率（越高等 延迟满足越强）
 * - avgPurchaseQuality：近90天已反馈质量分均值
 */
export async function computeAndSaveProfile(): Promise<BehaviorProfile> {
  const now = Date.now()
  const events = await getAllConsumerEvents()
  // 统计重算时保留认知教练存档（coachNotes 不参与统计、不被覆盖）
  const prev = await getBehaviorProfile()
  const coachNotes = prev?.coachNotes ?? []

  const inLast = (t: string, days: number) => {
    const ts = new Date(t).getTime()
    return ts <= now && now - ts <= days * DAY
  }
  const d30 = events.filter(e => inLast(e.time, 30))

  // —— 占比类 ——
  const total30 = d30.length
  const nightCount = d30.filter(e => isDeepNight(new Date(e.time).getHours())).length
  const discountCount = d30.filter(e => e.triggerType === '优惠' || e.triggerType === '促销推送').length
  const impulseCount = d30.filter(e => e.isImpulse).length

  // —— 同分类重复购买率 ——
  const catMap = new Map<string, number>()
  for (const e of d30) catMap.set(e.category, (catMap.get(e.category) ?? 0) + 1)
  const extraPurchases = [...catMap.values()].reduce((s, n) => s + Math.max(0, n - 1), 0)
  const repeatRisk = pct(extraPurchases, total30)

  // —— 冲动集中时段 Top2（时间直方图，2h 桶） ——
  const windowMap = new Map<string, number>()
  for (const e of d30) {
    if (!e.isImpulse) continue
    const label = bucketLabel(new Date(e.time).getHours())
    windowMap.set(label, (windowMap.get(label) ?? 0) + 1)
  }
  const highRiskWindows = [...windowMap.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([label]) => label)

  // —— 冲动最集中分类 Top2 ——
  const catImpulse = new Map<string, number>()
  for (const e of d30) {
    if (!e.isImpulse) continue
    catImpulse.set(e.category, (catImpulse.get(e.category) ?? 0) + 1)
  }
  const highRiskCategories = [...catImpulse.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([cat]) => cat)

  // —— 延迟满足：欲望清单已决策放弃率 ——
  const wish = await db.wishlist.toArray()
  const decided = wish.filter(w => w.status === 'confirmed' || w.status === 'abandoned')
  const abandoned = decided.filter(w => w.status === 'abandoned').length
  const delayedGratification = decided.length > 0 ? pct(abandoned, decided.length) : 50

  // —— 近90天购买质量分均值 ——
  const d90 = events.filter(e => inLast(e.time, 90) && e.qualityScore != null)
  const avgPurchaseQuality = d90.length > 0
    ? Math.round(d90.reduce((s, e) => s + (e.qualityScore ?? 0), 0) / d90.length)
    : null

  const profile: BehaviorProfile = {
    id: PROFILE_ID,
    nightRisk: pct(nightCount, total30),
    discountSensitivity: pct(discountCount, total30),
    repeatRisk,
    impulseProbability: pct(impulseCount, total30),
    delayedGratification,
    highRiskWindows,
    highRiskCategories,
    avgPurchaseQuality,
    coachNotes,
    lastUpdatedAt: new Date().toISOString(),
  }
  await saveBehaviorProfile(profile)
  return profile
}

/** 读取当前画像；无数据时先同步事件再重算 */
export async function getProfile(): Promise<BehaviorProfile> {
  const cached = await getBehaviorProfile()
  if (cached) return cached
  await syncConsumerEvents()
  return computeAndSaveProfile()
}

// ==================== 认知教练存档（越用越懂用户） ====================

function noteId(): string {
  const rnd = crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)
  return `${Date.now()}-${rnd}`
}

/** 认知教练逐次复盘存档：追加一条笔记并持久化（供下次复盘引用"上次你说…"） */
export async function addCoachNote(data: {
  type: CoachNote['type']
  tag?: string | null
  content: string
  dataRef?: string | null
}): Promise<CoachNote> {
  const profile = await getProfile()
  const note: CoachNote = {
    id: noteId(),
    ts: new Date().toISOString(),
    type: data.type,
    tag: data.tag ?? null,
    content: data.content,
    dataRef: data.dataRef ?? null,
  }
  profile.coachNotes = [...(profile.coachNotes ?? []), note].slice(-200) // 最多保留 200 条
  profile.lastUpdatedAt = note.ts
  await saveBehaviorProfile(profile)
  return note
}

// ==================== 画像上下文（喂 LLM / 供 Agent 引用） ====================

export function profileContextText(p: BehaviorProfile, eventCount30: number): string {
  const lines: string[] = []
  lines.push(`- 画像计算基准：近30天消费事件 ${eventCount30} 笔`)
  lines.push(`- 深夜消费占比：${p.nightRisk}/100${p.highRiskWindows.length > 0 ? `（近30天冲动最集中时段：${p.highRiskWindows.join('、')}）` : ''}`)
  lines.push(`- 优惠敏感度：${p.discountSensitivity}/100`)
  lines.push(`- 同分类重复购买率：${p.repeatRisk}/100`)
  lines.push(`- 冲动交易占比：${p.impulseProbability}/100`)
  lines.push(`- 延迟满足能力：${p.delayedGratification}/100（欲望清单放弃率）`)
  lines.push(p.highRiskCategories.length > 0
    ? `- 近30天冲动最集中分类：${p.highRiskCategories.join('、')}`
    : '- 冲动分类数据不足')
  lines.push(p.avgPurchaseQuality != null
    ? `- 近90天购买质量分均值：${p.avgPurchaseQuality}/100（30天使用反馈）`
    : '- 暂无30天使用反馈，无法给出购买质量分')
  // —— 历次复盘笔记（越用越懂：上次复盘说过的话） ——
  const notes = (p.coachNotes ?? []).slice(-5)
  if (notes.length > 0) {
    lines.push('—— 历次复盘存档（按时间从新到旧，开场可引用）——')
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i]
      lines.push(`- [${n.ts.slice(0, 10)} ${n.type}]${n.tag ? `（${n.tag}）` : ''} ${n.content}${n.dataRef ? `（数据：${n.dataRef}）` : ''}`)
    }
  }
  return lines.join('\n')
}

/** 生成画像文本快照（供 Agent 上下文注入） */
export async function buildProfileContext(): Promise<string> {
  const p = await getProfile()
  const d30 = (await getAllConsumerEvents()).filter(e => Date.now() - new Date(e.time).getTime() <= 30 * DAY).length
  return profileContextText(p, d30)
}

// ==================== 洞察（AI 主动找你 / 洞察卡） ====================

/** 新增一条洞察（自动去重：同 sourceKey 只存一条） */
export async function addInsight(data: {
  type: Insight['type']
  content: string
  evidence: string
  relatedCategory?: string | null
  sourceKey?: string | null
}): Promise<string | null> {
  if (data.sourceKey) {
    const existing = await db.insights.where('sourceKey').equals(data.sourceKey).first()
    if (existing) return existing.id
  }
  return addInsightRow({
    type: data.type,
    content: data.content,
    evidence: data.evidence,
    relatedCategory: data.relatedCategory ?? null,
    createdAt: new Date().toISOString(),
    acknowledged: false,
    sourceKey: data.sourceKey ?? null,
  })
}

/** 未读洞察列表（按时间倒序） */
export async function getUnreadInsights(): Promise<Insight[]> {
  const list = await db.insights.filter(i => !i.acknowledged).toArray()
  return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

/** 30 天反馈：更新消费事件质量分并重算画像（供决策引擎后续引用） */
export async function submitPurchaseFeedback(eventId: string, usage: '经常' | '偶尔' | '不用'): Promise<void> {
  const score = usage === '经常' ? 90 : usage === '偶尔' ? 50 : 20
  await updateConsumerEvent(eventId, { qualityScore: score, feedbackStatus: 'done' })
  await computeAndSaveProfile()
}

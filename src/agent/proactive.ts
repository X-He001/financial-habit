// ==================== AI 主动找你（实时数据触发） ====================
// 全部由本地代码实时计算触发条件，不依赖模板：
// 1. 连续3晚购物 → 主动提醒（引用笔数/金额）
// 2. 储蓄达标 → "本月存¥X，较目标提前Y天"
// 3. 债务下降 → "负债连续下降，现金流改善"（引用降幅）
// 4. 新洞察 → 洞察卡
// 5. 购买满30天 → 使用频率反馈（30天反馈闭环入口）

import { db } from '../db/database'
import { getSetting, getAllSavingsGoals } from '../db/crud'
import {
  syncConsumerEvents, addInsight, getUnreadInsights, submitPurchaseFeedback,
} from './profile'
import { getPendingFeedback } from './decisionEngine'
import type { ConsumerEvent, Insight } from '../types'

const DAY = 86_400_000

export interface ProactiveAlert {
  id: string
  kind: 'insight' | 'feedback'
  icon: string
  title: string
  message: string
  evidence: string
  insightId?: string
  eventId?: string
  product?: string
}

function pad2(n: number): string { return String(n).padStart(2, '0') }

function dateKey(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }

function isDeepNight(iso: string): boolean {
  const h = new Date(iso).getHours()
  return h >= 22 || h < 2
}

// ==================== 触发条件生成（幂等：同 sourceKey 只生成一次洞察） ====================

/** 连续3晚购物（引用具体笔数/金额） */
async function checkThreeNights(): Promise<void> {
  const events = await db.consumerEvents.toArray()
  const now = Date.now()
  const recent = events.filter(e => now - new Date(e.time).getTime() <= 3 * DAY)

  // 统计最近3个自然日的深夜购物（含今晚）
  const nightByDay: Record<string, ConsumerEvent[]> = {}
  for (const e of recent) {
    if (!isDeepNight(e.time)) continue
    const k = dateKey(new Date(e.time))
    ;(nightByDay[k] ??= []).push(e)
  }
  // 检查今天/昨天/前天连续3天都有深夜购物
  const days: string[] = []
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.now() - i * DAY)
    days.push(dateKey(d))
  }
  const isConsecutive = days.every(k => (nightByDay[k]?.length ?? 0) > 0)
  if (!isConsecutive) return

  const all = days.flatMap(k => nightByDay[k] ?? [])
  const count = all.length
  const totalMinor = all.reduce((s, e) => s + e.amountMinor, 0)
  const key = `3nights_${dateKey(new Date())}`
  await addInsight({
    type: 'warning',
    content: `连续3晚深夜购物（${days[2]}、${days[1]}、${days[0]}），与你画像中的高冲动模式高度吻合`,
    evidence: `近3晚共 ${count} 笔、¥${(totalMinor / 100).toFixed(0)}，其中 ${all.filter(e => e.isImpulse).length} 笔为冲动`,
    relatedCategory: null,
    sourceKey: key,
  })
}

/** 储蓄达标（Y 天代码实时算） */
async function checkSavingsGoal(): Promise<void> {
  const goals = await getAllSavingsGoals()
  const active = goals.find(g => g.isActive) ?? goals[0] ?? null
  if (!active || active.currentMinor < active.targetMinor) return
  const mk = `${new Date().getFullYear()}-${pad2(new Date().getMonth() + 1)}`
  const key = `savings_${mk}`
  if (await db.insights.where('sourceKey').equals(key).first()) return

  // 本月存入金额（储蓄转入合计）
  const txs = await db.transactions.toArray()
  const savedThisMonth = txs
    .filter(t => t.note === '储蓄转入' && t.time.startsWith(mk))
    .reduce((s, t) => s + t.amountMinor, 0)
  // 提前天数：距 deadline 还剩多少天
  let aheadDays: number | null = null
  if (active.deadline) {
    aheadDays = Math.max(0, Math.ceil((new Date(active.deadline).getTime() - Date.now()) / DAY))
  }
  const savedYuan = (savedThisMonth / 100).toFixed(0)
  await addInsight({
    type: 'praise',
    content: `储蓄目标「${active.name}」已达标！当前 ¥${(active.currentMinor / 100).toFixed(0)} / ¥${(active.targetMinor / 100).toFixed(0)}`,
    evidence: aheadDays != null
      ? `本月存入 ¥${savedYuan}，较目标日提前 ${aheadDays} 天达成`
      : `本月存入 ¥${savedYuan}`,
    relatedCategory: null,
    sourceKey: key,
  })
}

/** 债务下降（对比上月总负债，引用降幅） */
async function checkDebtDown(): Promise<void> {
  const debts = await db.debts.toArray()
  const total = debts.reduce((s, d) => s + d.remainingMinor, 0)
  const now = new Date()
  const mk = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`
  const key = `debt_${mk}`
  if (await db.insights.where('sourceKey').equals(key).first()) return

  // 上月总负债记录（首次无记录则存本月基线）
  const prevKey = 'debtTotal_' + `${now.getFullYear()}-${pad2(now.getMonth())}` // 上个月
  const prevRaw = await getSetting(prevKey)
  await db.settings.put({ id: 'debtTotal_' + mk, value: total })
  if (typeof prevRaw !== 'number' || prevRaw <= 0) return

  const dropped = prevRaw - total
  if (dropped <= 0) return
  const pct = prevRaw > 0 ? Math.round((dropped / prevRaw) * 100) : 0
  await addInsight({
    type: 'praise',
    content: `总负债下降 ¥${(dropped / 100).toFixed(0)}（¥${(prevRaw / 100).toFixed(0)} → ¥${(total / 100).toFixed(0)}），现金流改善`,
    evidence: `环比上月下降 ${pct}%`,
    relatedCategory: null,
    sourceKey: key,
  })
}

/** 画像规律洞察（高风险时段/分类，数据驱动） */
async function checkProfilePattern(): Promise<void> {
  const profile = await db.behaviorProfiles.get('main')
  if (!profile) return
  if (profile.highRiskWindows.length > 0) {
    const key = `windows_${profile.lastUpdatedAt.slice(0, 10)}`
    await addInsight({
      type: 'pattern',
      content: `你的冲动集中在 ${profile.highRiskWindows.join('、')} 时段`,
      evidence: `近30天冲动消费占比最高时段，命中高风险分类 ${profile.highRiskCategories.join('、') || '暂无明显分类'}`,
      relatedCategory: profile.highRiskCategories[0] ?? null,
      sourceKey: key,
    })
  }
}

// ==================== 汇总入口 ====================

/** 生成触发型洞察 + 返回当前待展示的提醒（未读洞察 + 30天反馈） */
export async function checkProactiveAlerts(): Promise<ProactiveAlert[]> {
  await syncConsumerEvents()

  // 触发条件（幂等）
  await Promise.all([
    checkThreeNights(),
    checkSavingsGoal(),
    checkDebtDown(),
    checkProfilePattern(),
  ])

  const alerts: ProactiveAlert[] = []

  // 未读洞察 → 洞察卡
  const insights: Insight[] = await getUnreadInsights()
  for (const ins of insights) {
    const icon = ins.type === 'praise' ? '🎉' : ins.type === 'warning' ? '⚠️' : '🧠'
    alerts.push({
      id: `insight_${ins.id}`,
      kind: 'insight',
      icon,
      title: ins.type === 'praise' ? '值得庆祝' : ins.type === 'warning' ? '提醒一下' : '发现一个规律',
      message: ins.content,
      evidence: ins.evidence,
      insightId: ins.id,
    })
  }

  // 购买满30天 → 使用频率反馈
  const pending = await getPendingFeedback(5)
  for (const e of pending) {
    alerts.push({
      id: `feedback_${e.id}`,
      kind: 'feedback',
      icon: '🕐',
      title: '30天使用回访',
      message: `「${e.product}」（¥${(e.amountMinor / 100).toFixed(0)}，${new Date(e.time).getMonth() + 1}月${new Date(e.time).getDate()}日）已买满30天，用上了吗？`,
      evidence: '反馈后将更新你的购买质量分（经常90/偶尔50/不用20），后续同类购买决策会参考它',
      eventId: e.id,
      product: e.product,
    })
  }

  return alerts
}

export { submitPurchaseFeedback }

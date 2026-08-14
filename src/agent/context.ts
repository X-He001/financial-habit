import { db } from '../db/database'
import type { Transaction } from '../types'
import { platformOf, isImpulsive } from '../utils/impulseEngine'
import { commitmentProgress } from '../utils/commitmentEngine'
import { computeMoodStats, recentMoodDistribution, moodLabel } from '../utils/moodEngine'
import type { ReviewMetrics } from './metrics'

// ==================== 本地工具 ====================

function pad2(n: number): string { return String(n).padStart(2, '0') }

function isIncome(tx: Transaction): boolean { return tx.txType === 'income' }
function isTransfer(tx: Transaction): boolean { return tx.note === '储蓄转入' }

function fmtYuan(minor: number): string {
  return (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtYuan1(minor: number): string {
  return (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })
}

function timeLabel(iso: string): string {
  const d = new Date(iso)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 近30天同平台同分类统计（证明"老毛病"） */
async function sameSceneStats(tx: Transaction, days = 30): Promise<{ count: number; totalMinor: number }> {
  const now = Date.now()
  const all = await db.transactions.toArray()
  const platform = platformOf(tx.merchant)
  const sceneTag = (new Date(tx.time).getHours() >= 22 || new Date(tx.time).getHours() < 6) ? '深夜' : '白天'
  let count = 0
  let totalMinor = 0
  for (const t of all) {
    if (isIncome(t) || isTransfer(t)) continue
    const ts = new Date(t.time).getTime()
    if (ts > now || now - ts > days * 86_400_000) continue
    if (t.category !== tx.category) continue
    if (platform && platformOf(t.merchant) !== platform) continue
    const h = new Date(t.time).getHours()
    if (((h >= 22 || h < 6) ? '深夜' : '白天') !== sceneTag) continue
    count++
    totalMinor += t.amountMinor
  }
  return { count, totalMinor }
}

// ==================== ① buildContext：数据快照（喂 LLM） ====================

/**
 * 把数据库汇总成一段结构化文本快照，逼 LLM 引用真实数据说话。
 * 每段带标签，数字全部由本地代码算出；LLM 只能引用、禁止编造。
 */
export async function buildContext(tx: Transaction, m: ReviewMetrics): Promise<string> {
  const all = await db.transactions.toArray()
  const now = new Date()

  // 近30天总览
  let d30Expense = 0
  let d30ImpulseCount = 0
  let d30ImpulseMinor = 0
  for (const t of all) {
    if (isIncome(t) || isTransfer(t)) continue
    const ts = new Date(t.time).getTime()
    if (ts > Date.now() || Date.now() - ts > 30 * 86_400_000) continue
    d30Expense += t.amountMinor
    if (isImpulsive(t.impulseLevel)) {
      d30ImpulseCount++
      d30ImpulseMinor += t.amountMinor
    }
  }

  // 同场景历史
  const scene = await sameSceneStats(tx)

  // 储蓄进度
  const goal = await db.savingsGoals.toArray().then(list => list.find(g => g.isActive) ?? list[0] ?? null)
  const savingsLine = goal
    ? `当前 ¥${fmtYuan(goal.currentMinor)} / 目标 ¥${fmtYuan(goal.targetMinor)}（${Math.round((goal.currentMinor / Math.max(1, goal.targetMinor)) * 100)}%）`
    : '未设置储蓄目标'

  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const remaining = m.budgetMinor - m.monthExpenseMinor
  const perDay = Math.max(0, Math.round(remaining / Math.max(1, daysInMonth - now.getDate()) / 100))

  const lines: string[] = []
  lines.push('【这笔交易】')
  lines.push(
    `金额：¥${fmtYuan(tx.amountMinor)} ｜ 分类：${tx.category} ｜ 商家：${tx.merchant} ｜ 支付：${tx.paymentMethod} ｜ 时间：${timeLabel(tx.time)}`
  )
  lines.push(`冲动指数：${tx.impulseScore} 分（${tx.impulseLevel}）`)

  lines.push('')
  lines.push('【实时指标】')
  lines.push(`- 冲动强度：${m.impulseStrength}/100`)
  lines.push(`- 预算压力：今日支出 ¥${fmtYuan1(m.todayExpenseMinor)} ÷ 日均预算 ¥${fmtYuan1(m.dailyAvgBudgetMinor)} = ${m.budgetPressure}${m.budgetPressure > 1 ? '（已超日均）' : ''}`)
  lines.push(m.savingDamage != null
    ? `- 储蓄伤害：这笔占本月储蓄目标 ¥${fmtYuan1(m.monthSavingsTargetMinor ?? 0)} 的 ${m.savingDamage}%`
    : '- 储蓄伤害：未设置储蓄目标，无法评估')
  lines.push(`- 历史重复率：近30天同场景（时段+平台+分类）已出现 ${m.repeatRate} 次，累计 ¥${fmtYuan1(m.repeatMinor)}`)
  lines.push(`- 触发场景：${m.triggerScene}（${m.sceneLabel}）`)
  lines.push(m.coolingResistance != null
    ? `- 冷静期抵抗：同类商品放进欲望清单后放弃率 ${m.coolingResistance}%（样本 ${m.coolingSample} 件）`
    : '- 冷静期抵抗：暂无同类冷静记录')
  lines.push(`- 时段脆弱度：${m.slotWindowLabel} 占近30天冲动 ${m.timeFragility}%${m.highRiskSlot ? '（高频冲动窗口）' : ''}`)

  lines.push('')
  lines.push('【本月总览】')
  lines.push(`预算 ¥${fmtYuan1(m.budgetMinor)} ｜ 已花 ¥${fmtYuan1(m.monthExpenseMinor)} ｜ 剩余 ¥${fmtYuan1(Math.max(0, remaining))} ｜ 日均预算 ¥${fmtYuan1(m.dailyAvgBudgetMinor)} ｜ 接下来每天约可花 ¥${perDay}`)

  lines.push('')
  lines.push('【近30天】')
  lines.push(`总支出 ¥${fmtYuan1(d30Expense)} ｜ 冲动 ${d30ImpulseCount} 笔共 ¥${fmtYuan1(d30ImpulseMinor)}`)

  lines.push('')
  lines.push('【同场景历史】')
  lines.push(`近30天「${m.triggerScene}」：${scene.count} 笔，共 ¥${fmtYuan1(scene.totalMinor)}`)

  lines.push('')
  lines.push('【欲望清单】')
  lines.push(m.coolingResistance != null
    ? `同分类放弃率 ${m.coolingResistance}%（样本 ${m.coolingSample} 件）`
    : '暂无同分类冷静记录')

  lines.push('')
  lines.push('【负债】')
  lines.push(m.debtTotalMinor > 0
    ? `总负债 ¥${fmtYuan1(m.debtTotalMinor)}（负债较高时语气更温和，但建议更果断）`
    : '无负债')

  lines.push('')
  lines.push('【储蓄】')
  lines.push(savingsLine)

  // ===== 扩展：净资产 / 承诺 / 情绪 / 历史账单（六项新能力） =====

  // 净资产：最近两次快照及变化值
  const snaps = await db.balanceSnapshots.toArray()
  snaps.sort((a, b) => (a.date < b.date ? -1 : 1))
  const netWorthOf = (s: { cashMinor: number; bankMinor: number; wechatMinor: number; alipayMinor: number; otherMinor: number; liabilityMinor: number }) =>
    s.cashMinor + s.bankMinor + s.wechatMinor + s.alipayMinor + s.otherMinor - s.liabilityMinor
  if (snaps.length > 0) {
    const latest = snaps[snaps.length - 1]
    const prev = snaps.length > 1 ? snaps[snaps.length - 2] : null
    const latestWorth = netWorthOf(latest)
    const delta = prev ? latestWorth - netWorthOf(prev) : null
    lines.push('')
    lines.push('【净资产】')
    lines.push(`最近快照（${latest.date}）：净资产 ¥${fmtYuan(latestWorth)}${delta != null ? `，比上一快照（${prev!.date}）${delta >= 0 ? '+' : ''}¥${fmtYuan1(delta)}` : ''}`)
  }

  // 承诺：进行中数量 + 进度
  const commits = await db.commitments.toArray()
  const active = commits.filter(c => c.status === 'active')
  if (active.length > 0) {
    lines.push('')
    lines.push('【自我承诺】')
    for (const c of active.slice(0, 3)) {
      const p = await commitmentProgress(c)
      lines.push(`「${c.text}」截止 ${c.deadline}：已用 ${p.pct}%${p.pct > 100 ? '（超支）' : ''}，剩余 ${p.daysLeft} 天${c.penaltyMinor > 0 ? `，违约罚金 ¥${fmtYuan1(c.penaltyMinor)}` : ''}`)
    }
  }

  // 情绪：近7天分布 + 各情绪日均消费差
  const moods = await db.moods.toArray()
  if (moods.length > 0) {
    const dist = recentMoodDistribution(moods, 7)
    const distLine = Object.entries(dist).map(([k, n]) => `${moodLabel(k)}${n}天`).join('、')
    const stats = computeMoodStats(moods, all)
    const sc = stats.stressedVsCalm
    lines.push('')
    lines.push('【情绪】')
    lines.push(sc
      ? `近7天分布：${distLine}；压力大的日子日均消费 ¥${fmtYuan1(sc.stressedAvgMinor)}，比平静日${sc.diffPct >= 0 ? '高' : '低'} ${Math.abs(sc.diffPct)}%`
      : `近7天分布：${distLine}；情绪记录还不够，暂无法对比消费差异`)
  }

  // 历史账单导入
  const importedCount = all.filter(t => t.source === 'import').length
  if (importedCount > 0) {
    lines.push('')
    lines.push('【历史账单导入】')
    lines.push(`共导入 ${importedCount} 笔历史账单（已按交易单号去重）`)
  }

  return lines.join('\n')
}

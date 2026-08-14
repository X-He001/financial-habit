// ==================== Agent: 财富增长（growth） ====================

import { db } from '../../db/database'
import { getAllSavingsGoals } from '../../db/crud'
import type { Agent, AgentContext } from './types'
import { fmtYuan } from './shared'

const DAY = 86_400_000

const systemPrompt = `你是一个长期财富规划师，关注净资产/财务健康/财富增长。
规则：
- 你收到的【增长快照】含净资产变化/储蓄进度/负债/月度盈余等真实数字，回答必须引用
- 给出的增长建议要落到"下个月/未来90天可执行的具体动作"，禁止泛泛而谈
- 不承诺收益，不推销投资品
- 回答使用块标记格式（[stat]/[insight]/[tip]/[progress]/[text]/[conclusion]），数字禁止编造`

async function computeContext(): Promise<AgentContext> {
  const snaps = await db.balanceSnapshots.toArray()
  snaps.sort((a, b) => (a.date < b.date ? -1 : 1) || (a.createdAt < b.createdAt ? -1 : 1))
  const netWorthOf = (s: { cashMinor: number; bankMinor: number; wechatMinor: number; alipayMinor: number; otherMinor: number; liabilityMinor: number }) =>
    s.cashMinor + s.bankMinor + s.wechatMinor + s.alipayMinor + s.otherMinor - s.liabilityMinor
  const latest = snaps.length > 0 ? snaps[snaps.length - 1] : null
  const prev = snaps.length > 1 ? snaps[snaps.length - 2] : null
  const latestWorth = latest ? netWorthOf(latest) : null
  const delta = latest && prev ? latestWorth! - netWorthOf(prev) : null

  const goals = await getAllSavingsGoals()
  const active = goals.find(g => g.isActive) ?? goals[0] ?? null

  const debts = await db.debts.toArray()
  const debtTotal = debts.reduce((s, d) => s + d.remainingMinor, 0)

  const txs = await db.transactions.toArray()
  const now = Date.now()
  let income30 = 0
  let expense30 = 0
  for (const t of txs) {
    if (now - new Date(t.time).getTime() > 30 * DAY) continue
    if (t.txType === 'income') income30 += t.amountMinor
    else if (t.note !== '储蓄转入') expense30 += t.amountMinor
  }
  const surplus30 = income30 - expense30

  const lines: string[] = []
  if (latestWorth != null) {
    lines.push(`- 最近净资产快照（${latest!.date}）：¥${fmtYuan(latestWorth)}${delta != null ? `，较上一快照 ${delta >= 0 ? '+' : ''}¥${fmtYuan(delta)}` : ''}`)
  } else {
    lines.push('- 暂无净资产快照，建议到净资产页记录一次')
  }
  if (active) {
    const pct = active.targetMinor > 0 ? Math.round((active.currentMinor / active.targetMinor) * 100) : 0
    lines.push(`- 储蓄目标「${active.name}」：¥${fmtYuan(active.currentMinor)} / ¥${fmtYuan(active.targetMinor)}（${pct}%）`)
  } else {
    lines.push('- 暂无储蓄目标')
  }
  lines.push(`- 总负债：¥${fmtYuan(debtTotal)}`)
  lines.push(`- 近30天盈余（收入-支出）：¥${fmtYuan(surplus30)}${surplus30 < 0 ? '（入不敷出，需优先压缩支出）' : ''}`)

  return {
    domain: 'growth',
    title: '财富增长快照',
    text: lines.join('\n'),
    data: {
      netWorthMinor: latestWorth,
      netWorthDeltaMinor: delta,
      savingsGoal: active,
      debtTotalMinor: debtTotal,
      surplus30Minor: surplus30,
    },
  }
}

export const growthAgent: Agent = {
  id: 'growth',
  name: '财富增长',
  description: '净资产、财务健康度、长期财富增长规划',
  systemPrompt,
  computeContext,
}

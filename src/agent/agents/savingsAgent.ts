// ==================== Agent: 储蓄规划（savings） ====================

import { db } from '../../db/database'
import { getAllSavingsGoals } from '../../db/crud'
import type { Agent, AgentContext } from './types'
import { getMonthOverview, isExpense, fmtYuan } from './shared'

const DAY = 86_400_000

const systemPrompt = `你是一个储蓄规划顾问，帮助用户达成储蓄目标。
规则：
- 你收到的【储蓄快照】含目标进度/剩余天数/可省潜力（冲动金额）等真实数字，回答必须引用
- 给出的每月应存金额、可压缩支出建议必须基于数据计算，禁止无数据依据的通用话术
- 回答使用块标记格式（[stat]/[insight]/[tip]/[progress]/[text]/[conclusion]），数字禁止编造`

async function computeContext(): Promise<AgentContext> {
  const goals = await getAllSavingsGoals()
  const active = goals.find(g => g.isActive) ?? goals[0] ?? null
  const mo = await getMonthOverview()

  const txs = await db.transactions.toArray()
  const now = Date.now()
  let impulse30 = 0
  let savedThisMonth = 0
  const mk = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
  for (const t of txs) {
    if (now - new Date(t.time).getTime() > 30 * DAY) continue
    if (t.note === '储蓄转入' && t.time.startsWith(mk)) savedThisMonth += t.amountMinor
    if (isExpense(t) && (t.impulseLevel === 'medium' || t.impulseLevel === 'high' || t.impulseLevel === 'veryHigh')) {
      impulse30 += t.amountMinor
    }
  }

  const lines: string[] = []
  if (active) {
    const pct = active.targetMinor > 0 ? Math.round((active.currentMinor / active.targetMinor) * 100) : 0
    const left = Math.max(0, active.targetMinor - active.currentMinor)
    let daysLeft: number | null = null
    if (active.deadline) daysLeft = Math.max(0, Math.ceil((new Date(active.deadline).getTime() - Date.now()) / DAY))
    lines.push(`- 当前目标「${active.name}」：¥${fmtYuan(active.currentMinor)} / ¥${fmtYuan(active.targetMinor)}（${pct}%），还差 ¥${fmtYuan(left)}`)
    if (daysLeft != null && daysLeft > 0) {
      lines.push(`- 距截止日 ${daysLeft} 天，若要按时达标，每月需存约 ¥${fmtYuan(Math.max(0, left / Math.max(1, Math.ceil(daysLeft / 30))))}`)
    }
    lines.push(`- 本月已存：¥${fmtYuan(savedThisMonth)}（储蓄转入合计）`)
  } else {
    lines.push('- 还没有储蓄目标，请先创建')
  }
  lines.push(`- 近30天冲动消费合计 ¥${fmtYuan(impulse30)}（若拦截一半即可多存 ¥${fmtYuan(Math.round(impulse30 / 2))}）`)
  lines.push(`- 本月预算使用率：${mo.budgetMinor > 0 ? Math.round((mo.spentMinor / mo.budgetMinor) * 100) : 0}%`)

  return {
    domain: 'savings',
    title: '储蓄快照',
    text: lines.join('\n'),
    data: {
      activeGoal: active,
      impulse30Minor: impulse30,
      monthOverview: mo,
    },
  }
}

export const savingsAgent: Agent = {
  id: 'savings',
  name: '储蓄规划',
  description: '储蓄目标、攒钱方法、每月应存金额',
  systemPrompt,
  computeContext,
}

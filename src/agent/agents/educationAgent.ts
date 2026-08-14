// ==================== Agent: 财商教育（education） ====================

import { db } from '../../db/database'
import { getMonthOverview, fmtYuan } from './shared'
import type { Agent, AgentContext } from './types'

const DAY = 86_400_000

const systemPrompt = `你是一个财商老师，用大白话讲解理财概念。
规则：
- 你收到的【教育快照】里有用户自己的真实数据（收入/支出/负债/冲动占比），讲解概念时必须用用户自己的数字举例，禁止抽象空谈
- 先回答概念，再用"你的数据"做一段针对性计算示例
- 不制造焦虑，不推销
- 回答使用块标记格式（[stat]/[insight]/[tip]/[text]/[conclusion]），数字禁止编造`

async function computeContext(): Promise<AgentContext> {
  const mo = await getMonthOverview()
  const debts = await db.debts.toArray()
  const txs = await db.transactions.toArray()
  const now = Date.now()
  let income30 = 0
  let expense30 = 0
  let impulse30 = 0
  for (const t of txs) {
    if (now - new Date(t.time).getTime() > 30 * DAY) continue
    if (t.txType === 'income') income30 += t.amountMinor
    else if (t.note !== '储蓄转入') {
      expense30 += t.amountMinor
      if (t.impulseLevel === 'medium' || t.impulseLevel === 'high' || t.impulseLevel === 'veryHigh') impulse30 += t.amountMinor
    }
  }
  const debtTotal = debts.reduce((s, d) => s + d.remainingMinor, 0)

  const lines: string[] = []
  lines.push(`- 近30天：收入 ¥${fmtYuan(income30)}，支出 ¥${fmtYuan(expense30)}，储蓄率（结余/收入）约 ${income30 > 0 ? Math.round(((income30 - expense30) / income30) * 100) : 0}%`)
  lines.push(`- 冲动消费占支出比：${expense30 > 0 ? Math.round((impulse30 / expense30) * 100) : 0}%（¥${fmtYuan(impulse30)} / ¥${fmtYuan(expense30)}）`)
  lines.push(`- 总负债 ¥${fmtYuan(debtTotal)}，最高利率 ${debts.length > 0 ? Math.max(...debts.map(d => d.aprXirr)) : 0}%/年`)
  lines.push(`- 本月预算使用率：${mo.budgetMinor > 0 ? Math.round((mo.spentMinor / mo.budgetMinor) * 100) : 0}%`)

  return {
    domain: 'education',
    title: '教育快照（用户自身数据）',
    text: lines.join('\n'),
    data: { income30Minor: income30, expense30Minor: expense30, impulse30Minor: impulse30, debtTotalMinor: debtTotal, monthOverview: mo },
  }
}

export const educationAgent: Agent = {
  id: 'education',
  name: '财商教育',
  description: '讲解理财概念（分期利息/复利/预算等），用你自己的数据举例',
  systemPrompt,
  computeContext,
}

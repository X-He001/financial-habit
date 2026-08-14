// ==================== Agent: 消费财务（finance） ====================

import { db } from '../../db/database'
import { platformOf } from '../../utils/impulseEngine'
import type { Agent, AgentContext } from './types'
import {
  getMonthOverview, getRecentTx, getCategoryBreakdown, isExpense, monthKey,
  fmtYuan, yuan,
} from './shared'

const systemPrompt = `你是一个个人财务 Agent，专注回答消费/预算/收支/平台消费等财务问题。
规则：
- 你可以使用提供的工具查询和操作数据（预算、分类、平台、日支出、冲动统计、报告等）
- 你的系统提示里已注入本领域实时数据快照【消费财务快照】，回答必须引用其中的真实数字；需要额外数据时再调用工具
- 每个问题、每句分析必须根据用户实时数据动态生成；禁止固定话术、固定模板
- 用户要求记账/存钱/添加清单/撤销时，调用对应操作工具，以工具返回为准，成功才说成功
- 回答使用块标记格式（[stat]/[insight]/[tip]/[progress]/[bars]/[text]/[conclusion]），数字禁止编造`

async function computeContext(): Promise<AgentContext> {
  const [mo, recent, cats] = await Promise.all([getMonthOverview(), getRecentTx(6), getCategoryBreakdown(30)])

  const txs = await db.transactions.toArray()
  const mk = monthKey(new Date())
  const platMap = new Map<string, { amount: number; count: number }>()
  for (const t of txs) {
    if (!isExpense(t) || monthKey(new Date(t.time)) !== mk) continue
    const p = platformOf(t.merchant)
    if (!p) continue
    const row = platMap.get(p) ?? { amount: 0, count: 0 }
    row.amount += t.amountMinor
    row.count++
    platMap.set(p, row)
  }
  const platforms = [...platMap.entries()]
    .map(([platform, e]) => ({ platform, amountYuan: yuan(e.amount), count: e.count }))
    .sort((a, b) => b.amountYuan - a.amountYuan)
    .slice(0, 4)

  const lines: string[] = []
  lines.push(`- 本月预算 ¥${fmtYuan(mo.budgetMinor)}，已支出 ¥${fmtYuan(mo.spentMinor)}，剩余 ¥${fmtYuan(Math.max(0, mo.remainingMinor))}（使用率 ${mo.budgetMinor > 0 ? Math.round((mo.spentMinor / mo.budgetMinor) * 100) : 0}%）`)
  lines.push(`- 本月收入 ¥${fmtYuan(mo.incomeMinor)}；接下来每天约可花 ¥${fmtYuan(mo.perDayMinor)}`)
  lines.push(`- 本月冲动消费 ${mo.impulseCount} 笔，共 ¥${fmtYuan(mo.impulseMinor)}`)
  lines.push(`- 近30天分类 Top：${cats.slice(0, 5).map(c => `${c.category} ¥${fmtYuan(c.amountMinor)}（${c.percent}%）`).join('、')}`)
  lines.push(platforms.length > 0 ? `- 本月平台消费：${platforms.map(p => `${p.platform} ${p.count}笔/¥${p.amountYuan}`).join('、')}` : '- 本月无平台消费记录')
  lines.push('- 最近交易：')
  for (const t of recent) {
    const d = new Date(t.time)
    lines.push(`  · ${fmtYuan(t.amountMinor)} ${t.merchant}（${t.category}，${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}，冲动${t.impulseLevel}）`)
  }

  return {
    domain: 'finance',
    title: '消费财务快照',
    text: lines.join('\n'),
    data: {
      monthOverview: mo,
      recent,
      categories: cats.slice(0, 5),
      platforms,
    },
  }
}

export const financeAgent: Agent = {
  id: 'finance',
  name: '消费财务',
  description: '回答预算、收支、分类/平台消费、账单等财务问题',
  systemPrompt,
  computeContext,
}

// ==================== Agent: 消费心理（psychology） ====================

import { db } from '../../db/database'
import { getProfile, profileContextText } from '../profile'
import type { Agent, AgentContext } from './types'
import { fmtYuan } from './shared'

const DAY = 86_400_000

const systemPrompt = `你是一个消费行为心理学家，回答"为什么总冲动/管不住手/情绪消费"这类问题。
规则：
- 你收到的【消费心理快照】里的画像指标（深夜占比/优惠敏感度/重复购买率/冲动概率/高风险时段/高风险分类/质量分）全部由本地统计引擎实时算出
- 解释用户的消费模式必须引用画像里的真实数值与具体事件，禁止说"你总是冲动"这类无数据依据的通用理由
- 每一个结论都要有数据证据，并落到 1-2 条具体可执行的改变建议（引用数字）
- 语气温和不评判，不说教
- 回答使用块标记格式（[stat]/[insight]/[tip]/[text]/[conclusion]），数字禁止编造`

async function computeContext(): Promise<AgentContext> {
  const profile = await getProfile()
  const events = await db.consumerEvents.toArray()
  const now = Date.now()
  const d30 = events.filter(e => now - new Date(e.time).getTime() <= 30 * DAY)
  const impulseEvents = d30.filter(e => e.isImpulse)

  // 触发类型分布（近30天）
  const triggerMap = new Map<string, number>()
  for (const e of d30) triggerMap.set(e.triggerType, (triggerMap.get(e.triggerType) ?? 0) + 1)
  const triggerDist = [...triggerMap.entries()]
    .map(([t, n]) => ({ trigger: t, count: n, percent: d30.length ? Math.round((n / d30.length) * 100) : 0 }))
    .sort((a, b) => b.count - a.count)

  // 最近 5 笔冲动事件
  const recentImpulses = impulseEvents
    .sort((a, b) => (a.time < b.time ? 1 : -1))
    .slice(0, 5)
    .map(e => {
      const d = new Date(e.time)
      return `${e.product} ¥${fmtYuan(e.amountMinor)}（${e.category}，${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}点，触发：${e.triggerType}，风险${e.riskScore}）`
    })

  // 近7天情绪
  const moods = await db.moods.toArray()
  const moodDist = moods
    .filter(m => now - new Date(m.date).getTime() <= 7 * DAY)
    .map(m => `${m.mood}(${m.date})`)

  const baseText = profileContextText(profile, d30.length)
  const lines: string[] = [baseText]
  lines.push(`- 近30天消费触发类型分布：${triggerDist.map(t => `${t.trigger} ${t.count}笔(${t.percent}%)`).join('、') || '数据不足'}`)
  lines.push(recentImpulses.length > 0 ? `- 最近冲动事件：\n  ${recentImpulses.map(x => `· ${x}`).join('\n  ')}` : '- 近30天暂无冲动事件')
  lines.push(moodDist.length > 0 ? `- 近7天情绪记录：${moodDist.join('、')}` : '- 近7天无情绪记录')

  return {
    domain: 'psychology',
    title: '消费心理快照',
    text: lines.join('\n'),
    data: {
      profile,
      triggerDistribution: triggerDist,
      recentImpulses,
      moodLast7: moodDist,
      impulse30Count: impulseEvents.length,
      impulse30Minor: impulseEvents.reduce((s, e) => s + e.amountMinor, 0),
    },
  }
}

export const psychologyAgent: Agent = {
  id: 'psychology',
  name: '消费心理',
  description: '解释消费冲动的原因、识别行为模式、给出行为改变建议',
  systemPrompt,
  computeContext,
}

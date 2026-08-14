// ==================== 动态追问生成（所有 Agent 共用） ====================
// 基于 Agent 实时算出的上下文，用 DeepSeek 生成 1-3 个追问，每个带"生成依据"。
// 无 Key / AI 失败返回空数组（主引擎不展示追问）。

import { chatCompletion, hasApiKey } from '../deepseek'
import { incrementAiCount } from '../../utils/aiUsage'
import type { Domain } from '../router'
import { DOMAIN_LABELS } from '../router'
import type { FollowUpQuestion } from './types'

function parseQuestions(content: string): FollowUpQuestion[] {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const raw = JSON.parse(content.slice(start, end + 1)) as { questions?: unknown }
    if (!Array.isArray(raw.questions)) return []
    return raw.questions
      .filter((q): q is { question?: unknown; basis?: unknown } =>
        !!q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string')
      .map(q => ({
        question: String(q.question).trim().slice(0, 60),
        basis: String(q.basis ?? '').trim().slice(0, 80),
      }))
      .filter(q => q.question && q.basis)
      .slice(0, 3)
  } catch {
    return []
  }
}

export async function suggestQuestions(domain: Domain, contextText: string): Promise<FollowUpQuestion[]> {
  if (!(await hasApiKey())) return []
  const system = `你是个人财务系统的追问引擎。下面是一段用户真实数据快照（${DOMAIN_LABELS[domain]}领域）。请基于这段数据生成 1-3 个下一步最值得追问用户的问题。
要求：
- 每个问题必须引用快照中的具体数据（数字/时段/分类/画像指标），说明为什么值得问（basis）
- 不同数据必须产生不同问题，禁止固定问题列表
- 问题要短（≤30字），口语化
- 只输出严格 JSON：{"questions": [{"question": "...", "basis": "生成依据，引用具体数字（≤60字）"}]}`
  const user = `数据快照：\n${contextText}\n\n请生成追问 JSON。`
  try {
    const content = await chatCompletion([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { json: true, temperature: 0.5 })
    await incrementAiCount()
    return parseQuestions(content)
  } catch {
    return []
  }
}

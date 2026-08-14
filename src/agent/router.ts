// ==================== 多 Agent Router：意图动态调度 ====================
// 用 DeepSeek 做意图分类（非 if/else 关键词匹配），无 Key / 失败时降级本地启发式。
// 返回主领域 + 副领域 + 置信度，主引擎据此选定 Agent 与上下文注入。

import { chatCompletion, hasApiKey } from './deepseek'
import { incrementAiCount } from '../utils/aiUsage'

export type Domain = 'finance' | 'psychology' | 'decision' | 'debt' | 'savings' | 'education' | 'growth'

export const DOMAINS: Domain[] = ['finance', 'psychology', 'decision', 'debt', 'savings', 'education', 'growth']

export const DOMAIN_LABELS: Record<Domain, string> = {
  finance: '消费财务',
  psychology: '消费心理',
  decision: '购买决策',
  debt: '债务管理',
  savings: '储蓄规划',
  education: '财商教育',
  growth: '财富增长',
}

export interface RouteResult {
  primaryDomain: Domain
  secondaryDomains: Domain[]
  confidence: number
  reason: string
}

/** 路由用的轻量上下文（画像 + 少量实时指标，避免为大模型传全量数据） */
export interface RouteContext {
  profile?: {
    nightRisk: number
    impulseProbability: number
    highRiskWindows: string[]
  }
  monthSpentYuan?: number
  monthBudgetYuan?: number
  debtTotalYuan?: number
  recentTx?: { merchant: string; category: string; amountYuan: number }[]
}

// ==================== 本地启发式降级（无 Key / AI 失败） ====================

const RULES: Array<[RegExp, Domain]> = [
  [/该不该|要不要|想买|买不买|值不值|值不值得|值得买|划算|纠结|能不能买|应不应该|可以买吗|买吗/, 'decision'],
  [/冲动|为什么总|为什么.*冲动|上头|情绪|心情|控制|习惯|后悔|忍不住|剁手|报复性/, 'psychology'],
  [/负债|花呗|信用卡|白条|借呗|还款|还钱|利息|分期|欠款|逾期|债务|最低还款/, 'debt'],
  [/存钱|储蓄|存款|攒钱|存多少|目标.*存|怎么存|存起来|储蓄率/, 'savings'],
  [/净资产|净收入|财富|投资|退休|财务自由|资产配置|复利|被动收入|收入增长|买房|攒到/, 'growth'],
  [/怎么.*(省钱|预算|理财)|是什么意思|什么是|教教|学习|知识|道理|原理|概念/, 'education'],
]

function localRoute(text: string): RouteResult {
  const t = text.replace(/\s+/g, '')
  let primary: Domain | null = null
  let secondary: Domain | null = null
  for (const [re, domain] of RULES) {
    if (re.test(t)) {
      if (!primary) primary = domain
      else if (!secondary && domain !== primary) secondary = domain
    }
  }
  const primaryDomain: Domain = primary ?? 'finance'
  const secondaryDomains: Domain[] = secondary ? [secondary] : []
  return { primaryDomain, secondaryDomains, confidence: primary ? 0.5 : 0.3, reason: '本地启发式分类（未配置 API Key）' }
}

// ==================== DeepSeek 意图分类 ====================

function isDomain(v: unknown): v is Domain {
  return typeof v === 'string' && (DOMAINS as string[]).includes(v)
}

function parseRoute(content: string): RouteResult | null {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const raw = JSON.parse(content.slice(start, end + 1)) as {
      primary?: unknown
      secondary?: unknown
      confidence?: unknown
      reason?: unknown
    }
    if (!isDomain(raw.primary)) return null
    const secondary = Array.isArray(raw.secondary)
      ? raw.secondary.filter(isDomain).filter(d => d !== raw.primary).slice(0, 3)
      : []
    const confidence = Number(raw.confidence)
    return {
      primaryDomain: raw.primary,
      secondaryDomains: secondary,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.7,
      reason: typeof raw.reason === 'string' && raw.reason ? raw.reason : 'DeepSeek 意图分类',
    }
  } catch {
    return null
  }
}

const DOMAIN_GUIDE = DOMAINS.map(d => `${d}（${DOMAIN_LABELS[d]}）`).join('，')

/** 基于用户消息 + 实时上下文，用 DeepSeek 分类意图；无 Key/失败走本地降级 */
export async function routeIntent(
  userMessage: string,
  context?: RouteContext
): Promise<RouteResult> {
  if (!(await hasApiKey())) return localRoute(userMessage)

  const system = `你是个人财务系统的意图路由器。根据用户消息与实时上下文，判断用户最想解决的是哪个领域的问题。
可选领域：${DOMAIN_GUIDE}。
规则：
- 只输出严格 JSON：{"primary": "主领域", "secondary": ["副领域数组，最多2个，可与主领域相关"], "confidence": 0-1数字, "reason": "一句简短分类依据"}
- 主领域必须唯一；副领域只在消息确实涉及多个领域时给出
- 判断要基于消息内容与上下文数据，不要套用固定关键词`
  const user =
    `用户消息："""${userMessage}"""\n\n` +
    `实时上下文（JSON）：\n\`\`\`json\n${JSON.stringify(context ?? {}, null, 2)}\n\`\`\`\n\n请输出意图分类 JSON。`

  try {
    const content = await chatCompletion([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { json: true, temperature: 0 })
    await incrementAiCount()
    const parsed = parseRoute(content)
    if (parsed) return parsed
    return localRoute(userMessage)
  } catch {
    return localRoute(userMessage)
  }
}

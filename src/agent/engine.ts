import { agentCompletion, chatCompletion, hasApiKey } from './deepseek'
import type { ChatMessage, ToolCall } from './deepseek'
import { AGENT_TOOLS, AGENT_TOOL_DEFS } from './tools'
import { generateHtmlReport } from './reportGenerator'
import type { ReportFacts, ReportType } from './reportGenerator'
import { incrementAiCount } from '../utils/aiUsage'
import { getSetting, setSetting } from '../db/crud'
import type { Transaction } from '../types'
import { computeMetrics, buildDayOverview, findHighRiskWindows } from './metrics'
import type { DayImpulseOverview, ReviewMetrics, RiskWindow } from './metrics'
import { classify, stateToneGuide } from './strategy'
import type { ReviewState } from './strategy'
import { getActionById, getActionPool } from './actions'
import type { ReviewAction } from './actions'
import { buildContext } from './context'
import { routeIntent } from './router'
import type { RouteResult } from './router'
import { AGENTS, suggestQuestions } from './agents'
import type { AgentContext, FollowUpQuestion } from './agents'
import { getProfile } from './profile'
import { getMonthOverview, getRecentTx } from './agents/shared'
import DOMPurify from 'dompurify'

// ==================== 类型 ====================

export interface AgentHistoryItem {
  role: 'user' | 'ai'
  content: string
}

/** 工具执行状态（前端用于显示"正在查询/已执行"提示） */
export interface AgentStatus {
  id: string
  name: string
  label: string
  state: 'running' | 'done' | 'error'
}

/** Agent 的最终回复：普通文本 或 HTML 报告 */
export type AgentReply =
  | { kind: 'text'; content: string; followUps?: FollowUpQuestion[] }
  | { kind: 'report'; type: ReportType; summary: string; html: string; facts: ReportFacts }

export interface AgentOptions {
  /** 最近对话历史（user/ai 文本），Agent 据此记住上下文 */
  history?: AgentHistoryItem[]
  /** 最近一次写操作摘要（供"刚才那笔/撤销"理解） */
  lastOp?: string | null
  /** 最近一次报告的 facts（用户追问报告内容时直接用，无需重新调工具） */
  lastFacts?: ReportFacts | null
  /** 工具状态回调（执行开始/结束） */
  onStatus?: (s: AgentStatus) => void
}

// ==================== 工具状态文案 ====================

const RUNNING_LABEL: Record<string, string> = {
  get_monthly_summary: '正在查询本月收支…',
  get_category_spending: '正在统计分类支出…',
  get_platform_spending: '正在统计平台支出…',
  get_daily_spending: '正在查询每日支出…',
  get_impulse_stats: '正在查询冲动消费…',
  get_debts: '正在查询负债…',
  get_savings: '正在查询储蓄进度…',
  get_schedules: '正在查询扣费日程…',
  get_recent_transactions: '正在查询最近交易…',
  get_budget_status: '正在查询预算状态…',
  add_transaction: '正在记账…',
  add_wishlist_item: '正在添加欲望清单…',
  add_savings_amount: '正在存入储蓄…',
  add_schedule: '正在添加日程…',
  generate_report: '正在生成 AI 报告…',
  delete_last_transaction: '正在撤销上一笔…',
}

const DONE_LABEL: Record<string, string> = {
  get_monthly_summary: '已查询本月收支',
  get_category_spending: '已统计分类支出',
  get_platform_spending: '已统计平台支出',
  get_daily_spending: '已查询每日支出',
  get_impulse_stats: '已查询冲动消费',
  get_debts: '已查询负债',
  get_savings: '已查询储蓄进度',
  get_schedules: '已查询扣费日程',
  get_recent_transactions: '已查询最近交易',
  get_budget_status: '已查询预算状态',
  add_transaction: '已记账',
  add_wishlist_item: '已添加欲望清单',
  add_savings_amount: '已存入储蓄',
  add_schedule: '已添加日程',
  generate_report: '报告已生成',
  delete_last_transaction: '已撤销上一笔',
}

// ==================== Agent 引擎 ====================

function parseToolArgs(tc: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tc.function.arguments || '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * 识别用户是否想要 HTML 数据分析报告（关键词触发）。
 * 返回报告类型：month / week / day；不匹配返回 null 走普通工具对话。
 * 避免误触发：要求"强关键词"或"时间段 + 状态词"同时出现。
 */
export function detectReportType(text: string): ReportType | null {
  const t = text.replace(/\s+/g, '')
  if (/报告|复盘|报表/.test(t) || /分析/.test(t)) {
    if (/周/.test(t)) return 'week'
    if (/今天|今日|昨天|昨日|日报/.test(t)) return 'day'
    return 'month'
  }
  if (/这个月|本月|这月/.test(t) && /怎么样|如何|咋样|总结|帮我看看/.test(t)) return 'month'
  if (/这周|本周|这星期/.test(t) && /怎么样|如何|咋样|总结|帮我看看/.test(t)) return 'week'
  return null
}

/** 把最近一次报告的 facts 压缩成一段上下文（供追问直接回答，不重新调工具） */
function compactFacts(f: ReportFacts): Record<string, unknown> {
  const o = f.overview
  return {
    period: f.periodLabel,
    overview: { spent: o.spent, income: o.income, budget: o.budget, remaining: o.remaining, budgetUsedPercent: o.budgetUsedPercent, impulseAmount: o.impulseAmount, impulseCount: o.impulseCount },
    categories: f.categories.slice(0, 8).map(c => ({ name: c.name, amount: c.amount, percent: c.percent, deltaPct: c.deltaPct })),
    platforms: f.platforms.slice(0, 5).map(p => ({ name: p.name, amount: p.amount, percent: p.percent })),
    impulse: { count: f.impulse.count, totalAmount: f.impulse.totalAmount, byPeriod: f.impulse.byPeriod, topPlatforms: f.impulse.topPlatforms, maxImpulse: f.impulse.maxImpulse },
    debts: f.debts,
    savings: f.savings,
    life: f.life,
    topTransactions: f.transactions.slice(0, 10),
  }
}

/**
 * Agent 多轮工具调用循环（多 Agent + 动态调度）：
 * 1. 用户消息先过 Router（DeepSeek 意图分类）→ 选定主 Agent（可串行组合副 Agent 的上下文）
 * 2. 主 Agent 的 computeContext 从数据库实时算出领域关键数据 → 注入 systemPrompt
 * 3. 保留 function calling 工具循环（LLM 选工具 + 本地执行），最多 4 轮
 * 4. 回复附带主 Agent 基于实时数据生成的 1-3 个追问（前端渲染成可点击按钮）
 * 用户明确要报告时（关键词命中），走 HTML 报告生成流程（代码算数 + AI 组织文字）。
 */

/** Router 用的轻量上下文（画像 + 本月概览 + 最近交易，避免全量数据） */
async function buildRouteContext(): Promise<Record<string, unknown>> {
  try {
    const [profile, mo, recent] = await Promise.all([getProfile(), getMonthOverview(), getRecentTx(5)])
    return {
      profile: {
        nightRisk: profile.nightRisk,
        impulseProbability: profile.impulseProbability,
        highRiskWindows: profile.highRiskWindows,
      },
      monthBudgetYuan: mo.budgetMinor / 100,
      monthSpentYuan: mo.spentMinor / 100,
      recentTx: recent.map(t => ({ merchant: t.merchant, category: t.category, amountYuan: t.amountMinor / 100 })),
    }
  } catch {
    return {}
  }
}

/** 组装 Agent 系统提示：角色 prompt + 领域数据快照 + 反模板硬约束 */
function buildSystemPrompt(
  primary: string,
  snapshotText: string,
  route: RouteResult,
  options: AgentOptions
): string {
  const secondaryLine = route.secondaryDomains.length > 0
    ? `\n用户消息同时涉及领域：${route.secondaryDomains.join('、')}，以下快照也包含这些领域的真实数据，可一并引用。`
    : ''
  return `${primary}
\n【实时数据快照】（由本地代码从数据库实时算出，必须引用其中的数字，禁止编造快照里没有的数字）：
${snapshotText}
${secondaryLine}

【最高原则 · 算法驱动，禁止模板化】
- 你的每个问题、每句分析、每个建议必须根据上面的实时数据动态生成
- 禁止固定话术、固定问题列表、固定模板
- 换个商品/换个用户，你的回答必须完全不同（因数据不同）
- 引用数字必须来自快照；没有数据支撑的就不写具体数字，如实说明"该项无数据"

【输出格式 · 必须是精美 HTML 卡片】
- 你的回答必须输出为精美 HTML 片段（内联CSS、蓝白配色、主色#0040FF、数字加粗+等宽字体+靛蓝色、标题靛蓝带左侧竖条、重要信息浅琥珀框、建议浅青卡片）
- 禁止 Markdown 语法，禁止 \`\`\`html 包裹，只输出 HTML 内容本身（可用 <div>/<p>/<b> 等标签）
- 交互式追问问题用浅靛蓝底圆角卡片（卡片式按钮样式）呈现，问题前带小图标（如 💬/🤔）
${options.lastOp ? `\n最近一次操作：${options.lastOp}。用户说"刚才那笔/刚才的/撤销"时，指的是这次操作。` : ''}
${options.lastFacts ? `\n以下是最近一份报告从数据库算出的真实数据（用户可能追问报告内容，回答相关问题直接用这些数字，禁止编造，也无需重新调用查询工具；与报告无关的新请求仍可调用工具）：\n${JSON.stringify(compactFacts(options.lastFacts))}` : ''}`
}

export async function runAgent(text: string, options: AgentOptions = {}): Promise<AgentReply> {
  // 追问保护：刚看过报告时，带"为什么/怎么"等追问词 → 用已收集 facts 回答，不再重新生成报告
  const isFollowUp = !!options.lastFacts && /为什么|为何|怎么|哪块|哪个|哪项|解释|说说|讲讲|原因|多少/.test(text)
  const reportType = isFollowUp ? null : detectReportType(text)
  if (reportType) {
    const report = await generateHtmlReport(reportType, { onStatus: options.onStatus })
    return { kind: 'report', type: report.type, summary: report.summary, html: report.html, facts: report.facts }
  }

  // ---- ① Router：DeepSeek 意图分类 ----
  const routeContext = await buildRouteContext()
  const route = await routeIntent(text, routeContext)

  // ---- ② 选定主 Agent，串行计算主 + 副领域上下文 ----
  const primary = AGENTS[route.primaryDomain]
  const secondaryAgents = route.secondaryDomains.slice(0, 2).map(d => AGENTS[d]).filter(a => a.id !== primary.id)

  const contexts: AgentContext[] = []
  contexts.push(await primary.computeContext({ message: text }))
  for (const agent of secondaryAgents) {
    try {
      contexts.push(await agent.computeContext({ message: text }))
    } catch {
      // 副领域上下文失败不阻塞主流程
    }
  }
  const snapshotText = contexts.map(c => `【${c.title}】\n${c.text}`).join('\n\n')
  const primaryCtx = contexts[0]

  const systemPrompt = buildSystemPrompt(primary.systemPrompt, snapshotText, route, options)

  const history = options.history ?? []
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-20).map(h => ({
      role: h.role === 'ai' ? 'assistant' as const : 'user' as const,
      content: h.content,
    })),
    { role: 'user', content: text },
  ]

  // ---- ③ 保留 function calling 工具循环 ----
  let statusSeq = 0
  let reply = ''
  for (let round = 0; round < 4; round++) {
    const turn = await agentCompletion(messages, AGENT_TOOL_DEFS, { temperature: 0.3 })
    if (!turn.toolCalls || turn.toolCalls.length === 0) {
      reply = turn.content ?? ''
      break
    }
    // 把模型"要调用工具"的决策加入历史
    messages.push({
      role: 'assistant',
      content: turn.content,
      tool_calls: turn.toolCalls,
    })
    // 依次执行工具，把结果作为 tool 角色消息回传
    for (const tc of turn.toolCalls) {
      const statusId = `t${++statusSeq}`
      const name = tc.function.name
      options.onStatus?.({ id: statusId, name, label: RUNNING_LABEL[name] ?? `正在执行 ${name}…`, state: 'running' })
      let result: unknown
      let ok = true
      try {
        const tool = AGENT_TOOLS.find(t => t.name === name)
        if (!tool) throw new Error(`未知工具：${name}`)
        result = await tool.execute(parseToolArgs(tc))
      } catch (e) {
        ok = false
        result = { error: e instanceof Error ? e.message : String(e) }
      }
      options.onStatus?.({
        id: statusId,
        name,
        label: ok ? (DONE_LABEL[name] ?? `已完成 ${name}`) : `⚠️ ${name} 执行失败`,
        state: ok ? 'done' : 'error',
      })
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
    }
  }
  if (!reply) reply = '我已尝试多次但尚未完成你的请求，请换个说法试试。'

  // ---- ④ 主 Agent 动态追问（基于实时上下文，带生成依据） ----
  const followUps = await suggestQuestions(primary.id, primaryCtx.text)
  return { kind: 'text', content: reply, followUps }
}

// ============================================================================
// 行为教练 · 冲动复盘（数据驱动）：runReview 串起 metrics → strategy → actions → context → LLM
// ============================================================================

/** 追加到所有行为教练 AI 调用的系统提示（HTML 输出约束） */
export const REVIEW_SYSTEM_PROMPT =
  '你是一个个人财务行为教练，可调用工具查询和操作用户数据。' +
  '额外能力：净资产追踪（balance_snapshots）、自我承诺（commitments）、情绪记录（moods）、账单导入记录。' +
  '你收到的数据快照里包含了用户的真实财务数据，你必须基于这些数据说话，禁止编造数字。' +
  '你的回复必须是精美 HTML 片段（内联CSS、蓝白配色、主色#0040FF、数字加粗等宽字体、标题靛蓝带左侧竖条、重要信息浅琥珀框、建议浅青卡片）。' +
  '输出不要用 Markdown 语法。根据情境状态（low/impulse/high_damage）调整语气：low=轻松一句；impulse=点名模式指出规律；high_damage=给具体补偿方案。' +
  '开场白要引用真实数据（金额/时间/平台/历史次数/后悔率）。语气温和不说教。'

// ---- 本地工具 ----

function pad2(n: number): string { return String(n).padStart(2, '0') }

function fmtYuan1(minor: number): string {
  return (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })
}

function timeOf(iso: string): string {
  const d = new Date(iso)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function daysLeftInMonth(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate()
}

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 本地模板里转义用户文本（商家名可能含特殊字符） */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** DOMPurify 白名单清洗 AI 输出的 HTML（允许 style/class，剥离 script/iframe/事件属性等危险内容） */
function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'div', 'p', 'span', 'b', 'strong', 'i', 'em', 'u', 'br',
      'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'img', 'a', 'code', 'pre', 'blockquote',
    ],
    ALLOWED_ATTR: ['style', 'class', 'href', 'src', 'alt', 'title', 'target', 'rel'],
    ALLOW_DATA_ATTR: false,
  })
}

const REVIEW_FONT = 'font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.75;color:#374151'

// ---- 本地开场白（无 Key / AI 失败降级，同样是 HTML） ----

export function localOpeningHtml(
  m: ReviewMetrics,
  state: ReviewState,
  day: DayImpulseOverview,
  amountMinor: number
): string {
  const dayLine = day.count > 0
    ? `今天${day.count}笔冲动共<strong>¥${fmtYuan1(day.totalMinor)}</strong>${day.maxTx
      ? `，其中【${esc(day.maxTx.merchant)} ¥${fmtYuan1(day.maxTx.amountMinor)}】发生在 ${timeOf(day.maxTx.time)}`
      : ''}。`
    : ''

  let body: string
  switch (state) {
    case 'low':
      body = `这笔<strong>¥${fmtYuan1(amountMinor)}</strong>不算大问题，预算还够。但你在<strong>${esc(m.triggerScene)}</strong>下单，下次可以试试把它放进「冷静24h」清单。`
      break
    case 'impulse': {
      const who = m.platform ? `在${esc(m.platform)}${m.isDeepNight ? '深夜' : '白天'}` : `${m.isDeepNight ? '深夜' : '白天'}`
      const advice = m.isDeepNight
        ? '23点后锁购物App，睡前把手机放远一点'
        : m.platform
          ? `把${esc(m.platform)}设一个每日限额`
          : '同类商品先加进欲望清单，冷静72小时再决定'
      body = `${dayLine}这是你近30天第<strong>${m.repeatRate}</strong>次${who}冲动消费，累计<strong>¥${fmtYuan1(m.repeatMinor)}</strong>。这个时段你的自控力最弱，建议${advice}。`
      break
    }
    case 'high_damage': {
      const n = Math.max(1, daysLeftInMonth())
      const remaining = m.budgetMinor - m.monthExpenseMinor
      const perDay = Math.max(0, Math.round(remaining / n / 100))
      if (m.savingsGoalPctBefore != null && m.savingsGoalPctAfter != null) {
        body = `这笔<strong>¥${fmtYuan1(amountMinor)}</strong>让你的储蓄进度从<strong>${m.savingsGoalPctBefore}%</strong>掉到<strong>${m.savingsGoalPctAfter}%</strong>。如果还想本月达标，接下来<strong>${n}</strong>天每天只能花约<strong>¥${perDay}</strong>。要不要我帮你把明天的额度先降下来？`
      } else {
        body = `这笔之后，本月剩余预算只剩约<strong>¥${fmtYuan1(Math.max(0, remaining))}</strong>，接下来<strong>${n}</strong>天每天只能花约<strong>¥${perDay}</strong>。要不要我帮你把明天的额度先降下来？`
      }
      break
    }
  }
  return `<div style="${REVIEW_FONT}">${body}</div>`
}

// ---- 本地复盘结论（块卡片式 HTML，AI 失败降级） ----

export function localConclusionHtml(
  m: ReviewMetrics,
  state: ReviewState,
  day: DayImpulseOverview,
  actions: string[]
): string {
  const stat = [
    { label: '冲动笔数', value: `${day.count}笔` },
    { label: '冲动总额', value: `¥${fmtYuan1(day.totalMinor)}` },
    { label: '最大一笔', value: day.maxTx ? `¥${fmtYuan1(day.maxTx.amountMinor)}` : '—' },
  ].map(s => (
    `<div style="flex:1;background:#fff;border:1px solid #C0C4C4;border-radius:10px;padding:8px 6px;text-align:center">` +
    `<div style="font-size:11px;color:#A0A4A4">${s.label}</div>` +
    `<div style="font-size:16px;font-weight:700;color:#111111;font-variant-numeric:tabular-nums;font-family:Consolas,Menlo,monospace;margin-top:2px">${s.value}</div>` +
    `</div>`
  )).join('')

  const insights: string[] = []
  if (m.coolingResistance != null && m.coolingSample > 0) {
    insights.push(`同类商品放进欲望清单后放弃率 <strong>${m.coolingResistance}%</strong>——冷静真的有用`)
  }
  if (m.repeatRate >= 2) {
    insights.push(`近30天同场景已出现 <strong>${m.repeatRate}</strong> 次，累计<strong>¥${fmtYuan1(m.repeatMinor)}</strong>`)
  }
  if (insights.length === 0) insights.push('这笔冲动没有伤到预算与储蓄目标，状态可控')

  let tips: string[]
  if (state === 'high_damage') {
    const n = Math.max(1, daysLeftInMonth())
    const perDay = Math.max(0, Math.round((m.budgetMinor - m.monthExpenseMinor) / n / 100))
    tips = [`接下来每天先按 <strong>¥${perDay}</strong> 的额度过，优先保住储蓄目标`]
  } else if (state === 'impulse') {
    tips = [m.isDeepNight
      ? '23点后把购物App锁起来，睡前别逛'
      : (m.platform ? `把${esc(m.platform)}设一个每日限额` : '同类商品先加欲望清单冷静72小时')]
  } else {
    tips = ['下次再心动，先扔进欲望清单冷静24小时']
  }

  const conclusion =
    state === 'low'
      ? '这单无伤大雅，但每一次冲动都是认识自己的机会——下次试试先放清单。'
      : state === 'impulse'
        ? '老毛病不怕犯，怕的是不认账。已经看到规律了，改变就有方向。'
        : '这一笔有点疼，好在账算清楚了——守住每天额度，月底还能达标。'

  const actionLine = actions.length > 0
    ? `<div style="margin-top:10px;font-size:13px;color:#4B5563">✅ 本次已执行：${actions.map(esc).join('、')}</div>`
    : ''

  return `<div style="${REVIEW_FONT}">
  <div style="display:flex;gap:8px">${stat}</div>
  <div style="margin-top:10px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:10px;padding:10px 12px;font-size:13px">
    <div style="font-weight:700;color:#92400E;margin-bottom:4px">📌 发现</div>
    <div style="color:#78350F">${insights.map(i => `<div>· ${i}</div>`).join('')}</div>
  </div>
  <div style="margin-top:8px;background:#ECFEFF;border:1px solid #A5F3FC;border-radius:10px;padding:10px 12px;font-size:13px">
    <div style="font-weight:700;color:#155E75;margin-bottom:4px">💡 建议</div>
    <div style="color:#164E63">${tips.map(i => `<div>· ${i}</div>`).join('')}</div>
  </div>
  <div style="margin-top:10px;font-weight:600;color:#111111">${conclusion}</div>
  ${actionLine}
</div>`
}

// ---- AI 调用（JSON：开场白 HTML + 推荐动作 id；失败返回 null 走本地降级） ----

interface AiReviewJson {
  openingHtml?: string
  actionIds?: string[]
}

function parseReviewJson(content: string): AiReviewJson | null {
  const cleaned = content.replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const raw = JSON.parse(cleaned.slice(start, end + 1)) as { openingHtml?: unknown; actionIds?: unknown }
    const openingHtml = typeof raw.openingHtml === 'string' && raw.openingHtml.trim() ? raw.openingHtml.trim() : undefined
    const actionIds = Array.isArray(raw.actionIds)
      ? raw.actionIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
      : undefined
    return { openingHtml, actionIds }
  } catch {
    return null
  }
}

async function aiReviewJson(
  contextText: string,
  state: ReviewState,
  reasons: string[],
  pool: ReviewAction[],
  day: DayImpulseOverview
): Promise<AiReviewJson | null> {
  if (!(await hasApiKey())) return null
  const actionList = pool.map(a => `- ${a.id}：${a.label}（${a.description}）`).join('\n')
  const user =
    `数据快照：\n${contextText}\n\n` +
    `今日冲动概览：${day.count}笔 / ¥${fmtYuan1(day.totalMinor)}${day.maxTx ? `，最大一笔【${day.maxTx.merchant} ¥${fmtYuan1(day.maxTx.amountMinor)}】发生在 ${timeOf(day.maxTx.time)}` : ''}\n\n` +
    `情境状态：${state}\n命中依据：${reasons.join('；')}\n\n` +
    `可用动作池（前端会渲染成可点击按钮，务必只从这里面选 id）：\n${actionList}\n\n` +
    `请输出严格 JSON（不要输出 JSON 以外的任何内容）：\n` +
    `{"openingHtml": "精美的HTML开场白片段（内联CSS、蓝白配色、主色#0040FF、数字加粗等宽字体、无Markdown语法）", "actionIds": ["从动作池中挑选1-3个最合适的id"]}\n\n` +
    `${stateToneGuide(state)}\n开场白必须引用数据快照里的真实数字（金额/时间/平台/历史次数/后悔率），禁止编造。`
  try {
    const content = await chatCompletion([
      { role: 'system', content: REVIEW_SYSTEM_PROMPT },
      { role: 'user', content: user },
    ], { json: true, temperature: 0.6 })
    await incrementAiCount()
    return parseReviewJson(content)
  } catch {
    return null
  }
}

// ---- 复盘收尾：AI 生成结论 HTML（块卡片式） ----

async function aiConclusionHtml(
  contextText: string,
  state: ReviewState,
  actions: string[],
  day: DayImpulseOverview,
  prediction: string | null
): Promise<string | null> {
  if (!(await hasApiKey())) return null
  const user =
    `数据快照：\n${contextText}\n\n` +
    `情境状态：${state}\n今日冲动概览：${day.count}笔 / ¥${fmtYuan1(day.totalMinor)}\n` +
    `已执行的选项动作：${actions.join('、') || '无'}\n` +
    (prediction ? `前瞻提醒：${prediction}\n` : '') +
    `\n请输出严格 JSON（不要输出 JSON 以外的任何内容）：\n` +
    `{"conclusionHtml": "一段HTML复盘结论（内联CSS、蓝白配色、主色#0040FF）：顶部数字卡（最多3项，含今日冲动笔数/总额）、中部📌发现卡（1-2条，引用真实数字）、下部💡建议卡（1-2条，结合已执行动作）、结尾一句话收尾。无Markdown语法"}`
  try {
    const content = await chatCompletion([
      { role: 'system', content: REVIEW_SYSTEM_PROMPT },
      { role: 'user', content: user },
    ], { json: true, temperature: 0.5 })
    await incrementAiCount()
    const parsed = parseReviewJson(content)
    return parsed?.openingHtml ? sanitizeHtml(parsed.openingHtml) : null
  } catch {
    return null
  }
}

// ---- 前瞻预测 ----

/** 复盘收尾 / 总结卡底部的"下一周高频窗口"提醒 */
export function buildForecastMessage(
  windows: RiskWindow[],
  platform: string | null,
  avgMinorHint: number
): string | null {
  const top = windows[0]
  if (!top) return null
  const avg = Math.round((top.avgMinor || avgMinorHint) / 100)
  const p = platform ? `今晚如果刷到${platform}，` : ''
  return `根据过去30天数据，你每周${top.dayLabel}${top.windowLabel}前后最容易冲动消费，平均¥${avg}。${p}系统会提前10分钟弹一条轻提醒，帮你按下暂停键。`
}

/** 高频窗口命中判定（窗口开始前 30 分钟起、结束 10 分钟后止） */
function isWithinWindow(w: RiskWindow, now: Date): boolean {
  if (w.dayOfWeek !== now.getDay()) return false
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const startMin = w.startHour * 60
  const endMin = w.endHour === 24 ? 24 * 60 : w.endHour * 60
  return nowMin >= startMin - 30 && nowMin <= endMin + 10
}

/**
 * 高频冲动窗口温和提示条（首页/欲望清单页）：
 * - 每天最多显示 1 条（settings: forecastShown_日期）
 * - 22:00-08:00 不显示（深夜不打扰）
 */
export async function getForecastBanner(): Promise<{ text: string; window: RiskWindow } | null> {
  const now = new Date()
  const h = now.getHours()
  if (h >= 22 || h < 8) return null

  const today = todayKey()
  const shown = await getSetting(`forecastShown_${today}`)
  if (shown) return null

  const windows = await findHighRiskWindows()
  const top = windows[0]
  if (!top) return null

  if (!isWithinWindow(top, now)) return null

  await setSetting(`forecastShown_${today}`, '1')
  const avg = Math.round(top.avgMinor / 100)
  const text = `你的老时间到了：每周${top.dayLabel}${top.windowLabel}你最容易冲动消费（平均¥${avg}）。要不要先看看书、喝杯水？`
  return { text, window: top }
}

// ---- ⑤ runReview：全流程编排 ----

export interface ReviewResult {
  /** HTML 开场白（AI 或本地模板，直接渲染） */
  openingHtml: string
  /** 动态动作按钮（点击调用 actions.ts 的 execute） */
  actions: ReviewAction[]
  metrics: ReviewMetrics
  state: ReviewState
  reasons: string[]
  /** 前瞻提醒（高频窗口），无历史规律时为 null */
  prediction: string | null
  dayOverview: DayImpulseOverview
  /** 是否 AI 生成（false = 本地模板降级） */
  rich: boolean
}

/**
 * 一条冲动消费的完整复盘：
 * computeMetrics → classify → getActionPool → buildContext → DeepSeek(开场HTML+推荐动作)
 * → 前瞻预测 → 返回渲染所需全部内容。无 Key / AI 失败时全程本地降级。
 */
export async function runReview(tx: Transaction): Promise<ReviewResult> {
  const [metrics, dayOverview] = await Promise.all([computeMetrics(tx), buildDayOverview()])
  const { state, reasons } = classify(metrics)
  const pool = getActionPool(state, metrics)
  const contextText = await buildContext(tx, metrics)
  const windows = await findHighRiskWindows()
  // 有高频窗口 → 具体规律；数据不足 → 温和前瞻（保证总结卡总有前瞻区块）
  const prediction = buildForecastMessage(windows, metrics.platform, metrics.repeatMinor)
    ?? '近30天的冲动记录还不多，多记几笔就能看到你的高频冲动时段，到时我会在每次复盘里提前提醒你。'

  let openingHtml = localOpeningHtml(metrics, state, dayOverview, tx.amountMinor)
  let actions = pool
  let rich = false
  try {
    const ai = await aiReviewJson(contextText, state, reasons, pool, dayOverview)
    if (ai?.openingHtml) {
      openingHtml = sanitizeHtml(ai.openingHtml)
      const picked = (ai.actionIds ?? []).map(id => getActionById(id)).filter((a): a is ReviewAction => !!a)
      if (picked.length > 0) actions = picked
      rich = true
    }
  } catch {
    // 降级本地模板
  }
  return { openingHtml, actions, metrics, state, reasons, prediction, dayOverview, rich }
}

/** 复盘收尾：生成结论 HTML（AI 优先，失败本地卡片模板） */
export async function finishReview(args: {
  tx: Transaction
  metrics: ReviewMetrics
  state: ReviewState
  reasons: string[]
  executedActions: string[]
  dayOverview: DayImpulseOverview
  prediction: string | null
}): Promise<{ conclusionHtml: string; rich: boolean }> {
  const { tx, metrics, state, executedActions, dayOverview, prediction } = args
  const contextText = await buildContext(tx, metrics)
  let conclusionHtml = localConclusionHtml(metrics, state, dayOverview, executedActions)
  let rich = false
  try {
    const ai = await aiConclusionHtml(contextText, state, executedActions, dayOverview, prediction)
    if (ai) {
      conclusionHtml = ai
      rich = true
    }
  } catch {
    // 降级本地模板
  }
  return { conclusionHtml, rich }
}

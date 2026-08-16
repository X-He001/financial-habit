// ==================== 消费认知复盘引擎（AI 助手 · 复盘能力） ====================
// 认知重构复盘：这是 AI 助手（原"认知教练"）的算法分析与数据记忆能力。
// - 复用现有 function calling 基础设施（agentCompletion + AGENT_TOOLS），
//   但只暴露只读查询 + 笔记存档的 COACH_TOOL_NAMES 子集（写交易/欲望清单等普通工具不给复盘对话）。
// - 所有数字由本地代码实时算出（工具返回等级 低/中/高/极高），AI 只组织语言。
// - 每次复盘的用户回答/洞察通过 save_behavior_notes 沉淀进 behavior_profiles.coachNotes，
//   下次复盘开场可引用"上次你说…"（越用越懂）。
// - 环境改造动作：AI 在回复 HTML 中输出 data-action="env:xxx" 按钮，
//   点击后调用 applyCoachEnvAction 真实写入 settings 生效。

import { agentCompletion, hasApiKey } from './deepseek'
import type { ChatMessage, ToolCall } from './deepseek'
import { AGENT_TOOLS, AGENT_TOOL_DEFS, COACH_TOOL_NAMES } from './tools'
import { getSetting, setSetting } from '../db/crud'
import { db } from '../db/database'
import { getProfile, profileContextText } from './profile'
import type { AgentStatus } from './engine'
import { FACT_DISCIPLINE, FACT_GUARD_HINT, PRIVACY_HINT } from './factDiscipline'
import { collectFacts, applyUncertaintyMarks } from '../utils/factGuard'
import { resolveTier } from '../utils/privacy'

// ==================== 教练可用的工具（只读 + 笔记，function calling 子集） ====================

export const COACH_TOOL_DEFS = AGENT_TOOL_DEFS.filter(t => COACH_TOOL_NAMES.includes(t.function.name))

// ==================== 角色设定（写入 system prompt） ====================

export const COACH_ROLE =
  '你是用户的财务助手「AI 助手」中的消费认知复盘能力，懂行为经济学与习惯科学。' +
  '你不评判、不说教、不制造焦虑。你通过查看用户的真实消费数据，' +
  '帮用户看见自己的消费模式、理解背后的情绪与动机，并一起找到可执行的改变动作。' +
  '你的每个建议都有数据支撑，必要时引用书/研究作为依据。' +
  '你只组织语言，所有数字由系统算出，你绝不自己算钱。'

/**
 * 组装教练系统提示：
 * 1. 角色人设（COACH_ROLE）
 * 2. 实时画像快照（含历次复盘笔记，供"上次你说…"）
 * 3. 反模板 / 数字等级化 / 对话流程 / 环境改造按钮 等硬约束
 */
export function buildCoachSystemPrompt(snapshotText: string, isFirstTime: boolean): string {
  const stage = isFirstTime
    ? '这是用户第一次做认知复盘：先调用工具查看已有数据，基于看到的数据自然提问了解情况；数据很少时诚实说明"你才记了 X 笔"，先问几个问题了解用户，再一起看怎么帮你。'
    : '用户此前做过复盘：开场必须先调用 get_behavior_profile 读取历次存档，引用"上次你说…"衔接历史，然后结合本周/本月新数据继续，只追问新信息，绝不重复问已回答过的问题。'
  return `${COACH_ROLE}

【当前阶段】
${stage}

【实时数据快照】（由本地代码从数据库实时算出，必须引用其中的数字与等级，禁止编造快照里没有的数字）：
${snapshotText}

【最高原则 · 算法驱动，禁止模板化】
- 你的每个观察、每个问题、每句分析都必须基于上面的实时数据动态生成；严禁预设固定问题清单、固定话术、固定模板
- 换一批数据/换一个用户，你的回答必须完全不同
- 同一批数据在不同时间的复盘内容也要有差异（因数据与对话在变化）
- 引用数字必须来自快照或你调用工具拿到的结果；没有数据支撑的就如实说明"该项暂无数据"

【数字使用规范 · 只报等级，绝不报 0-100】
- 你只能使用工具返回的等级词（低/中/高/极高）和真实金额/笔数/时间
- 严禁向用户展示任何 0-100 的分数或百分比数字（如冲动分、占比分数），这些只用于你内部判断，不得出现在给用户看的文字里

${FACT_DISCIPLINE}
- 需要用户标记/确认的具体项目（如自我标记对照），只能列出快照或工具结果中真实存在的交易；没有具体可列项时，直接请用户口述或输入，禁止自编商品名、金额、次数作为选项

【不确定性标识 · 已确认 vs 未核实】
- 引用数据时区分两种状态：快照/工具返回里有的 → 作为确定事实陈述；没有的 → 必须用「未核实」标注或写"数据暂缺"，绝不含糊带过
- 你的输出会经过本地事实核查引擎复核：金额/商家/笔数找不到依据会被自动标注「⚠ 未核实」并记录问题，请输出前自查一遍

${FACT_GUARD_HINT}

${PRIVACY_HINT}

【购买反馈对象B标记（F5 7.4，仅此一种情况才标记）】
- 当对话中用户明确承认某笔消费"是冲动/踩了坑/不该买"（且该消费冲动等级为高或极高）时，调用 queue_feedback_card 入队一张反馈卡：
  参数 objectType=event、objectId=该笔交易的时间（ISO，工具返回里有）、patternKey=对应模式（如"深夜购物"）、opening=一个数据观察+一个开放问题（禁止结论）、knowledgeRefId=可先用 search_knowledge 检索命中
- 只有"冲动高 + 用户亲口承认"才标记；用户未承认的纯冲动消费绝不主动反馈
- 周上限 3 条由代码强制，超限返回 weekly_limit，无需你处理

【债务认知重构 · 辅助引导（不预设、不评判、不说教）】
- 若快照或工具返回中有负债数据（账户/待还/真实年化/每日利息/还款日），在复盘推进中自然引用真实数字提出 1~2 个关于借贷与超前消费认知的问题；问题必须基于实时数据现场生成，严禁预设问题模板
- 示例提问风格（仅示意，禁止照抄）：「你的花呗真实年化 18%，是储蓄收益（2%）的 9 倍——你每次用花呗时，感觉它像借钱，还是像更方便的钱包？」（数字一律引用快照或工具返回，禁止自己算）
- 用户回答通过 save_behavior_notes 存档（tag 用"风险点"），下次复盘开场引用"上次你说…"
- 债务建议只给可执行动作（如先还高利率账户、避免只还最低导致利滚利），可带数据出处，不评判、不说教、不制造焦虑

【对话方式 · 多轮交互式复盘（≥3 轮）】
- 先给带真实数字的观察（如"近 7 天深夜消费 3 笔共 ¥128"），再就观察提问，等用户回答后再引用回答调整结论继续聊
- 每轮只提 1~2 个问题，问题要具体、与用户的数据相关（如"那笔深夜消费，当时是饿了还是想缓解压力？"）
- 提问可以是开放式文字，也可以是按钮式问题（见"环境改造与提问按钮"）

【复盘流程骨架（内容全部实时生成，严禁套模板）】
1. 开场 + 数据观察：调用工具现场算多维度统计（时段分布、平台/商家集中、类别频率、金额偏离、支付方式、消费节奏），用数字 + 等级呈现画像；数据不足时诚实说明
2. 模式提问：基于观察提出 1~2 个点选式/开放式问题，确认模式
3. 认知重构：围绕回答追问，帮用户看见模式背后的动机/情绪，命名模式（如"情绪性消费""渴望回路"），必要时引用书/研究作依据
4. 环境改造清单：把模式变成可一键开启的真实设置（深夜占比高→深夜锁 late_night_lock；平台占比高→冻结 freeze_until 或平台限额 platform_limit；类别复发→日限额 daily_limit），输出为可点击按钮
5. 自我标记对照：列出高冲动项（只列快照中真实出现的交易，数据不足时请用户口述）让用户标"哪些是真冲动"，差异处追问一句
6. 收尾存档：调用 save_behavior_notes 记录本次对话要点，供下次引用

【环境改造与提问按钮 · 输出规则】
- 需要用户点选的环境改造开关，输出为按钮：
  <button data-action="env:late_night_lock">🔒 开启深夜锁</button>
  <button data-action="env:freeze_until">🧊 冻结非必要支出3天</button>
  <button data-action="env:daily_limit">📉 设置明日额度</button>
  <button data-action="env:platform_limit">🎯 设置平台限额</button>
- 需要用户直接回答的问题，可输出为带小图标的按钮式问题：
  <button data-action="ask:当时是饿了还是想缓解压力？">当时是饿了还是想缓解压力？</button>
  （点击后会把按钮文字作为你的用户消息发送，你据此继续对话）
- 按钮可以配合普通文字一起使用；每轮最多 3 个按钮

【输出格式 · 必须是精美 HTML 卡片】
- 你的回答必须输出为精美 HTML 片段（内联CSS、蓝白配色、主色#0040FF、数字加粗+等宽字体+靛蓝色、标题靛蓝带左侧竖条、重要信息浅琥珀框、建议浅青卡片）
- 禁止 Markdown 语法，禁止 \`\`\`html 包裹，只输出 HTML 内容本身（可用 <div>/<p>/<b>/<button> 等标签）
- 语气温和、不评判、不说教、不制造焦虑`
}

// ==================== 工具执行循环 ====================

function parseToolArgs(tc: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tc.function.arguments || '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const COACH_RUNNING_LABEL: Record<string, string> = {
  get_recent_transactions: '正在翻看你的最近交易…',
  get_spending_pattern: '正在分析你的消费模式…',
  get_budget_status: '正在查看预算执行…',
  get_debt_summary: '正在查看你的负债…',
  get_savings: '正在查看储蓄进度…',
  get_schedules: '正在查看扣费日程…',
  get_behavior_profile: '正在读取你的消费画像…',
  save_behavior_notes: '正在存档这条自我认知…',
}
const COACH_DONE_LABEL: Record<string, string> = {
  get_recent_transactions: '已读取最近交易',
  get_spending_pattern: '消费模式分析完成',
  get_budget_status: '预算状态已读取',
  get_debt_summary: '负债概况已读取',
  get_savings: '储蓄进度已读取',
  get_schedules: '扣费日程已读取',
  get_behavior_profile: '消费画像已读取',
  save_behavior_notes: '自我认知已存档',
}

/**
 * 认知教练多轮工具循环（与 engine.ts 的 runAgent 同一套机制，最多 4 轮）：
 * LLM 只能选 COACH_TOOL_NAMES 子集，其余工具名直接拒绝执行。
 * 返回模型最终回复文本（HTML 卡片）。
 */
export async function runCoachTurn(
  messages: ChatMessage[],
  options: { onStatus?: (s: AgentStatus) => void } = {}
): Promise<string> {
  let statusSeq = 0
  let reply = ''
  /** 工具返回的真实数据（收尾做事实核查用） */
  const toolResults: unknown[] = []
  for (let round = 0; round < 4; round++) {
    const turn = await agentCompletion(messages, COACH_TOOL_DEFS, { temperature: 0.5 })
    if (!turn.toolCalls || turn.toolCalls.length === 0) {
      reply = turn.content ?? ''
      break
    }
    messages.push({ role: 'assistant', content: turn.content, tool_calls: turn.toolCalls })
    for (const tc of turn.toolCalls) {
      const statusId = `c${++statusSeq}`
      const name = tc.function.name
      options.onStatus?.({ id: statusId, name, label: COACH_RUNNING_LABEL[name] ?? `正在执行 ${name}…`, state: 'running' })
      let result: unknown
      let ok = true
      try {
        // 复盘对话只允许调用 COACH_TOOL_NAMES 子集（写交易/欲望清单等普通工具一律拒绝）
        if (!COACH_TOOL_NAMES.includes(name)) throw new Error(`AI 助手无权调用该工具：${name}`)
        const tool = AGENT_TOOLS.find(t => t.name === name)
        if (!tool) throw new Error(`未知工具：${name}`)
        // 隐私分层：复盘=档1 聚合；用户主动查单笔（"那笔/订单/明细"）→ 档3 完整单笔
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
        const raw = lastUserMsg?.content ?? ''
        const lastUserText = typeof raw === 'string'
          ? raw
          : Array.isArray(raw) ? raw.map(p => p.text ?? '').join(' ') : ''
        result = await tool.execute(parseToolArgs(tc), { privacyTier: resolveTier({ userText: lastUserText }) })
      } catch (e) {
        ok = false
        result = { error: e instanceof Error ? e.message : String(e) }
      }
      options.onStatus?.({
        id: statusId,
        name,
        label: ok ? (COACH_DONE_LABEL[name] ?? `已完成 ${name}`) : `⚠️ ${name} 执行失败`,
        state: ok ? 'done' : 'error',
      })
      if (ok) toolResults.push(result)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
    }
  }
  if (!reply) reply = 'AI 助手正在整理思路，请再说一次好吗？'
  // 事实核查收尾：输出与工具返回的真实数据比对，存疑金额/商家/分数标注「⚠ 未核实」
  return applyUncertaintyMarks(reply, collectFacts(toolResults)).html
}

// ==================== 首次建档判定（供 UI 决定是否自动开场） ====================

/** 是否第一次做认知复盘（画像里没有任何复盘存档） */
export async function isFirstCoaching(): Promise<boolean> {
  try {
    const p = await getProfile()
    return !p.coachNotes || p.coachNotes.length === 0
  } catch {
    return true
  }
}

// ==================== 环境改造动作（点击真实写 settings 生效） ====================

function pad2(n: number): string { return String(n).padStart(2, '0') }
function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
function fmtYuan(minor: number): string {
  return (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}
/** 明日额度：取日均预算（四舍五入到10元，最低¥10），与行为教练动作一致 */
async function tomorrowAllowanceMinor(): Promise<number> {
  const raw = await getSetting('monthlyBudget')
  const budget = typeof raw === 'number' && raw > 0 ? raw : 1000_00
  const now = new Date()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const txs = await db.transactions.toArray()
  const mk = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`
  const spent = txs.reduce((s, t) => {
    if (t.txType === 'income' || t.note === '储蓄转入') return s
    const d = new Date(t.time)
    if (`${d.getFullYear()}-${pad2(d.getMonth() + 1)}` !== mk) return s
    return s + t.amountMinor
  }, 0)
  const remaining = budget - spent
  const daysLeft = Math.max(1, daysInMonth - now.getDate())
  return Math.max(1000, Math.round(Math.max(0, remaining) / daysLeft / 100) * 100)
}

export interface CoachEnvAction {
  id: 'late_night_lock' | 'freeze_until' | 'daily_limit' | 'platform_limit'
  label: string
  description: string
  apply: (platform?: string) => Promise<string>
}

const lateNightLock: CoachEnvAction = {
  id: 'late_night_lock',
  label: '🔒 开启深夜锁',
  description: '之后 22:00-06:00 的购物类记账会先弹一次确认，冷静一下再决定',
  async apply() {
    await setSetting('nightLock', 'true')
    return '已开启深夜锁：之后 22:00-06:00 的购物类记账会先弹一次确认。'
  },
}

const freezeUntil: CoachEnvAction = {
  id: 'freeze_until',
  label: '🧊 冻结非必要支出3天',
  description: '冻结购物/娱乐/虚拟消费 3 天，期间这类记账会弹确认',
  async apply() {
    const until = new Date()
    until.setDate(until.getDate() + 3)
    await setSetting('freezeNonEssential', 'true')
    await setSetting('freezeNonEssentialUntil', dateKeyOf(until))
    return `已开启冻结：到 ${dateKeyOf(until)} 前，购物/娱乐/虚拟消费记账会收到确认提醒。`
  },
}

const dailyLimit: CoachEnvAction = {
  id: 'daily_limit',
  label: '📉 设置明日额度',
  description: '把明天可花额度设为日均预算，明日预算卡会显示新额度',
  async apply() {
    const amountMinor = await tomorrowAllowanceMinor()
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    await setSetting('dailyLimitOverride', JSON.stringify({ amountMinor, date: dateKeyOf(tomorrow) }))
    return `明日消费额度已设为 ¥${fmtYuan(amountMinor)}（= 你的日均预算），明天首页预算卡会显示。`
  },
}

const platformLimit: CoachEnvAction = {
  id: 'platform_limit',
  label: '🎯 设置平台限额',
  description: '给高频平台设一个每日消费限额，超限记账会弹确认',
  async apply(platform) {
    const p = platform ?? null
    if (!p) return '需要先确认是哪个平台，才能设置限额。'
    const amountMinor = await tomorrowAllowanceMinor()
    const raw = await getSetting('platformLimit')
    let list: { platform: string; amountMinor: number }[] = []
    if (typeof raw === 'string' && raw) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          list = parsed.filter((x): x is { platform: string; amountMinor: number } =>
            x && typeof x.platform === 'string' && typeof x.amountMinor === 'number')
        }
      } catch { /* 忽略损坏数据 */ }
    }
    const exist = list.findIndex(x => x.platform === p)
    if (exist >= 0) list[exist] = { platform: p, amountMinor }
    else list.push({ platform: p, amountMinor })
    await setSetting('platformLimit', JSON.stringify(list))
    return `已为 ${p} 设置每日限额 ¥${fmtYuan(amountMinor)}：超限记账时会弹确认。`
  },
}

export const COACH_ENV_ACTIONS: CoachEnvAction[] = [lateNightLock, freezeUntil, dailyLimit, platformLimit]

/** 按 id 执行环境改造动作（AI 助手 / 报告页点击 data-action="env:xxx" 时调用） */
export async function applyCoachEnvAction(
  action: string,
  platform?: string
): Promise<{ ok: boolean; message: string }> {
  const found = COACH_ENV_ACTIONS.find(a => a.id === action)
  if (!found) return { ok: false, message: `未知环境改造动作：${action}` }
  try {
    const message = await found.apply(platform)
    window.dispatchEvent(new CustomEvent('dashboard-refresh'))
    return { ok: true, message }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

// ==================== 复盘收尾存档 ====================
// 收尾存档由 AI 在对话中通过 save_behavior_notes 工具完成（写入 behavior_profiles.coachNotes，
// 下次复盘开场 get_behavior_profile 会带出这些笔记供引用"上次你说…"）。

// ==================== 复盘对话初始化（供 AI 助手 / 报告页组装首轮） ====================

/**
 * 组装复盘首轮 ChatMessage 数组：
 * - system：角色 + 画像快照（含历次复盘笔记）+ 首次建档标记
 * - user：首次建档 → 开场指令；老用户 → 由 AI 自己开场（发一条轻量开场）
 * 返回 messages 供 runCoachTurn 使用。
 */
export async function buildCoachMessages(input: {
  text?: string | null
  history?: { role: 'user' | 'ai'; content: string }[]
}): Promise<{ messages: ChatMessage[]; isFirst: boolean; snapshot: string }> {
  const [profile, events] = await Promise.all([
    getProfile(),
    db.consumerEvents.toArray(),
  ])
  const d30 = events.filter(e => Date.now() - new Date(e.time).getTime() <= 30 * 86_400_000).length
  const snapshot = profileContextText(profile, d30)
  const isFirst = isFirstCoachingOnProfile(profile)

  const history = (input.history ?? []).slice(-20).map(h => ({
    role: h.role === 'ai' ? 'assistant' as const : 'user' as const,
    content: h.content,
  }))

  const messages: ChatMessage[] = [
    { role: 'system', content: buildCoachSystemPrompt(snapshot, isFirst) },
    ...history,
  ]

  // 首次建档：AI 主动开场（先查数据 → 基于发现提问）
  if (isFirst && !input.text) {
    messages.push({
      role: 'user',
      content:
        '请开始我们的第一次认知复盘：先调用工具查看我已有的真实数据，' +
        '然后基于你看到的数据向我提问了解情况（不要用固定的问卷问题）。' +
        '如果数据很少，请诚实告诉我记了多少笔，再问几个问题了解我。',
    })
  } else if (input.text) {
    messages.push({ role: 'user', content: input.text })
  }
  return { messages, isFirst, snapshot }
}

/** 基于画像对象判定是否首次（无 coachNotes 或为空） */
function isFirstCoachingOnProfile(p: { coachNotes?: unknown[] }): boolean {
  return !p.coachNotes || p.coachNotes.length === 0
}

/**
 * 组装"报告页交互式复盘"首轮 ChatMessage 数组：
 * - system：角色 + 【报告实时数据快照】（报告页代码从数据库算好的数字）+ 画像/历次复盘存档
 * - user：无 text 时让 AI 基于报告数据开场复盘（先观察 → 提问 → 逐层深入 → 建议 → 存档）
 * 报告页与 AI 助手窗口通过 coachNotes 互通：本对话里 save_behavior_notes 存档的要点，
 * 下次在 AI 助手复盘时会被 get_behavior_profile 带出并引用"上次你说…"。
 */
export async function buildReportReviewMessages(input: {
  reportLabel: string
  reportSnapshot: string
  history?: { role: 'user' | 'ai'; content: string }[]
  text?: string | null
}): Promise<{ messages: ChatMessage[]; isFirst: boolean }> {
  const [profile, events] = await Promise.all([
    getProfile(),
    db.consumerEvents.toArray(),
  ])
  const d30 = events.filter(e => Date.now() - new Date(e.time).getTime() <= 30 * 86_400_000).length
  const profileSnap = profileContextText(profile, d30)
  const isFirst = isFirstCoachingOnProfile(profile)
  const snapshot =
    `【${input.reportLabel}报告数据】（由本地代码从数据库实时算出，必须引用其中的数字，禁止编造）：\n${input.reportSnapshot}\n\n` +
    `【你的消费画像与历次复盘存档】（供引用"上次你说…"）\n${profileSnap}`

  const history = (input.history ?? []).slice(-20).map(h => ({
    role: h.role === 'ai' ? 'assistant' as const : 'user' as const,
    content: h.content,
  }))

  const messages: ChatMessage[] = [
    { role: 'system', content: buildCoachSystemPrompt(snapshot, isFirst) },
    ...history,
  ]

  if (input.text) {
    messages.push({ role: 'user', content: input.text })
  } else {
    messages.push({
      role: 'user',
      content:
        `这是刚生成的${input.reportLabel}报告，请基于上面这份报告数据开始复盘：` +
        `先给出 2~3 条带真实数字的数据观察，再向我提出 1~2 个具体问题；` +
        `然后根据我的回答一层层深入（数据→模式→动机/认知→建议）；` +
        `最后给出"下次怎么做"的可执行建议（引用报告里的真实数字作为出处），` +
        `并调用 save_behavior_notes 把本次对话要点存档。`,
    })
  }
  return { messages, isFirst }
}

export { hasApiKey }

// ==================== F5 购买反馈引擎（11 步循环 + 交互式反馈卡 + 效果回查 + 正面强化 + 7.7 高频窗口） ====================
// 原则（F5 7.1）：
//   - 不预设规则/模板/问题；先动脑→再动手→再动脑→最后行动
//   - 所有数字由本地代码算（本文件里的判定/统计全部代码执行），AI 只组织语言
//   - 知识库是"图书馆"不是"触发器"（检索在推理之后，靠 search_knowledge 工具翻）
//   - 反馈只针对两类对象（F5 7.4）：
//       对象A：欲望清单犹豫≥14天 或 反复进出≥2次，最终仍购买（代码在 scanWishlistCandidates 判定）
//       对象B：AI 判定冲动高 且 用户在对话中明确承认陷阱（由 AI 在对话里调 queue_feedback_card 标记）
//   - 隐私分层（确认版）：本引擎一律走 档2 脱敏单笔（商户/平台/备注脱敏，金额/时间/类别保留）
//   - 防幻觉：输出前 collectFacts 比对（L2）+ guardKnowledgeDiscipline 知识断言比对（L4）

import { agentCompletion, hasApiKey } from './deepseek'
import type { ChatMessage, ToolCall } from './deepseek'
import { AGENT_TOOLS, AGENT_TOOL_DEFS, COACH_TOOL_NAMES } from './tools'
import { db } from '../db/database'
import {
  getAllWishlistItems, getAllConsumerEvents,
  addAgentInboxItem, getAllAgentInboxItems,
  getAllFeedbackLogs, updateFeedbackLog, getSetting,
} from '../db/crud'
import { getKnowledgeRef, guardKnowledgeDiscipline } from './knowledge'
import type { KnowledgeGuardIssue } from './knowledge'
import { FACT_DISCIPLINE, FACT_GUARD_HINT, PRIVACY_HINT, FEEDBACK_DISCIPLINE } from './factDiscipline'
import { collectFacts, applyUncertaintyMarks } from '../utils/factGuard'
import type { WishlistItem, AgentInboxItem, PrivacyTier } from '../types'

const DAY = 86_400_000
const WEEK = 7 * DAY
const EFFECT_CHECK_DAYS = 14 // ⑩：反馈 2 周后回查
const EFFECT_THRESHOLD = 0.8 // ⑩：下降 ≥20%（after ≤ before×0.8）→ effective
const MAX_GEN_ROUNDS = 8 // ③：深挖补查上限 8 次
const MAX_TURN_TOOL_ROUNDS = 3 // 每轮对话内工具往返上限（卡片总轮数由 UI 按 4 轮控制）
const FEEDBACK_TIER: PrivacyTier = 2 // 档2 脱敏单笔（反馈/引用场景）

// ==================== 工具执行（统一 ctx=档2） ====================

function parseToolArgs(tc: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tc.function.arguments || '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 执行单次工具调用（限 COACH 子集；一律走 档2 脱敏单笔） */
async function execTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!COACH_TOOL_NAMES.includes(name)) throw new Error(`AI 助手无权调用该工具：${name}`)
  const tool = AGENT_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`未知工具：${name}`)
  return tool.execute(args, { privacyTier: FEEDBACK_TIER })
}

// ==================== ① 观察 / 对象A 扫描（代码判定，F5 7.4） ====================

export interface WishlistCandidate {
  item: WishlistItem
  /** 犹豫天数（加入→确认购买，代码计算） */
  daysHesitated: number
  /** 是否反复进出（冷静期延长 ≥2 次） */
  extended: boolean
  reason: string
}

/**
 * 对象A：欲望清单"犹豫≥14天 或 反复进出≥2次，最终仍购买"。
 * 判定阈值来自 F5 7.4 原文（非本代码自定），全部由代码从 wishlist 表计算。
 */
export async function scanWishlistCandidates(): Promise<WishlistCandidate[]> {
  const items = await getAllWishlistItems()
  const now = Date.now()
  const candidates: WishlistCandidate[] = []
  for (const item of items) {
    if (item.status !== 'confirmed' || !item.boughtAt) continue
    const added = new Date(item.addedAt).getTime()
    const bought = new Date(item.boughtAt).getTime()
    const daysHesitated = Math.round((bought - added) / DAY)
    const extended = (item.extendCount ?? 0) >= 2
    const reason = daysHesitated >= 14
      ? `犹豫了 ${daysHesitated} 天最终还是买了`
      : extended
        ? `反复进出清单 ${item.extendCount ?? 0} 次最终还是买了`
        : null
    if (reason && bought <= now) candidates.push({ item, daysHesitated, extended, reason })
  }
  return candidates.sort((a, b) => b.daysHesitated - a.daysHesitated)
}

// ==================== ⑥⑨ 反馈卡生成（11 步 ①-⑥⑨，AI 工具循环） ====================

/** 生成反馈卡的系统提示：编码 11 步（观察→推理→深挖→假设→检索→开场）+ 对象判定 + 档2 隐私 + 防幻觉 */
function buildGenSystemPrompt(kind: 'objectA' | 'positive'): string {
  const mode = kind === 'positive'
    ? '【本次是正面反馈】只陈述观察 + 肯定这份进步 + 一个开放问题，不评判不说教；queue_feedback_card 的 type 传 positive'
    : '【本次是对象A反馈】按下方上下文处理该候选；queue_feedback_card 的 type 默认 negative'
  return `你是「Financial Habit」的反馈生成器。你的任务不是下结论，而是把一次"值得回顾的消费经历"做成一张明天早上 9 点展示的反馈卡。
${mode}

【工作流程（11 步精简为可执行循环，必须按顺序推进）】
① 观察：先调用查询工具看真实数据（get_recent_transactions / get_spending_pattern / get_alert_events / get_behavior_profile）
② 推理：在心里自问自答——这笔消费的模式是什么？我看到了什么，还没看到什么？
③ 深挖：数据不够就继续补查（get_recent_transactions 指定分类/平台等），最多 8 次工具调用
④ 形成假设：一个可被用户验证的假设（"可能…？"），不是结论
⑤ 检索知识库：调用 search_knowledge 把假设语境输入，翻出最相关的概念（图书馆自己选书，不是关键词触发器）
⑥ 生成开场：只做两件事——(1) 一个数据观察（引用真实数字，如"你犹豫了 17 天，最后还是买了"）；(2) 一个开放问题。禁止给结论、禁止科普、禁止说教
⑨ 入队：调用 queue_feedback_card 把这张卡入队（标题/开场/假设/模式标识/反馈前金额等全部来自上面的真实数据；knowledgeRefId 用⑤命中的条目）

【必须遵守】
- 数字纪律：所有金额/天数/笔数必须来自工具返回的真实数据，严禁编造；看不到就说看不到
- 隐私（档2）：你看到商户名时它们已经是"某商户/某平台"（被脱敏），引用时用"金额+时间+类别"（如"深夜那笔 ¥128"），不要试图还原商户名
- 知识库是图书馆：先推理后检索，禁止"数据里出现关键词就套模板"
- 只针对反馈对象生成，其余情况直接结束（不调用 queue_feedback_card）
- 反馈前金额 beforeMinor 用该模式近 30 天的真实支出合计（分），由你在工具数据里算出来，必须是真实数字
${FACT_DISCIPLINE}
${PRIVACY_HINT}
${FACT_GUARD_HINT}`
}

export interface GenerateFeedbackResult {
  queued: boolean
  inboxId?: string
  logId?: string
  title?: string
  opening?: string
  reason?: string
  error?: string
}

/**
 * 为一笔候选生成反馈卡（对象A / 正面强化共用）。
 * AI 在工具循环内自主调用 queue_feedback_card 入队；代码强制周上限 3 条（queue_feedback_card 内部）。
 */
export async function generateFeedbackCard(
  kind: 'objectA' | 'positive',
  context: string
): Promise<GenerateFeedbackResult> {
  if (!hasApiKey()) return { queued: false, reason: 'no_api_key', error: '未配置 AI 模型' }
  const messages: ChatMessage[] = [
    { role: 'system', content: buildGenSystemPrompt(kind) },
    { role: 'user', content: `请处理以下候选：\n${context}\n\n（先查数据再动笔；无需确认，按流程直接完成 ①→⑨）` },
  ]
  try {
    for (let round = 0; round < MAX_GEN_ROUNDS; round++) {
      const turn = await agentCompletion(messages, AGENT_TOOL_DEFS, { temperature: 0.5 })
      if (!turn.toolCalls || turn.toolCalls.length === 0) break
      messages.push({ role: 'assistant', content: turn.content, tool_calls: turn.toolCalls })
      for (const tc of turn.toolCalls) {
        const result = await execTool(tc.function.name, parseToolArgs(tc))
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
      }
    }
    // 收尾：结果里若入队成功 → 返回入队信息
    const queueMsg = [...messages].find(m => {
      if (m.role !== 'tool') return false
      try {
        const parsed = JSON.parse(String(m.content)) as { queued?: boolean; inboxId?: string; logId?: string; title?: string; opening?: string }
        return parsed?.queued === true
      } catch {
        return false
      }
    })
    if (!queueMsg) return { queued: false, reason: 'not_queued', error: 'AI 未入队反馈卡' }
    const parsed = JSON.parse(String(queueMsg.content)) as { inboxId?: string; logId?: string; title?: string; opening?: string }
    return { queued: true, ...parsed }
  } catch (e) {
    return { queued: false, reason: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}

// ==================== ⑦⑧ 反馈卡交互轮（F5 7.5，先问→听→分析） ====================

/** 卡片对话可用的工具（去除 queue_feedback_card：对话中不再创建新卡；保留查询/检索/存档） */
const TURN_TOOL_DEFS = AGENT_TOOL_DEFS.filter(t => t.function.name !== 'queue_feedback_card' && COACH_TOOL_NAMES.includes(t.function.name))

function buildTurnSystemPrompt(item: AgentInboxItem, knowledgeText: string, round: number, maxRounds: number): string {
  const prevUserHint = '上一条用户消息就是 ta 的回答，必须引用 ta 的原话/原意来展开，不许自说自话'
  return `你是「Financial Habit」的 AI 助手，正在和用户进行一张"购买反馈卡「${item.title}」"的对话（已进行 ${round}/${maxRounds} 轮）。
背景：这张卡源于一条真实消费经历。开场已由上一轮给出，你要延续对话。

【规则】
- 先回应用户刚说的话（${prevUserHint}），再补充针对性分析；绝不跳过用户回答直接讲自己的
- 不预设模板：每轮都要基于用户这次的回答内容来组织，不重复开场
- 用户答"不知道/没想过"→ 换一个更轻、更具体的问题，不逼问、不评判
- 科普概念必须大白话、且必须挂到用户自己说过的内容上（FEEDBACK_DISCIPLINE）；出处（citation）只放进「了解更多」折叠区（用 <details><summary>了解更多</summary>…</details>）
- 每轮结尾给 1 个具体动作按钮；需要用户点选/回答的按钮统一输出为 <button data-action="ask:用户可见的文字">用户可见的文字</button>（点击后会把"ask:"后面的文字当作用户的回答继续对话）；每轮最多 3 个
- 不直接下结论、不说教；语气温和
- 数字只引用工具返回的真实值，禁止编造金额/笔数/商户
- 用户回答中有价值的自我认知，调用 save_behavior_notes 存档（dataRef 只能写真实出现的数字）

【本轮可用的知识支撑（供科普，勿照抄）】
${knowledgeText || '（无）'}
${FEEDBACK_DISCIPLINE}
${FACT_DISCIPLINE}
${PRIVACY_HINT}
${FACT_GUARD_HINT}`
}

export interface FeedbackTurnResult {
  html: string
  guardIssues: KnowledgeGuardIssue[]
}

/**
 * 反馈卡单轮交互（F5 7.5）：
 * - history：已有对话消息（含开场 AI 消息与之前轮次）
 * - userReply：用户本轮回答
 * - round：当前轮次（1 起）；maxRounds=4 由 UI 控制是否结束
 * - 返回 HTML + 知识纪律核查结果（citation_leak / unknown_concept）
 */
export async function runFeedbackTurn(opts: {
  item: AgentInboxItem
  history: ChatMessage[]
  userReply: string
  round: number
  maxRounds?: number
}): Promise<FeedbackTurnResult> {
  const { item, history, userReply, round } = opts
  const maxRounds = opts.maxRounds ?? 4
  let knowledgeText = ''
  if (item.knowledgeRefId) {
    const ref = await getKnowledgeRef(item.knowledgeRefId)
    if (ref) {
      knowledgeText = `- 概念：${ref.concept}\n- 人话科普：${ref.plain_explanation}\n- 动作模板：${ref.action_templates.join('；')}\n- 出处（仅折叠区）：${ref.citation}`
    }
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: buildTurnSystemPrompt(item, knowledgeText, round, maxRounds) },
    ...history,
    { role: 'user', content: userReply },
  ]
  const toolResults: unknown[] = []
  let reply = ''
  for (let r = 0; r < MAX_TURN_TOOL_ROUNDS; r++) {
    const turn = await agentCompletion(messages, TURN_TOOL_DEFS, { temperature: 0.5 })
    if (!turn.toolCalls || turn.toolCalls.length === 0) {
      reply = turn.content ?? ''
      break
    }
    messages.push({ role: 'assistant', content: turn.content, tool_calls: turn.toolCalls })
    for (const tc of turn.toolCalls) {
      let result: unknown
      try {
        result = await execTool(tc.function.name, parseToolArgs(tc))
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) }
      }
      if (!(result as { error?: string })?.error) toolResults.push(result)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
    }
  }
  if (!reply) reply = 'AI 助手正在整理思路，请再说一次好吗？'
  // 防幻觉 L2：与工具返回的真实数据比对，存疑处标注「⚠ 未核实」
  const marked = applyUncertaintyMarks(reply, collectFacts(toolResults)).html
  // 防幻觉 L4：知识断言比对（citation 是否泄露进正文 / 引用未激活概念）
  let guardIssues: KnowledgeGuardIssue[] = []
  if (item.knowledgeRefId) {
    const ref = await getKnowledgeRef(item.knowledgeRefId)
    if (ref) guardIssues = guardKnowledgeDiscipline(marked, [ref])
  }
  return { html: marked, guardIssues }
}

// ==================== ⑩ 效果回查（2 周后对比，数字全由代码算） ====================

/**
 * 模式金额的确定性计算（⑩ 前后对比用）。
 * patternKey → 交易数据的确定性映射；无法确定性计算的模式返回 null（跳过，绝不编造）。
 */
export async function computePatternAmountMinor(patternKey: string, days: number): Promise<number | null> {
  const now = Date.now()
  const cutoff = now - days * DAY
  const txs = await db.transactions.toArray()
  const exp = txs.filter(t => {
    if (t.txType === 'income' || t.note === '储蓄转入') return false
    const ts = new Date(t.time).getTime()
    return ts <= now && ts >= cutoff
  })
  const isShop = (c: string) => ['购物', '娱乐', '虚拟消费'].includes(c)
  const isDeepNightHour = (h: number) => h >= 22 || h < 6
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const dateKey = (iso: string) => {
    const d = new Date(iso)
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  }
  const platformOf = (m: string): string | null => {
    const known = ['拼多多', '京东', '淘宝', '抖音', '美团', '淘宝闪购', '饿了么', '天猫']
    return known.find(p => m.includes(p)) ?? null
  }

  if (patternKey === '深夜购物') {
    const night = exp.filter(t => isShop(t.category) && isDeepNightHour(new Date(t.time).getHours()))
    return night.reduce((s, t) => s + t.amountMinor, 0)
  }
  if (patternKey === '重复购买') {
    const map = new Map<string, number>()
    for (const t of exp) if (t.merchant) map.set(t.merchant, (map.get(t.merchant) ?? 0) + t.amountMinor)
    return [...map.entries()].filter(([, amt]) => amt > 0).reduce((s, [, amt]) => s + amt, 0)
  }
  if (patternKey === '同平台爆发') {
    const groups = new Map<string, number>()
    for (const t of exp) {
      if (!isShop(t.category)) continue
      const p = platformOf(t.merchant)
      if (!p) continue
      const key = `${dateKey(t.time)}|${p}`
      groups.set(key, (groups.get(key) ?? 0) + t.amountMinor)
    }
    return [...groups.values()].reduce((s, v) => s + v, 0)
  }
  if (patternKey === '预算超限') {
    return exp.reduce((s, t) => s + t.amountMinor, 0)
  }
  return null // 无确定性映射 → 跳过回查（防编造）
}

export interface EffectCheckResult {
  logId: string
  patternKey: string
  beforeMinor: number
  afterMinor: number
  effective: boolean
}

/** ⑩：对所有已满 14 天且未回查的反馈做前后对比；下降≥20%（after≤before×0.8）→ effective */
export async function runEffectCheck(): Promise<EffectCheckResult[]> {
  const logs = await getAllFeedbackLogs()
  const due = logs.filter(l => !l.effectStatus && l.createdAt && nowMinus(l.createdAt) >= EFFECT_CHECK_DAYS)
  const results: EffectCheckResult[] = []
  for (const l of due) {
    if (!l.patternKey) continue
    const afterMinor = await computePatternAmountMinor(l.patternKey, EFFECT_CHECK_DAYS)
    if (afterMinor === null) continue // 无法确定性计算 → 跳过（不编造）
    const effective = l.beforeMinor > 0 && afterMinor <= l.beforeMinor * EFFECT_THRESHOLD
    await updateFeedbackLog(l.id, {
      afterMinor,
      effectStatus: effective ? 'effective' : 'ineffective',
      effectCheckedAt: new Date().toISOString(),
    })
    results.push({ logId: l.id, patternKey: l.patternKey, beforeMinor: l.beforeMinor, afterMinor, effective })
  }
  return results
}

function nowMinus(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / DAY
}

// ==================== ⑪ 正面强化识别（进步也生成正面反馈） ====================

export interface PositiveStreak {
  /** 近 7 天冲动笔数 */
  now7: number
  /** 前 7 天冲动笔数 */
  prev7: number
  /** 下降幅度（0~1） */
  dropPct: number
  /** 供 AI 组织的上下文 */
  context: string
}

/** ⑪：代码检测"冲动笔数较上周明显下降"的进步（相对比较，非绝对阈值硬编码） */
export async function scanPositiveStreaks(): Promise<PositiveStreak[]> {
  const events = await getAllConsumerEvents()
  const now = Date.now()
  const inWindow = (t: string, start: number, end: number) => {
    const ts = new Date(t).getTime()
    return ts >= start && ts < end
  }
  const curStart = now - WEEK
  const prevStart = now - 2 * WEEK
  const now7 = events.filter(e => e.isImpulse && inWindow(e.time, curStart, now)).length
  const prev7 = events.filter(e => e.isImpulse && inWindow(e.time, prevStart, curStart)).length
  if (prev7 < 3 || now7 >= prev7) return [] // 前 7 天样本太少或没有下降 → 不打扰
  const dropPct = 1 - now7 / prev7
  if (dropPct < 0.2) return [] // 下降不足 20% 不算明显进步
  return [{
    now7,
    prev7,
    dropPct,
    context: `近 7 天冲动消费 ${now7} 笔，比前 7 天（${prev7} 笔）下降 ${Math.round(dropPct * 100)}%。请基于这个真实对比生成一张"正面反馈卡"（type=positive）：只陈述观察 + 肯定这份进步 + 一个开放问题，不评判不说教。`,
  }]
}

// ==================== 7.7 高频冲动窗口分析（代码统计，写入 settings 真实生效） ====================

export interface ImpulseWindowCandidate {
  /** 2h 桶起始小时 */
  start: number
  end: number
  label: string
  count: number
  /** 占全部冲动笔数比例（%），代码计算 */
  pct: number
  /** 相对均匀分布的密度比（占比 ÷ 1/12），≥2 视为显著集中 */
  density: number
}

/**
 * 7.7：分析近 30 天冲动消费的时段分布（2h 桶），找出"显著高频"窗口。
 * 显著性用相对统计（密度比=该桶占比÷均匀占比 1/12），并设最小样本（≥3 笔）防单笔偶然；
 * 不依赖绝对值阈值硬编码判断。已锁定（nightLock 覆盖）或已在队列中的窗口跳过，避免重复打扰。
 */
export async function analyzeImpulseWindows(): Promise<ImpulseWindowCandidate[]> {
  const now = Date.now()
  const cutoff = now - 30 * DAY
  const events = (await getAllConsumerEvents()).filter(e => e.isImpulse && new Date(e.time).getTime() >= cutoff)
  if (events.length < 5) return [] // 样本过少不做判断

  const buckets = new Map<number, number>()
  for (const e of events) {
    const h = Math.floor(new Date(e.time).getHours() / 2) * 2
    buckets.set(h, (buckets.get(h) ?? 0) + 1)
  }
  const uniform = 1 / 12 // 12 个 2h 桶的均匀占比
  const candidates: ImpulseWindowCandidate[] = []
  for (const [start, count] of buckets) {
    if (count < 3) continue // 最小样本：防单笔偶然
    const pct = count / events.length
    const density = pct / uniform
    if (density < 2) continue // 显著集中：密度比 ≥2（占比是均匀水平的 2 倍以上）
    candidates.push({ start, end: Math.min(24, start + 2), label: `${pad2(start)}:00-${pad2((start + 2) % 24)}:00`, count, pct: Math.round(pct * 100), density: Math.round(density * 10) / 10 })
  }
  if (candidates.length === 0) return []

  // 去重：已被深夜锁覆盖 或 已在队列 pending
  const [nightLockRaw, inbox] = await Promise.all([getSetting('nightLock'), getAllAgentInboxItems()])
  const nightLock = nightLockRaw === 'true'
  const pendingWindows = new Set(
    inbox.filter(i => i.kind === 'impulse_window' && i.status === 'pending').map(i => i.objectId)
  )
  return candidates.filter(c => {
    if (nightLock) return false // 已开启深夜锁（22-6）覆盖大多数深夜桶
    if (pendingWindows.has(`${c.start}-${c.end}`)) return false
    return true
  })
}

/** 7.7：有必要时入队"高频冲动窗口提醒"（次日 09:00 展示；UI 接受后写 settings 生效） */
export async function queueImpulseWindowReminder(candidate: ImpulseWindowCandidate): Promise<boolean> {
  const pending = (await getAllAgentInboxItems()).some(
    i => i.kind === 'impulse_window' && i.status === 'pending' && i.objectId === `${candidate.start}-${candidate.end}`
  )
  if (pending) return false
  const now = new Date()
  const scheduledAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0).toISOString()
  const opening =
    `你的冲动消费有 ${candidate.count} 笔（近 30 天占比 ${candidate.pct}%）集中在 ${candidate.label}，` +
    `明显高于其他时段。要不要在那个时段加一道"冷静确认"？可以接受提醒、手动改时间，或直接忽略。`
  await addAgentInboxItem({
    kind: 'impulse_window',
    objectType: 'window',
    objectId: `${candidate.start}-${candidate.end}`,
    title: `高频冲动窗口：${candidate.label}`,
    opening,
    knowledgeRefId: null,
    feedbackLogId: null,
    scheduledAt,
    status: 'pending',
    rounds: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })
  return true
}

// ==================== 主入口：每日扫描 ====================

export interface FeedbackScanSummary {
  effectResults: EffectCheckResult[]
  generated: GenerateFeedbackResult[]
  windowQueued: boolean
  windowCandidate?: ImpulseWindowCandidate
  skippedNoData: boolean
}

/**
 * F5 每日扫描（一次调用，全部步骤）：
 * ⑩ 效果回查 → ①-⑥⑨ 对象A 反馈卡生成 → ⑪ 正面强化 → 7.7 高频窗口提醒
 * 由 UI 在每日首次进入首页时调用（外部队列+频率控制）。
 */
export async function runFeedbackScan(): Promise<FeedbackScanSummary> {
  // ⑩ 效果回查（纯代码）
  const effectResults = await runEffectCheck()

  // ①-⑥⑨ 对象A（AI 生成，周上限由 queue_feedback_card 代码强制）
  const candidates = await scanWishlistCandidates()
  const generated: GenerateFeedbackResult[] = []
  // 只对"还没为它生成过反馈卡"的候选生成（避免每周重复打扰同一对象）
  const logs = await getAllFeedbackLogs()
  const alreadyQueued = new Set(logs.filter(l => l.objectType === 'wishlist').map(l => l.objectId))
  for (const c of candidates) {
    if (alreadyQueued.has(c.item.id)) continue
    if (generated.some(g => g.queued)) break // 每周最多推进 1 张对象A 卡（配合周上限 3）
    const res = await generateFeedbackCard('objectA',
      `【对象A · 犹豫后购买】物品「${c.item.name}」（¥${(c.item.priceMinor / 100).toFixed(2)}）加入欲望清单 ${c.item.addedAt.slice(0, 10)}，${c.item.boughtAt!.slice(0, 10)} 确认购买。\n判定依据：${c.reason}。\n请按流程：① 查真实消费数据 → ⑤ 检索知识库 → ⑥ 开场 → ⑨ 入队。`)
    generated.push(res)
    if (res.queued) break
  }

  // ⑪ 正面强化（每周最多 1 张；依赖上面的 AI 生成流程）
  if (!generated.some(g => g.queued)) {
    const streaks = await scanPositiveStreaks()
    if (streaks.length > 0) {
      const res = await generateFeedbackCard('positive', streaks[0].context)
      generated.push(res)
    }
  }

  // 7.7 高频冲动窗口
  let windowQueued = false
  let windowCandidate: ImpulseWindowCandidate | undefined
  const windows = await analyzeImpulseWindows()
  if (windows.length > 0) {
    windowCandidate = windows[0]
    windowQueued = await queueImpulseWindowReminder(windows[0])
  }

  return {
    effectResults,
    generated,
    windowQueued,
    windowCandidate,
    skippedNoData: candidates.length === 0 && !windowQueued,
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

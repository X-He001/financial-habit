// ==================== 欲望清单「对话式智能体」引擎 ====================
// 核心原则：
//  1. 数字全部由本地代码从数据库算出（facts + 工具），AI 只负责"聊天 + 组织语言 + 决策"
//  2. 每个商品一个对话线程（wishlistChats 表），AI 记得之前聊过什么
//  3. 单轮对话最多 5 次工具调用；上下文截断早期消息，控制长度
//  4. AI 自主判断何时收尾，动态生成 JSON 总结（前端渲染雷达图/指数条/标签/建议卡）

import { db } from '../db/database'
import { getSetting, getAllSavingsGoals } from '../db/crud'
import { agentCompletion, chatCompletion } from '../api/deepseek'
import type { ChatMessage, ChatTool, ToolCall } from '../api/deepseek'
import { incrementAiCount } from '../utils/aiUsage'
import { isImpulsive, platformOf } from '../utils/impulseEngine'
import type { Transaction, WishlistChatMsg, WishlistChatSummary, WishlistItem } from '../types'

// ==================== 常量 ====================

const BUDGET_KEY = 'monthlyBudget'
const DEFAULT_BUDGET = 1000_00
const DAY = 86_400_000
/** 单轮对话最多工具调用次数（防死循环） */
const MAX_TOOL_CALLS = 5
/** 送入 API 的历史消息条数上限（截断早期消息） */
const MAX_HISTORY_MSGS = 24
/** 总结 JSON 标记（AI 收尾时输出） */
const SUMMARY_MARKER = '[[SUMMARY_JSON]]'

/** 7 个冲动分析维度（AI 按此输出，雷达图固定 7 轴） */
export const DIMENSION_LABELS = ['需求真实度', '情绪驱动', '场景迫切', '预算承受', '替代可行', '时间沉淀', '后悔风险']

// ==================== 工具函数 ====================

function pad2(n: number): string { return String(n).padStart(2, '0') }
function monthKey(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}` }
function yuan(minor: number): number { return Math.round((minor / 100) * 100) / 100 }
function round2(n: number): number { return Math.round(n * 100) / 100 }
function isIncome(t: { txType?: string }): boolean { return t.txType === 'income' }
function isTransfer(t: { note?: string }): boolean { return t.note === '储蓄转入' }
function isExpense(t: { txType?: string; note?: string }): boolean { return !isIncome(t) && !isTransfer(t) }
function fmtTime(iso: string): string {
  const d = new Date(iso)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
function slotOf(h: number): string {
  if (h < 6) return '凌晨'
  if (h < 12) return '上午'
  if (h < 18) return '下午'
  if (h < 22) return '晚上'
  return '深夜'
}

/** 从商品名推断所属消费分类（同类匹配用） */
export function classifyCategory(name: string): string {
  const rules: Array<[RegExp, string]> = [
    [/盲盒|手办|游戏|抽卡|扭蛋|玩偶|玩具|电玩|卡牌|周边|影票|电影|演出|KTV|桌游|娱乐/, '娱乐'],
    [/零食|奶茶|咖啡|外卖|甜点|蛋糕|饮料|火锅|烧烤|夜宵|好吃/, '餐饮'],
    [/衣服|鞋|包|帽|首饰|配饰|化妆|护肤|面膜|口红|香水|美妆|数码|手机|耳机|键盘|充电器|电器/, '购物'],
    [/会员|订阅|课程|视频|音乐|软件|App|点券|云盘|加速器|虚拟/, '虚拟消费'],
    [/纸巾|清洁|洗衣|收纳|家居|床品|厨具|水杯|日用/, '日用百货'],
    [/车票|打车|加油|地铁|机票/, '交通'],
  ]
  for (const [re, cat] of rules) if (re.test(name)) return cat
  return '购物'
}

/** 从商品名提取关键词（用于商家名模糊匹配），最多 3 个 */
export function nameKeywords(name: string): string[] {
  const tokens = name
    .replace(/¥[\d.,]+/g, ' ')
    .split(/[\s、，,。:：\-（）()【】[\]/\d]+/)
    .filter(s => s.length >= 2)
  return [...new Set(tokens)].slice(0, 3)
}

// ==================== 财务 facts（每轮对话注入，本地计算） ====================

export interface WishlistFacts {
  item: {
    name: string
    priceYuan: number
    /** 来源：冲动拦截（被预警拦下放入清单） / 手动添加 */
    source: string
    coolingDays: number
    coolingHoursLeft: number
  }
  profile: {
    monthBudgetYuan: number
    monthSpentYuan: number
    monthRemainingYuan: number
    dailyAllowanceYuan: number
    expense30Yuan: number
    impulse30Count: number
    /** 近90天同类消费（按商品关键词模糊匹配分类） */
    similar90Count: number
    similar90TotalYuan: number
    /** 最近 5 条消费记录（脱敏：商家/金额/分类/时间） */
    recentTx: { merchant: string; amountYuan: number; category: string; time: string; impulseLevel: string }[]
    /** 最近一次同类购买是否后悔 */
    lastSimilarRegret: string | null
  }
}

export async function buildWishlistFacts(item: WishlistItem): Promise<WishlistFacts> {
  const allTxs = await db.transactions.toArray()
  const now = Date.now()
  const nowDate = new Date()
  const mk = monthKey(nowDate)

  const budgetRaw = await getSetting(BUDGET_KEY)
  const budget = typeof budgetRaw === 'number' && budgetRaw > 0 ? budgetRaw : DEFAULT_BUDGET

  let monthSpent = 0
  let expense30 = 0
  let impulse30 = 0
  for (const t of allTxs) {
    if (!isExpense(t)) continue
    const ts = new Date(t.time).getTime()
    if (ts > now) continue
    if (monthKey(new Date(t.time)) === mk) monthSpent += t.amountMinor
    if (now - ts <= 30 * DAY) {
      expense30 += t.amountMinor
      if (isImpulsive(t.impulseLevel)) impulse30++
    }
  }

  // 近90天同类：同分类 + 商家名关键词模糊匹配 + 同平台
  const matchedCategory = classifyCategory(item.name)
  const keywords = nameKeywords(item.name)
  const itemPlatform = platformOf(item.name)
  let similar90Count = 0
  let similar90Total = 0
  let similarRegretTx: Transaction | null = null
  for (const t of allTxs) {
    if (!isExpense(t)) continue
    const ts = new Date(t.time).getTime()
    if (now - ts > 90 * DAY) continue
    const sameCat = t.category === matchedCategory
    const kwMatch = keywords.some(k => k && (t.merchant.includes(k) || t.note.includes(k)))
    const platMatch = itemPlatform !== null && platformOf(t.merchant) === itemPlatform
    if (!(sameCat || kwMatch || platMatch)) continue
    similar90Count++
    similar90Total += t.amountMinor
    if (t.regretValue !== null && (!similarRegretTx || ts > new Date(similarRegretTx.time).getTime())) {
      similarRegretTx = t
    }
  }
  const lastSimilarRegret = similarRegretTx
    ? (similarRegretTx.regretValue ? '最近一次同类购买你标记了「后悔」' : '最近一次同类购买你标记了「值得」')
    : null

  const recentTx = allTxs
    .filter(t => isExpense(t))
    .sort((a, b) => (a.time < b.time ? 1 : -1))
    .slice(0, 5)
    .map(t => ({
      merchant: t.merchant,
      amountYuan: yuan(t.amountMinor),
      category: t.category,
      time: fmtTime(t.time),
      impulseLevel: t.impulseLevel,
    }))

  const daysInMonth = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 0).getDate()
  const daysLeft = Math.max(0, daysInMonth - nowDate.getDate())

  return {
    item: {
      name: item.name,
      priceYuan: yuan(item.priceMinor),
      // 冲动拦截的商品名带有价格后缀（如"拼多多 ¥68.00"），据此区分来源
      source: /¥\s*\d/.test(item.name) ? '冲动拦截' : '手动添加',
      coolingDays: item.coolingDays,
      coolingHoursLeft: Math.max(0, Math.ceil((new Date(item.coolingEndsAt).getTime() - now) / 3_600_000)),
    },
    profile: {
      monthBudgetYuan: yuan(budget),
      monthSpentYuan: yuan(monthSpent),
      monthRemainingYuan: Math.max(0, yuan(budget - monthSpent)),
      dailyAllowanceYuan: daysLeft > 0 ? round2(Math.max(0, budget - monthSpent) / daysLeft / 100) : 0,
      expense30Yuan: yuan(expense30),
      impulse30Count: impulse30,
      similar90Count,
      similar90TotalYuan: yuan(similar90Total),
      recentTx,
      lastSimilarRegret,
    },
  }
}

// ==================== 工具（查询真实数据） ====================

export interface WishlistTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

export interface WishlistToolStatus {
  name: string
  label: string
  state: 'running' | 'done' | 'error'
}

const RUNNING_LABEL: Record<string, string> = {
  query_recent_transactions: '正在查你的消费记录…',
  query_category_history: '正在统计同类消费…',
  query_budget_status: '正在查询预算状态…',
  query_savings: '正在查询储蓄进度…',
  query_impulse_history: '正在查询冲动消费…',
}
const DONE_LABEL: Record<string, string> = {
  query_recent_transactions: '🔍 已查询你的消费记录',
  query_category_history: '🔍 已统计同类消费',
  query_budget_status: '🔍 已查询预算',
  query_savings: '🔍 已查询储蓄进度',
  query_impulse_history: '🔍 已查询冲动消费',
}

function objSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, required }
}

/** 生成欲望清单专属查询工具（闭包携带商品上下文） */
function buildWishlistTools(item: WishlistItem): WishlistTool[] {
  const matchedCategory = classifyCategory(item.name)

  const queryRecent = async (args: Record<string, unknown>): Promise<object> => {
    const days = Math.max(1, Math.min(365, Number(args.days) || 30))
    const limit = Math.max(1, Math.min(20, Number(args.limit) || 8))
    const wantCat = args.category ? String(args.category) : null
    const txs = await db.transactions.toArray()
    const now = Date.now()
    const items = txs
      .filter(t => {
        if (!isExpense(t)) return false
        if (wantCat && t.category !== wantCat) return false
        return now - new Date(t.time).getTime() <= days * DAY
      })
      .sort((a, b) => (a.time < b.time ? 1 : -1))
      .slice(0, limit)
      .map(t => ({
        merchant: t.merchant,
        amountYuan: yuan(t.amountMinor),
        category: t.category,
        time: fmtTime(t.time),
        impulseLevel: t.impulseLevel,
      }))
    return { days, count: items.length, items }
  }

  const queryCategoryHistory = async (args: Record<string, unknown>): Promise<object> => {
    const days = Math.max(1, Math.min(365, Number(args.days) || 90))
    const category = args.category ? String(args.category) : matchedCategory
    const txs = await db.transactions.toArray()
    const now = Date.now()
    const items = txs
      .filter(t => isExpense(t) && t.category === category && now - new Date(t.time).getTime() <= days * DAY)
    const count = items.length
    const totalYuan = yuan(items.reduce((s, t) => s + t.amountMinor, 0))
    const top = items
      .sort((a, b) => b.amountMinor - a.amountMinor)
      .slice(0, 8)
      .map(t => ({ merchant: t.merchant, amountYuan: yuan(t.amountMinor), time: fmtTime(t.time) }))
    return { category, days, count, totalYuan, items: top }
  }

  const queryBudgetStatus = async (): Promise<object> => {
    const budgetRaw = await getSetting(BUDGET_KEY)
    const budget = typeof budgetRaw === 'number' && budgetRaw > 0 ? budgetRaw : DEFAULT_BUDGET
    const mk = monthKey(new Date())
    const txs = await db.transactions.toArray()
    let spent = 0
    for (const t of txs) {
      if (!isExpense(t)) continue
      if (monthKey(new Date(t.time)) === mk) spent += t.amountMinor
    }
    const now = new Date()
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
    const daysLeft = Math.max(0, daysInMonth - now.getDate())
    const remaining = budget - spent
    return {
      budget: yuan(budget),
      spent: yuan(spent),
      remaining: yuan(remaining),
      daysLeft,
      dailyAllowance: daysLeft > 0 ? yuan(Math.max(0, remaining) / daysLeft) : 0,
    }
  }

  const querySavings = async (): Promise<object> => {
    const goals = await getAllSavingsGoals()
    const active = goals.find(g => g.isActive) ?? goals[0] ?? null
    return {
      target: active ? yuan(active.targetMinor) : 0,
      current: active ? yuan(active.currentMinor) : 0,
      percent: active && active.targetMinor > 0 ? Math.round((active.currentMinor / active.targetMinor) * 100) : 0,
      remaining: active ? yuan(Math.max(0, active.targetMinor - active.currentMinor)) : 0,
      goals: goals.map(g => ({
        name: g.name,
        current: yuan(g.currentMinor),
        target: yuan(g.targetMinor),
        percent: g.targetMinor > 0 ? Math.round((g.currentMinor / g.targetMinor) * 100) : 0,
        isActive: g.isActive,
      })),
    }
  }

  const queryImpulseHistory = async (args: Record<string, unknown>): Promise<object> => {
    const days = Math.max(1, Math.min(365, Number(args.days) || 30))
    const txs = await db.transactions.toArray()
    const now = Date.now()
    const impulses = txs.filter(t =>
      isExpense(t) && isImpulsive(t.impulseLevel) && now - new Date(t.time).getTime() <= days * DAY)
    const byPeriod: Record<string, number> = { 凌晨: 0, 上午: 0, 下午: 0, 晚上: 0, 深夜: 0 }
    let total = 0
    for (const t of impulses) {
      total += t.amountMinor
      const slot = slotOf(new Date(t.time).getHours())
      byPeriod[slot] = (byPeriod[slot] ?? 0) + 1
    }
    return { days, count: impulses.length, totalYuan: yuan(total), byPeriod }
  }

  return [
    { name: 'query_recent_transactions', description: '查询用户最近 N 天消费记录，可按分类筛选。用于"你上周刚买过类似的"这类断言', parameters: objSchema({ days: { type: 'number', description: '天数，默认 30' }, category: { type: 'string', description: '分类名，可选' }, limit: { type: 'number', description: '条数，默认 8' } }), execute: queryRecent },
    { name: 'query_category_history', description: `查询用户近 N 天某分类的消费历史（笔数/总额/大额明细）。不传分类时自动使用当前商品推断的分类「${matchedCategory}」`, parameters: objSchema({ category: { type: 'string', description: '分类名，可选，默认自动推断' }, days: { type: 'number', description: '天数，默认 90' } }), execute: queryCategoryHistory },
    { name: 'query_budget_status', description: '查询本月预算执行状态（预算/已花/剩余/日均可用），用于"这笔占你预算的X%"', parameters: objSchema({}), execute: queryBudgetStatus },
    { name: 'query_savings', description: '查询储蓄目标进度（当前/目标/百分比/剩余），用于"买了它你的储蓄会落后X%"', parameters: objSchema({}), execute: querySavings },
    { name: 'query_impulse_history', description: '查询用户近 N 天冲动消费（笔数/总额/时段分布），用于"你最近X天冲动花了¥Y"', parameters: objSchema({ days: { type: 'number', description: '天数，默认 30' } }), execute: queryImpulseHistory },
  ]
}

export const WISHLIST_TOOL_DEFS: ChatTool[] = [
  { type: 'function', function: { name: 'query_recent_transactions', description: '查询用户最近 N 天消费记录，可按分类筛选', parameters: { type: 'object', properties: { days: { type: 'number', description: '天数，默认 30' }, category: { type: 'string', description: '分类名，可选' }, limit: { type: 'number', description: '条数，默认 8' } } } } },
  { type: 'function', function: { name: 'query_category_history', description: '查询用户近 N 天某分类的消费历史（笔数/总额/明细）', parameters: { type: 'object', properties: { category: { type: 'string', description: '分类名，可选' }, days: { type: 'number', description: '天数，默认 90' } } } } },
  { type: 'function', function: { name: 'query_budget_status', description: '查询本月预算执行状态（预算/已花/剩余/日均可用）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'query_savings', description: '查询储蓄目标进度（当前/目标/百分比/剩余）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'query_impulse_history', description: '查询用户近 N 天冲动消费（笔数/总额/时段分布）', parameters: { type: 'object', properties: { days: { type: 'number', description: '天数，默认 30' } } } } },
]

function parseToolArgs(tc: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tc.function.arguments || '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// ==================== 总结 JSON 解析 / 规范化 ====================

function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim())
}

function num(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, Math.round(n)))
}

/** 校验并规范化 AI 输出的总结 JSON（字段缺失时兜底，保证前端渲染不破版） */
export function normalizeSummary(raw: Record<string, unknown> | null): WishlistChatSummary | null {
  if (!raw) return null
  const conclusion = raw.conclusion === 'buy' || raw.conclusion === 'delay' || raw.conclusion === 'skip'
    ? raw.conclusion
    : 'delay'
  const verdict = String(raw.verdict ?? '').trim() || '再想想比较稳妥'
  const reasons = strArr(raw.reasons).slice(0, 4)
  const traps = strArr(raw.traps).slice(0, 3)
  const alternatives = strArr(raw.alternatives).slice(0, 3)

  // 7 维度：保留 AI 给出的，缺失的用标准标签补齐
  const dims = Array.isArray(raw.dimensions)
    ? raw.dimensions
      .filter((d): d is { label?: unknown; score?: unknown } => !!d && typeof d === 'object')
      .map(d => ({ label: String(d.label ?? '').trim(), score: num(d.score, 50, 0, 100) }))
      .filter(d => d.label)
    : []
  while (dims.length < 7) dims.push({ label: DIMENSION_LABELS[dims.length] ?? `维度${dims.length + 1}`, score: 50 })
  const dimensions = dims.slice(0, 7)

  const summary: WishlistChatSummary = {
    conclusion,
    verdict,
    reasons: reasons.length > 0 ? reasons : [verdict],
    dimensions,
    realNeedIndex: num(raw.realNeedIndex, 50, 0, 100),
    traps,
    coolingDays: num(raw.coolingDays, 3, 1, 30),
    alternatives,
  }
  return summary
}

/** 从 AI 回复中提取"自然收尾话术 + 总结 JSON"；无标记则视为普通回复 */
function parseSummaryResult(text: string): { reply: string; summary: WishlistChatSummary | null } {
  const idx = text.indexOf(SUMMARY_MARKER)
  if (idx < 0) {
    const s = normalizeSummary(parseJsonObject(text))
    if (s) return { reply: '', summary: s }
    return { reply: text.trim(), summary: null }
  }
  const reply = text.slice(0, idx).replace(/\s+$/, '')
  const summary = normalizeSummary(parseJsonObject(text.slice(idx + SUMMARY_MARKER.length)))
  return { reply: reply || '聊到这我觉得可以给你个结论了——', summary }
}

// ==================== 系统提示（核心） ====================

function systemPrompt(facts: WishlistFacts): string {
  return `你是一个消费心理学专家型财务智能体，正在帮助用户理性决策是否购买「${facts.item.name}」（¥${facts.item.priceYuan}，${facts.item.source}，当前冷静期还剩 ${facts.item.coolingHoursLeft} 小时）。
你的目标：通过对话帮用户看清这笔消费的真相，而不是替他做决定。
规则：
- 不要问机械的固定问题，要根据对话进展自然追问，像真人专家聊天，越聊越深入
- 每一轮都要基于用户刚说的话做实时分析：抓住情绪词、场景、理由、犹豫点，指出心理机制，引用真实数据
- 每一轮回应前，先调用与用户当前话题最相关的工具核实真实数据（工具列表见本轮可用函数：预算→query_budget_status；过去消费/同类→query_recent_transactions 或 query_category_history；冲动历史→query_impulse_history；储蓄→query_savings），用工具返回的最新数字支撑分析，不要只依赖下方 facts 快照。开场后的第一轮必须至少调用一次工具
- 工具调用结果会实时以"🔍 正在查询…"形式展示给用户；调用前不要向用户赘述，直接发起调用
- 仅当确实不需要新数据（例如用户在收尾表态、话题已充分覆盖）时可跳过工具调用
- 语气温和、不评判、不说教，像朋友+顾问
- 当对话已覆盖「是否需要 / 有无替代 / 真实场景 / 预算承受」等关键维度时，主动收尾给出结论
- 用户说"够了 / 就这吧 / 结束"时立即收尾
- 回复像聊天一样简短自然（一般 2-4 句），每一轮都要有"实时分析"而非空泛回应

【输出格式 · 必须是精美 HTML 卡片】
- 你的每一条回复（含收尾第一行）必须输出为精美 HTML 片段（内联CSS、蓝白配色、主色#0040FF、数字加粗+等宽字体+靛蓝色、重要信息浅琥珀框、建议浅青卡片）
- 禁止 Markdown 语法（#、*、- 列表），禁止 \`\`\`html 包裹，只输出 HTML 内容本身（可用 <div>/<p>/<b>/<span> 等标签）
- 结尾要追问的问题用浅靛蓝底圆角卡片呈现（内联CSS 圆角+浅蓝底），问题前带小图标（如 💬/🤔）
- 引用 facts 里的数字时用 <b style="font-family:monospace;color:#0040FF">数字</b> 加粗等宽靛蓝显示

收尾格式（严格遵循，只有收尾时才输出）：
第一行：一句自然收尾的话（如"聊到这我觉得可以给你个结论了——"）
第二行：${SUMMARY_MARKER}
第三行起：总结 JSON（纯对象，不要 markdown 代码块、不要注释）
总结 JSON schema：
{"conclusion":"buy 或 delay 或 skip","verdict":"一句话结论文案（口语化，面向用户）","reasons":["依据数组，2-4 条，必须引用用户对话里说过的具体话 + 真实数据"],"dimensions":[{"label":"需求真实度","score":0-100},{"label":"情绪驱动","score":0-100},{"label":"场景迫切","score":0-100},{"label":"预算承受","score":0-100},{"label":"替代可行","score":0-100},{"label":"时间沉淀","score":0-100},{"label":"后悔风险","score":0-100}],"realNeedIndex":0-100,"traps":["命中的消费主义陷阱，1-3 个，如 稀缺效应/损失厌恶/奖励心理/心理账户/从众/沉没成本"],"coolingDays":建议冷静期天数数字,"alternatives":["替代方案 2-3 条，结合用户具体场景（如压力大→去散步）"]}
说明：dimensions 分数越高表示该维度冲动风险越高；realNeedIndex 越高表示越真实需要；reasons 必须体现这次对话的独特性，不同商品、不同用户必须完全不同。

以下是本地从数据库算出的用户真实财务数据（facts），开场与每一轮分析都以此为依据，禁止编造：
${JSON.stringify(facts, null, 2)}`
}

// ==================== 历史消息 → API 消息 ====================

function toApiMessages(history: WishlistChatMsg[]): ChatMessage[] {
  return history.slice(-MAX_HISTORY_MSGS).map(m => {
    if (m.role === 'user') return { role: 'user', content: m.content }
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.toolCallId }
    return {
      role: 'assistant',
      content: m.content || null,
      ...(m.toolCalls && m.toolCalls.length > 0
        ? { tool_calls: m.toolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.args } })) }
        : {}),
    }
  })
}

// ==================== 开场白（动态，非模板） ====================

function fallbackOpening(f: WishlistFacts): string {
  const p = f.profile
  // 商品名若已含价格（如"拼多多 ¥68.00"）则不再重复显示
  const namePart = f.item.name.includes('¥')
    ? `看到你把「${f.item.name}」放进来了。`
    : `看到你把「${f.item.name}」（<b>¥${f.item.priceYuan}</b>）放进来了。`
  const parts = [namePart]
  if (p.similar90Count > 0) {
    parts.push(`我注意到你近 90 天在同类上已经买了 <b>${p.similar90Count}</b> 笔、共 <b>¥${p.similar90TotalYuan}</b>。`)
  } else if (p.impulse30Count > 0) {
    parts.push(`你近 30 天有 <b>${p.impulse30Count}</b> 笔冲动消费。`)
  } else if (p.monthRemainingYuan > 0) {
    parts.push(`这个月预算还剩 <b>¥${p.monthRemainingYuan}</b>。`)
  }
  parts.push('这个是你特别想要的，还是刚好刷到的？')
  // 降级开场白同样输出为 HTML 片段（数字加粗靛蓝 + 追问卡片样式），与 AI 输出保持一致
  return `<div style="font-family:inherit;font-size:13.5px;line-height:1.75;color:#374151">${parts.join('')}
<div style="margin-top:8px;padding:9px 12px;border-radius:10px;background:#EEF2FF;border:1px solid #C7D2FE;color:#0040FF">💬 这个是你特别想要的，还是刚好刷到的？</div></div>`
}

/** 生成 AI 开场白（基于商品 + 真实数据动态生成，失败走本地数据模板降级） */
export async function generateWishlistOpening(facts: WishlistFacts): Promise<string> {
  const system = '你是一个消费心理学专家型财务智能体，语气温和、不评判，像朋友+顾问。'
    + '用户刚把一个商品加入欲望清单，点开了你的分析。你要说的第一句话，必须像真人专家开口。'
  const user = `商品与用户真实数据（JSON）：
\`\`\`json
${JSON.stringify(facts, null, 2)}
\`\`\`

请生成开场白，要求：
1. 自然、具体，像真人专家开口，禁止"你好，请问这个商品解决你什么问题"这类模板话术
2. 引用商品名称、价格，以及至少一个真实数据（近90天同类消费 / 近30天购物笔数 / 本月预算剩余 / 最近交易等；数据里有的才用，没有绝不编造）
3. 结尾提一个开放性问题，引导用户说出为什么想买（如"是特别想要，还是刚好刷到？"）
4. 必须输出为精美 HTML 片段（内联CSS、蓝白配色、主色#0040FF、数字加粗+等宽字体+靛蓝色）；结尾的问题用浅靛蓝底圆角卡片呈现并带 💬 图标
5. 禁止 Markdown 语法（#、*、-），禁止 \`\`\`html 包裹，只输出 HTML 内容本身（可用 <div>/<p>/<b> 等标签），整体 2-4 句`
  try {
    const content = await chatCompletion([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { temperature: 0.8 })
    await incrementAiCount()
    const t = content.trim()
    if (t.length > 10) return t
    return fallbackOpening(facts)
  } catch {
    return fallbackOpening(facts)
  }
}

// ==================== 对话回合（function calling 循环） ====================

export interface WishlistTurnOptions {
  item: WishlistItem
  facts: WishlistFacts
  history: WishlistChatMsg[]
  userText: string
  onStatus?: (s: WishlistToolStatus) => void
}

export interface WishlistTurnResult {
  /** 展示给用户的 AI 回复（已剥离总结 JSON 标记） */
  reply: string
  /** 若 AI 判定可以收尾，附带动态总结 */
  summary: WishlistChatSummary | null
}

/**
 * 执行一轮对话：调用 DeepSeek（系统提示 + facts + 完整历史 + 工具定义），
 * 循环处理 function calling（本地执行查询工具并回传），单轮最多 5 次工具调用。
 */
export async function runWishlistTurn(o: WishlistTurnOptions): Promise<WishlistTurnResult> {
  const tools = buildWishlistTools(o.item)
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(o.facts) },
    ...toApiMessages(o.history),
    { role: 'user', content: o.userText },
  ]

  let toolCount = 0
  for (let round = 0; round < MAX_TOOL_CALLS + 1; round++) {
    const turn = await agentCompletion(messages, WISHLIST_TOOL_DEFS, { temperature: 0.7 })
    await incrementAiCount()
    const content = turn.content ?? ''
    if (!turn.toolCalls || turn.toolCalls.length === 0) {
      return parseSummaryResult(content)
    }
    messages.push({ role: 'assistant', content, tool_calls: turn.toolCalls })
    for (const tc of turn.toolCalls) {
      const name = tc.function.name
      if (toolCount >= MAX_TOOL_CALLS) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: '{"error":"已达到本轮工具调用上限，请直接基于已有信息回答，不要再调用工具"}' })
        continue
      }
      toolCount++
      const tool = tools.find(t => t.name === name)
      o.onStatus?.({ name, label: RUNNING_LABEL[name] ?? `正在执行 ${name}…`, state: 'running' })
      let result: unknown
      let ok = true
      try {
        if (!tool) throw new Error(`未知工具：${name}`)
        result = await tool.execute(parseToolArgs(tc))
      } catch (e) {
        ok = false
        result = { error: e instanceof Error ? e.message : String(e) }
      }
      o.onStatus?.({
        name,
        label: ok ? (DONE_LABEL[name] ?? `已完成 ${name}`) : `⚠️ ${name} 执行失败`,
        state: ok ? 'done' : 'error',
      })
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
    }
  }
  return { reply: '聊到这里有点绕住了，要不我们换个角度说说，或者直接告诉我你现在的想法？', summary: null }
}

// ==================== 手动收尾：生成动态总结 ====================

export interface WishlistSummaryOptions {
  item: WishlistItem
  facts: WishlistFacts
  history: WishlistChatMsg[]
}

/** 用户点"结束分析，给结论"时调用：AI 基于完整对话 + 真实数据生成总结 JSON */
export async function generateWishlistSummary(o: WishlistSummaryOptions): Promise<WishlistChatSummary | null> {
  const system = '你是一个消费心理学专家型财务智能体。用户与你的对话已结束，请基于对话内容与真实数据生成最终分析总结。只输出 JSON 对象，不要任何其他文字。'
    + `\nJSON schema：\n{"conclusion":"buy|delay|skip","verdict":"一句话结论文案","reasons":["2-4 条，必须引用用户对话里说过的具体话 + 真实数据"],"dimensions":[{"label":"需求真实度","score":0-100},{"label":"情绪驱动","score":0-100},{"label":"场景迫切","score":0-100},{"label":"预算承受","score":0-100},{"label":"替代可行","score":0-100},{"label":"时间沉淀","score":0-100},{"label":"后悔风险","score":0-100}],"realNeedIndex":0-100,"traps":["1-3 个"],"coolingDays":天数数字,"alternatives":["2-3 条"]}`
    + '\n要求：dimensions 分数越高冲动风险越高；realNeedIndex 越高越真实需要；reasons 必须体现这次对话的独特性，引用用户原话与真实数据；alternatives 结合用户具体场景；全部中文。'
  const user = `商品与用户真实数据（JSON）：
\`\`\`json
${JSON.stringify(o.facts, null, 2)}
\`\`\`

完整对话（tool 内部消息已省略）：
${o.history.filter(m => m.role !== 'tool').map(m => `${m.role === 'user' ? '用户' : '你'}：${m.content}`).join('\n')}

请输出总结 JSON。`
  try {
    const content = await chatCompletion([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { json: true, temperature: 0.6 })
    await incrementAiCount()
    return normalizeSummary(parseJsonObject(content))
  } catch {
    return null
  }
}

// ==================== 结束意图识别 ====================

const END_INTENT_RE = /够了|就这吧|结束分析|结束吧|就这样吧|聊完了|到此为止|不想聊了|不用了|可以了|行了/

/** 用户明确要求结束对话 */
export function isEndIntent(text: string): boolean {
  return END_INTENT_RE.test(text.replace(/\s+/g, ''))
}

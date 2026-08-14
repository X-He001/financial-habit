import { db } from '../db/database'
import {
  addTransaction, addWishlistItem, addSchedule, getSetting,
  updateSavingsGoal, getAllSavingsGoals, deleteTransaction,
} from '../db/crud'
import type { PendingTx } from '../utils/impulseEngine'
import { guardTransaction, platformOf, isImpulsive } from '../utils/impulseEngine'
import { recordConsumerEvent } from './profile'
import { buildDebtSnapshot } from '../debt/debtContext'
import { getDayFacts, getWeekFacts, getMonthFacts } from '../utils/aiFacts'
import { generateReport } from '../api/deepseek'
import { incrementAiCount } from '../utils/aiUsage'

// ==================== 工具类型 ====================

export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

// ==================== 内部工具 ====================

const BUDGET_KEY = 'monthlyBudget'
const DEFAULT_BUDGET = 1000_00

function yuan(minor: number): number {
  return Math.round((minor / 100) * 100) / 100
}
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}
function slotOf(h: number): string {
  if (h < 6) return '凌晨'
  if (h < 12) return '上午'
  if (h < 18) return '下午'
  if (h < 22) return '晚上'
  return '深夜'
}
async function getBudget(): Promise<number> {
  const raw = await getSetting(BUDGET_KEY)
  return typeof raw === 'number' && raw > 0 ? raw : DEFAULT_BUDGET
}
function isIncome(t: { txType?: string }): boolean {
  return t.txType === 'income'
}
function isTransfer(t: { note?: string }): boolean {
  return t.note === '储蓄转入'
}

/** 最近一次由 Agent 添加的交易 id（供"撤销"工具删除） */
let lastAddTxId: string | null = null

/** 记录最近一次写操作摘要（供"刚才那笔/撤销"上下文） */
function recordLastOp(op: string | null) {
  try {
    if (op) localStorage.setItem('agentLastOp', op)
    else localStorage.removeItem('agentLastOp')
  } catch {
    // localStorage 不可用时静默
  }
}

// ==================== 查询类工具（只读） ====================

async function getMonthlySummary(args: Record<string, unknown>): Promise<object> {
  const mk = (args.month as string) ?? monthKey(new Date())
  const txs = await db.transactions.toArray()
  let spent = 0
  let income = 0
  for (const t of txs) {
    if (monthKey(new Date(t.time)) !== mk) continue
    if (isIncome(t)) income += t.amountMinor
    else if (isTransfer(t)) continue
    else spent += t.amountMinor
  }
  const budget = await getBudget()
  return {
    month: mk,
    spent: yuan(spent),
    income: yuan(income),
    budget: yuan(budget),
    remaining: yuan(budget - spent),
    budgetUsedPercent: budget > 0 ? Math.round((spent / budget) * 100) : 0,
  }
}

async function getCategorySpending(args: Record<string, unknown>): Promise<object> {
  const mk = (args.month as string) ?? monthKey(new Date())
  const wantCat = args.category ? String(args.category) : null
  const txs = await db.transactions.toArray()
  const map = new Map<string, { amount: number; count: number }>()
  let total = 0
  for (const t of txs) {
    if (monthKey(new Date(t.time)) !== mk) continue
    if (isIncome(t) || isTransfer(t)) continue
    if (wantCat && t.category !== wantCat) continue
    const e = map.get(t.category) ?? { amount: 0, count: 0 }
    e.amount += t.amountMinor
    e.count++
    map.set(t.category, e)
    total += t.amountMinor
  }
  const rows = [...map.entries()]
    .map(([category, e]) => ({
      category,
      amount: yuan(e.amount),
      count: e.count,
      percent: total > 0 ? Math.round((e.amount / total) * 100) : 0,
    }))
    .sort((a, b) => b.amount - a.amount)
  return { month: mk, items: rows }
}

async function getPlatformSpending(args: Record<string, unknown>): Promise<object> {
  const mk = (args.month as string) ?? monthKey(new Date())
  const wantPlatform = args.platform ? String(args.platform) : null
  const txs = await db.transactions.toArray()
  const map = new Map<string, { amount: number; count: number }>()
  for (const t of txs) {
    if (monthKey(new Date(t.time)) !== mk) continue
    if (isIncome(t) || isTransfer(t)) continue
    const p = platformOf(t.merchant)
    if (!p) continue
    if (wantPlatform && p !== wantPlatform) continue
    const e = map.get(p) ?? { amount: 0, count: 0 }
    e.amount += t.amountMinor
    e.count++
    map.set(p, e)
  }
  const rows = [...map.entries()]
    .map(([platform, e]) => ({ platform, amount: yuan(e.amount), count: e.count }))
    .sort((a, b) => b.amount - a.amount)
  return { month: mk, items: rows }
}

async function getDailySpending(args: Record<string, unknown>): Promise<object> {
  const days = Math.max(1, Math.min(365, Number(args.days) || 30))
  const txs = await db.transactions.toArray()
  const now = new Date()
  const map = new Map<string, number>()
  for (const t of txs) {
    if (isIncome(t) || isTransfer(t)) continue
    const d = new Date(t.time)
    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000)
    if (diffDays < 0 || diffDays >= days) continue
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    map.set(key, (map.get(key) ?? 0) + t.amountMinor)
  }
  const items: { date: string; amount: number }[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000)
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    items.push({ date: key, amount: yuan(map.get(key) ?? 0) })
  }
  return { days, items }
}

async function getImpulseStats(args: Record<string, unknown>): Promise<object> {
  const mk = (args.month as string) ?? monthKey(new Date())
  const txs = await db.transactions.toArray()
  const impulses = txs.filter(t => {
    if (isIncome(t) || isTransfer(t)) return false
    if (monthKey(new Date(t.time)) !== mk) return false
    return isImpulsive(t.impulseLevel)
  })
  const byPeriod: Record<string, number> = { 凌晨: 0, 上午: 0, 下午: 0, 晚上: 0, 深夜: 0 }
  const platformMap = new Map<string, number>()
  let totalAmount = 0
  let maxImpulse: { merchant: string; amount: number } | null = null
  for (const t of impulses) {
    totalAmount += t.amountMinor
    const slot = slotOf(new Date(t.time).getHours())
    byPeriod[slot] = (byPeriod[slot] ?? 0) + 1
    const p = platformOf(t.merchant)
    if (p) platformMap.set(p, (platformMap.get(p) ?? 0) + 1)
    if (!maxImpulse || t.amountMinor > (maxImpulse as { amount: number }).amount) {
      maxImpulse = { merchant: t.merchant, amount: t.amountMinor }
    }
  }
  const topPlatforms = [...platformMap.entries()]
    .map(([platform, count]) => ({ platform, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
  return {
    month: mk,
    count: impulses.length,
    totalAmount: yuan(totalAmount),
    byPeriod,
    topPlatforms,
    maxImpulse: maxImpulse ? { merchant: maxImpulse.merchant, amount: yuan(maxImpulse.amount) } : null,
  }
}

async function getDebts(): Promise<object> {
  // 债务快照已统一：旧 debts 表 + 新负债账户（花呗/白条等）
  const snap = await buildDebtSnapshot()
  const items: { name: string; remaining: number; nextDue: string | null; estimatedClearMonth: string | null }[] = []
  for (const a of snap.accounts) {
    if (a.principalRemMinor <= 0) continue
    items.push({
      name: `${a.account.platform}${a.account.nickname && a.account.nickname !== a.account.platform ? '·' + a.account.nickname : ''}`,
      remaining: yuan(a.principalRemMinor),
      nextDue: a.currentStatement?.dueDate ?? null,
      estimatedClearMonth: null,
    })
  }
  return { total: yuan(snap.creditPrincipalMinor), items }
}

async function getSavings(): Promise<object> {
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

async function getSchedules(args: Record<string, unknown>): Promise<object> {
  const days = Math.max(0, Math.min(365, Number(args.days) || 30))
  const now = new Date()
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  const end = new Date(now.getTime() + days * 86_400_000)
  const endStr = `${end.getFullYear()}-${pad2(end.getMonth() + 1)}-${pad2(end.getDate())}`
  const scheds = await db.schedules.toArray()
  const items = scheds
    .filter(s => s.date >= today && s.date <= endStr)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map(s => ({ name: s.name, type: s.type, amount: yuan(s.amountMinor), date: s.date, repeat: s.repeat }))
  return { days, items }
}

async function getRecentTransactions(args: Record<string, unknown>): Promise<object> {
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 10))
  const wantCat = args.category ? String(args.category) : null
  const wantPlatform = args.platform ? String(args.platform) : null
  const txs = await db.transactions.toArray()
  const items = txs
    .filter(t => {
      if (isIncome(t) || isTransfer(t)) return false
      if (wantCat && t.category !== wantCat) return false
      if (wantPlatform && platformOf(t.merchant) !== wantPlatform) return false
      return true
    })
    .sort((a, b) => (a.time < b.time ? 1 : -1))
    .slice(0, limit)
    .map(t => ({
      merchant: t.merchant,
      amount: yuan(t.amountMinor),
      category: t.category,
      time: t.time,
      impulseLevel: t.impulseLevel,
      paymentMethod: t.paymentMethod,
    }))
  return { count: items.length, items }
}

async function getBudgetStatus(): Promise<object> {
  const budget = await getBudget()
  const mk = monthKey(new Date())
  const txs = await db.transactions.toArray()
  let spent = 0
  for (const t of txs) {
    if (monthKey(new Date(t.time)) !== mk) continue
    if (isIncome(t) || isTransfer(t)) continue
    spent += t.amountMinor
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

// ==================== 操作类工具（写入） ====================

async function addTransactionTool(args: Record<string, unknown>): Promise<object> {
  const amount = Number(args.amount)
  if (!(amount > 0)) return { success: false, error: '金额必须大于 0（单位：元）' }
  const merchant = String(args.merchant ?? '').trim()
  if (!merchant) return { success: false, error: '缺少商家/用途名称' }
  const category = String(args.category ?? '其他')
  const paymentMethod = String(args.paymentMethod ?? '微信')
  const amountMinor = Math.round(amount * 100)
  const now = new Date()
  const tx: PendingTx = {
    amountMinor,
    category,
    merchant,
    time: args.time ? new Date(String(args.time)).toISOString() : now.toISOString(),
    txType: args.txType === 'income' ? 'income' : 'expense',
    paymentMethod: paymentMethod as PendingTx['paymentMethod'],
    source: 'voice',
    impulseScore: 0,
    impulseLevel: 'low',
    isRevoked: false,
    revokedAt: null,
    regretValue: null,
    regretAt: null,
    importId: null,
    note: String(args.note ?? ''),
    screenshot: null,
  }

  let warnings: string[] = []
  if (tx.txType === 'expense') {
    const guard = await guardTransaction(tx)
    tx.impulseScore = guard.score
    tx.impulseLevel = guard.level
    warnings = guard.warnings.map(w => `${w.icon} ${w.message}`)
  }

  const id = await addTransaction(tx)
  lastAddTxId = id
  // 消费事件入库 → 实时更新画像
  void recordConsumerEvent({ ...tx, id })
  recordLastOp(`记录了一笔 ${yuan(amountMinor)} 元${category === '其他' ? '' : `（${category}）`}：${merchant}`)
  // 冲动消费已入库 → 触发"今日冲动复盘"入口
  window.dispatchEvent(new CustomEvent('impulse-saved', { detail: { tx: { ...tx, id } } }))
  window.dispatchEvent(new CustomEvent('dashboard-refresh'))
  return {
    success: true,
    id,
    amount: yuan(amountMinor),
    merchant,
    category,
    paymentMethod,
    impulseScore: tx.impulseScore,
    impulseLevel: tx.impulseLevel,
    warnings,
  }
}

async function addWishlistItemTool(args: Record<string, unknown>): Promise<object> {
  const price = Number(args.price)
  if (!(price > 0)) return { success: false, error: '价格必须大于 0（单位：元）' }
  const name = String(args.name ?? '').trim()
  if (!name) return { success: false, error: '缺少物品名称' }
  const priceMinor = Math.round(price * 100)
  const coolingDays = price < 100 ? 1 : price < 500 ? 3 : price < 1000 ? 5 : 7
  const now = new Date()
  await addWishlistItem({
    name,
    priceMinor,
    addedAt: now.toISOString(),
    coolingDays,
    coolingEndsAt: new Date(now.getTime() + coolingDays * 86_400_000).toISOString(),
    status: 'cooling',
    aiAnalysis: null,
    finalPriceMinor: null,
    boughtAt: null,
  })
  recordLastOp(`把「${name}」（¥${price}）加入了欲望清单，冷静 ${coolingDays} 天`)
  window.dispatchEvent(new CustomEvent('dashboard-refresh'))
  return { success: true, priceMinor, coolingDays }
}

async function addSavingsAmountTool(args: Record<string, unknown>): Promise<object> {
  const amount = Number(args.amount)
  if (!(amount > 0)) return { success: false, error: '金额必须大于 0（单位：元）' }
  const amountMinor = Math.round(amount * 100)
  const goals = await getAllSavingsGoals()
  const active = goals.find(g => g.isActive) ?? goals[0] ?? null
  if (!active) return { success: false, error: '还没有储蓄目标，请先到储蓄页创建一个' }
  await updateSavingsGoal(active.id, { currentMinor: active.currentMinor + amountMinor })
  const current = active.currentMinor + amountMinor
  recordLastOp(`往储蓄目标「${active.name}」存了 ${amount} 元`)
  window.dispatchEvent(new CustomEvent('dashboard-refresh'))
  return {
    success: true,
    goalName: active.name,
    current: yuan(current),
    target: yuan(active.targetMinor),
    percent: active.targetMinor > 0 ? Math.round((current / active.targetMinor) * 100) : 0,
  }
}

async function addScheduleTool(args: Record<string, unknown>): Promise<object> {
  const name = String(args.name ?? '').trim()
  if (!name) return { success: false, error: '缺少日程名称' }
  const amount = Number(args.amount)
  if (!(amount > 0)) return { success: false, error: '金额必须大于 0（单位：元）' }
  const date = String(args.date ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { success: false, error: '日期格式应为 YYYY-MM-DD' }
  const typeMap: Record<string, 'subscription' | 'debt' | 'other'> = {
    续费: 'subscription', 订阅: 'subscription', 还款: 'debt', 其他: 'other',
  }
  const repeat = String(args.repeat ?? 'none') as 'none' | 'monthly' | 'yearly'
  await addSchedule({
    name,
    type: typeMap[String(args.type ?? '其他')] ?? 'other',
    amountMinor: Math.round(amount * 100),
    date,
    repeat,
    note: '',
    notified: false,
  })
  recordLastOp(`添加了日程「${name}」（${date}，${amount} 元）`)
  return { success: true }
}

async function generateReportTool(args: Record<string, unknown>): Promise<object> {
  const type = String(args.type ?? 'daily')
  const mapType: Record<string, 'day' | 'week' | 'month'> = { daily: 'day', weekly: 'week', monthly: 'month' }
  const mapped = mapType[type] ?? 'day'
  const facts = mapped === 'day' ? await getDayFacts() : mapped === 'week' ? await getWeekFacts() : await getMonthFacts()
  const text = await generateReport(facts, mapped)
  await incrementAiCount()
  return { success: true, type, text }
}

async function deleteLastTransactionTool(): Promise<object> {
  if (!lastAddTxId) return { success: false, deleted: false, reason: '没有可撤销的上一笔记账' }
  const t = await db.transactions.get(lastAddTxId)
  await deleteTransaction(lastAddTxId)
  lastAddTxId = null
  recordLastOp(null)
  window.dispatchEvent(new CustomEvent('dashboard-refresh'))
  return {
    success: true,
    deleted: true,
    merchant: t?.merchant ?? null,
    amount: t ? yuan(t.amountMinor) : 0,
  }
}

// ==================== 工具注册表 ====================

const objSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
})

const monthProp = { type: 'string', description: '月份，YYYY-MM 格式，默认本月' }
const amountProp = { type: 'number', description: '金额（元）' }

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'get_monthly_summary',
    description: '获取某月的收支总览（支出/收入/预算/剩余/预算使用率）',
    parameters: objSchema({ month: monthProp }),
    execute: getMonthlySummary,
  },
  {
    name: 'get_category_spending',
    description: '按分类统计某月支出（金额/笔数/占比），可只查某个分类',
    parameters: objSchema({ month: monthProp, category: { type: 'string', description: '分类名，如 餐饮/购物/娱乐，可选' } }),
    execute: getCategorySpending,
  },
  {
    name: 'get_platform_spending',
    description: '按平台统计某月支出（拼多多/京东/淘宝/抖音/美团/淘宝闪购），可只看某平台',
    parameters: objSchema({ month: monthProp, platform: { type: 'string', description: '平台名，可选' } }),
    execute: getPlatformSpending,
  },
  {
    name: 'get_daily_spending',
    description: '获取近 N 天每日支出，用于看消费趋势',
    parameters: objSchema({ days: { type: 'number', description: '天数，默认 30' } }),
    execute: getDailySpending,
  },
  {
    name: 'get_impulse_stats',
    description: '获取某月冲动消费统计（次数/金额/时段分布/高频平台/最大单笔）',
    parameters: objSchema({ month: monthProp }),
    execute: getImpulseStats,
  },
  {
    name: 'get_debts',
    description: '获取负债总览（总额与各项待还金额、最近还款日）',
    parameters: objSchema({}),
    execute: getDebts,
  },
  {
    name: 'get_savings',
    description: '获取储蓄目标进度（当前/目标/百分比/剩余，以及所有目标列表）',
    parameters: objSchema({}),
    execute: getSavings,
  },
  {
    name: 'get_schedules',
    description: '获取未来 N 天扣费日程（续费/还款等）',
    parameters: objSchema({ days: { type: 'number', description: '天数，默认 30' } }),
    execute: getSchedules,
  },
  {
    name: 'get_recent_transactions',
    description: '获取最近交易记录，可按分类/平台筛选',
    parameters: objSchema({
      limit: { type: 'number', description: '条数，默认 10' },
      category: { type: 'string', description: '分类名，可选' },
      platform: { type: 'string', description: '平台名，可选' },
    }),
    execute: getRecentTransactions,
  },
  {
    name: 'get_budget_status',
    description: '获取本月预算执行状态（预算/已花/剩余/剩余天数/日均可用）',
    parameters: objSchema({}),
    execute: getBudgetStatus,
  },
  {
    name: 'add_transaction',
    description: '记录一笔支出或收入。参数：amount 金额（元）、category 分类（餐饮/购物/日用百货/娱乐/交通/虚拟消费/其他）、merchant 商家、paymentMethod 支付方式（微信/支付宝/银行卡/现金/花呗/信用支付/先用后付/分期）、time 可选时间、note 可选备注、txType 可选（income 收入，默认支出）。保存前会本地计算冲动指数并返回预警。',
    parameters: objSchema({
      amount: amountProp,
      category: { type: 'string', description: '分类：餐饮/购物/日用百货/娱乐/交通/虚拟消费/其他' },
      merchant: { type: 'string', description: '商家/用途' },
      paymentMethod: { type: 'string', description: '微信/支付宝/银行卡/现金/花呗/信用支付/先用后付/分期' },
      time: { type: 'string', description: '时间 ISO 字符串，可选' },
      note: { type: 'string', description: '备注，可选' },
      txType: { type: 'string', description: 'income=收入，默认支出' },
    }, ['amount', 'category', 'merchant', 'paymentMethod']),
    execute: addTransactionTool,
  },
  {
    name: 'add_wishlist_item',
    description: '把想买的物品加入欲望清单，自动按价格设置冷静期（价格越高冷静越久）',
    parameters: objSchema({
      name: { type: 'string', description: '物品名称' },
      price: amountProp,
    }, ['name', 'price']),
    execute: addWishlistItemTool,
  },
  {
    name: 'add_savings_amount',
    description: '往当前储蓄目标存一笔钱',
    parameters: objSchema({ amount: amountProp }, ['amount']),
    execute: addSavingsAmountTool,
  },
  {
    name: 'add_schedule',
    description: '添加一个扣费日程（续费/还款/其他）',
    parameters: objSchema({
      name: { type: 'string', description: '日程名称，如 爱奇艺会员' },
      type: { type: 'string', description: '续费/还款/其他' },
      amount: amountProp,
      date: { type: 'string', description: '日期 YYYY-MM-DD' },
      repeat: { type: 'string', description: '重复：none/monthly/yearly，默认 none' },
    }, ['name', 'type', 'amount', 'date']),
    execute: addScheduleTool,
  },
  {
    name: 'generate_report',
    description: '生成 AI 财务报告（daily 每日 / weekly 每周 / monthly 每月），返回块标记格式的完整报告文本',
    parameters: objSchema({ type: { type: 'string', description: 'daily/weekly/monthly' } }, ['type']),
    execute: generateReportTool,
  },
  {
    name: 'delete_last_transaction',
    description: '撤销/删除最近一次由本 Agent 记的交易（用户在工具执行出错或反悔时说"撤销"时调用）',
    parameters: objSchema({}),
    execute: deleteLastTransactionTool,
  },
]

export const AGENT_TOOL_DEFS = AGENT_TOOLS.map(t => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: t.parameters },
}))

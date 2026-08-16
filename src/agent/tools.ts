import { db } from '../db/database'
import {
  addTransaction, addWishlistItem, addSchedule, getSetting,
  updateSavingsGoal, getAllSavingsGoals, deleteTransaction,
  addAgentInboxItem, updateAgentInboxItem, addFeedbackLog, getAllFeedbackLogs,
} from '../db/crud'
import type { PendingTx } from '../utils/impulseEngine'
import { guardTransaction, platformOf, isImpulsive } from '../utils/impulseEngine'
import { recordConsumerEvent, getProfile, addCoachNote } from './profile'
import type { CoachNote, PrivacyTier } from '../types'
import { maskToolResult, defaultTierFor } from '../utils/privacy'
import { ensureKnowledgeSeeded, searchKnowledge } from './knowledge'
import { buildDebtSnapshot } from '../debt/debtContext'
import { simulateClearDays } from '../debt/calc'
import { getDayFacts, getWeekFacts, getMonthFacts } from '../utils/aiFacts'
import { generateReport } from '../api/deepseek'
import { incrementAiCount } from '../utils/aiUsage'

// ==================== 工具类型 ====================

/** 工具执行上下文（隐私分层：档1 聚合 / 档2 脱敏单笔 / 档3 完整单笔） */
export interface ToolExecCtx {
  privacyTier?: PrivacyTier
}

export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, ctx?: ToolExecCtx) => Promise<unknown>
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
function dateKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
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

/**
 * 工具执行档位（隐私分层三档，确认版）：
 *   档1 聚合数据（默认，日常分析/循环观察推理走这档，绝不传单笔明细）
 *   档2 脱敏单笔（反馈/引用场景，商户/平台/备注脱敏）
 *   档3 完整单笔（仅用户主动查明细，由调用方显式传 privacyTier=3）
 * 调用方（engine/coachEngine/feedbackEngine）按场景覆盖；缺省=档1。
 */
function tierOf(ctx?: ToolExecCtx): PrivacyTier {
  return ctx?.privacyTier ?? defaultTierFor('analysis')
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

async function getImpulseStats(args: Record<string, unknown>, ctx?: ToolExecCtx): Promise<object> {
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
  // 隐私分层：结果含"最大单笔"的商户名 → 按档位脱敏（档1/档2 商户→某商户，档3 原样）
  return maskToolResult({
    month: mk,
    count: impulses.length,
    totalAmount: yuan(totalAmount),
    byPeriod,
    topPlatforms,
    maxImpulse: maxImpulse ? { merchant: maxImpulse.merchant, amount: yuan(maxImpulse.amount) } : null,
  }, tierOf(ctx)) as object
}

async function getDebts(): Promise<object> {
  // 债务快照已统一：旧 debts 表 + 新负债账户（花呗/白条等）
  // 结构化"事实数据块"：余额/利率/日息/还款日/清零日等全部由代码算好，AI 只引用、不得改动数字
  const snap = await buildDebtSnapshot()
  const items: {
    name: string
    remaining: number
    apr: number
    dailyInterest: number
    savingsMultiple: number | null
    nextDue: string | null
    dueMinor: number
    minPayment: number
    isMinOnly: boolean
    clearDays: number | null
    clearDate: string | null
  }[] = []
  let totalDailyInterestMinor = 0
  for (const a of snap.accounts) {
    if (a.principalRemMinor <= 0) continue
    const dailyInterestMinor = Math.round(a.principalRemMinor * a.dailyRate)
    totalDailyInterestMinor += dailyInterestMinor
    const userInst = snap.installments
      .filter(i => i.accountId === a.account.id && i.source === 'user')
      .sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))[0]
    const monthly = userInst?.principalPerMinor ?? a.dueMinor ?? a.minPaymentMinor ?? 0
    let clearDays: number | null = null
    let clearDate: string | null = null
    if (monthly > 0) {
      const d = simulateClearDays(a.principalRemMinor, monthly, a.dailyRate)
      if (d !== null) {
        clearDays = d
        const dt = new Date(Date.now() + d * 86_400_000)
        clearDate = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`
      }
    }
    items.push({
      name: `${a.account.platform}${a.account.nickname && a.account.nickname !== a.account.platform ? '·' + a.account.nickname : ''}`,
      remaining: yuan(a.principalRemMinor),
      apr: a.realApr,
      dailyInterest: yuan(dailyInterestMinor), // 每日利息（元/天）
      savingsMultiple: a.realApr > 0 ? Math.round((a.realApr / 2) * 10) / 10 : null, // 是储蓄收益（2%）的几倍
      nextDue: a.currentStatement?.dueDate ?? null,
      dueMinor: yuan(a.dueMinor),
      minPayment: yuan(a.minPaymentMinor),
      isMinOnly: a.isMinOnly,
      clearDays,
      clearDate,
    })
  }
  return {
    hasDebt: snap.creditPrincipalMinor > 0,
    total: yuan(snap.creditPrincipalMinor),
    dueTotal: yuan(snap.currentDueMinor),
    avgApr: snap.avgRealApr,
    totalDailyInterest: yuan(totalDailyInterestMinor),
    items,
  }
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

async function getRecentTransactions(args: Record<string, unknown>, ctx?: ToolExecCtx): Promise<object> {
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
  // 隐私分层（核心脱敏点）：单笔明细中的商户名档1/档2 一律 →「某商户」，
  // 金额/时间/类别保留供引用；档3（用户主动查明细）才返回完整商户名。
  return maskToolResult({ count: items.length, items }, tierOf(ctx)) as object
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

// ==================== 消费认知复盘（AI 助手）查询/存档工具 ====================

/** 占比 → 等级（低/中/高/极高），前台不展示 0-100 数字 */
function levelOf(pct: number, lo: number, mid: number, hi: number): string {
  if (pct < lo) return '低'
  if (pct < mid) return '中'
  if (pct < hi) return '高'
  return '极高'
}

function medianOf(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

/**
 * get_spending_pattern：多维度消费模式聚合（时间/平台/类别/商家/金额/支付方式/节奏）。
 * 全部数字由本地代码从数据库实时算出；等级（低/中/高/极高）由代码映射，AI 只组织语言。
 */
async function getSpendingPattern(args: Record<string, unknown>, ctx?: ToolExecCtx): Promise<object> {
  const days = Math.max(7, Math.min(90, Number(args.days) || 30))
  const txs = await db.transactions.toArray()
  const now = Date.now()
  const cutoff = now - days * 86_400_000
  const exp = txs.filter(t => {
    if (isIncome(t) || isTransfer(t)) return false
    const ts = new Date(t.time).getTime()
    return ts <= now && ts >= cutoff
  })

  // —— 时段分布 ——
  const SLOTS = ['凌晨', '上午', '下午', '晚上', '深夜']
  const slotMap = new Map<string, { count: number; amountMinor: number }>()
  for (const s of SLOTS) slotMap.set(s, { count: 0, amountMinor: 0 })
  for (const t of exp) {
    const s = slotOf(new Date(t.time).getHours())
    const r = slotMap.get(s) ?? { count: 0, amountMinor: 0 }
    r.count++; r.amountMinor += t.amountMinor
    slotMap.set(s, r)
  }
  const night = slotMap.get('深夜') ?? { count: 0, amountMinor: 0 }
  const nightSharePct = exp.length > 0 ? Math.round((night.count / exp.length) * 100) : 0

  // —— 平台 ——
  const platMap = new Map<string, { count: number; amountMinor: number }>()
  for (const t of exp) {
    const p = platformOf(t.merchant)
    if (!p) continue
    const r = platMap.get(p) ?? { count: 0, amountMinor: 0 }
    r.count++; r.amountMinor += t.amountMinor
    platMap.set(p, r)
  }
  const platforms = [...platMap.entries()]
    .map(([platform, r]) => ({ platform, count: r.count, amount: yuan(r.amountMinor), pct: exp.length > 0 ? Math.round((r.count / exp.length) * 100) : 0 }))
    .sort((a, b) => b.amount - a.amount)
  const topPlatformShare = platforms[0]?.pct ?? 0

  // —— 分类 ——
  const catMap = new Map<string, { count: number; amountMinor: number }>()
  for (const t of exp) {
    const r = catMap.get(t.category) ?? { count: 0, amountMinor: 0 }
    r.count++; r.amountMinor += t.amountMinor
    catMap.set(t.category, r)
  }
  const categories = [...catMap.entries()]
    .map(([category, r]) => ({ category, count: r.count, amount: yuan(r.amountMinor) }))
    .sort((a, b) => b.amount - a.amount)

  // —— 商家（Top 5） ——
  const merchantMap = new Map<string, { count: number; amountMinor: number }>()
  for (const t of exp) {
    if (!t.merchant) continue
    const r = merchantMap.get(t.merchant) ?? { count: 0, amountMinor: 0 }
    r.count++; r.amountMinor += t.amountMinor
    merchantMap.set(t.merchant, r)
  }
  const merchants = [...merchantMap.entries()]
    .map(([merchant, r]) => ({ merchant, count: r.count, amount: yuan(r.amountMinor) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)

  // —— 金额偏离：按分类算中位数，标记超 2x / 3x 的单笔 ——
  const catAmounts = new Map<string, number[]>()
  for (const t of exp) {
    const arr = catAmounts.get(t.category) ?? []
    arr.push(t.amountMinor)
    catAmounts.set(t.category, arr)
  }
  const outliers: { merchant: string; amount: number; category: string; times: number; time: string }[] = []
  for (const t of exp) {
    const med = medianOf(catAmounts.get(t.category) ?? [])
    if (med > 0 && t.amountMinor >= med * 2) {
      outliers.push({
        merchant: t.merchant, amount: yuan(t.amountMinor), category: t.category,
        times: Math.round((t.amountMinor / med) * 10) / 10, time: t.time,
      })
    }
  }
  outliers.sort((a, b) => b.times - a.times)

  // —— 支付方式 ——
  const payMap = new Map<string, number>()
  for (const t of exp) payMap.set(t.paymentMethod, (payMap.get(t.paymentMethod) ?? 0) + 1)
  const paymentMethods = [...payMap.entries()]
    .map(([method, count]) => ({ method, count }))
    .sort((a, b) => b.count - a.count)
  const deferredSharePct = exp.length > 0
    ? Math.round((exp.filter(t => ['先用后付', '拼多多先用后付', '分期', '花呗', '京东白条', '抖音月付', '信用卡', '信用支付'].includes(t.paymentMethod)).length / exp.length) * 100)
    : 0

  // —— 消费节奏：日均笔数 / 单日最多笔数 ——
  const dayMap = new Map<string, number>()
  for (const t of exp) dayMap.set(dateKey(t.time), (dayMap.get(dateKey(t.time)) ?? 0) + 1)
  const avgPerDay = days > 0 ? Math.round((exp.length / days) * 10) / 10 : 0
  const maxDay = Math.max(0, ...[...dayMap.values()])

  // 隐私分层：平台分布/时段/类别等聚合统计档1 保留；商家 Top5 与金额偏离单笔的商户名档1/档2 脱敏
  return maskToolResult({
    days,
    totalCount: exp.length,
    totalAmount: yuan(exp.reduce((s, t) => s + t.amountMinor, 0)),
    slots: SLOTS.map(s => ({ slot: s, ...slotMap.get(s)!, amount: yuan((slotMap.get(s) ?? { amountMinor: 0 }).amountMinor) })),
    nightShare: { count: night.count, pct: nightSharePct, level: levelOf(nightSharePct, 15, 30, 50) },
    platforms,
    topPlatform: platforms[0] ? { ...platforms[0], level: levelOf(topPlatformShare, 30, 50, 70) } : null,
    categories,
    merchants,
    outliers: outliers.slice(0, 8),
    paymentMethods,
    deferredShare: { pct: deferredSharePct, level: levelOf(deferredSharePct, 10, 25, 45) },
    rhythm: { avgPerDay, maxDay },
  }, tierOf(ctx)) as object
}

// ==================== 消费事件（同平台爆发 / 超限等，数据由代码算出） ====================

interface AlertEventItem {
  type: 'platform_burst' | 'over_budget' | 'platform_over_limit' | 'deep_night' | 'repeat_merchant'
  /** 严重等级（低/中/高/极高），由代码映射，AI 只组织语言 */
  level: string
  title: string
  detail: string
  date?: string
  platform?: string
  merchant?: string
  amount?: number
  count?: number
}

const LEVEL_RANK: Record<string, number> = { 低: 1, 中: 2, 高: 3, 极高: 4 }
function levelByCount(count: number, lo: number, mid: number, hi: number): string {
  if (count >= hi) return '极高'
  if (count >= mid) return '高'
  if (count >= lo) return '中'
  return '低'
}
function isDeepNightHour(h: number): boolean { return h >= 22 || h < 6 }

/**
 * get_alert_events：获取"消费事件"（同平台爆发 / 预算超限 / 平台超限 / 深夜消费 / 重复购买）。
 * 全部数字由本地代码从数据库实时算出，只返回真实数据；AI 只负责把这些事件拎出来询问/提醒。
 */
async function getAlertEvents(args: Record<string, unknown>, ctx?: ToolExecCtx): Promise<object> {
  const days = Math.max(1, Math.min(90, Number(args.days) || 7))
  const now = new Date()
  const todayKeyStr = dateKey(now.toISOString())
  const cutoff = now.getTime() - days * 86_400_000
  const txs = await db.transactions.toArray()
  const exp = txs.filter(t => {
    if (isIncome(t) || isTransfer(t)) return false
    const ts = new Date(t.time).getTime()
    return ts <= now.getTime() && ts >= cutoff
  })
  const isShop = (t: { category: string }) => ['购物', '娱乐', '虚拟消费'].includes(t.category)

  const events: AlertEventItem[] = []

  // —— ① 同平台爆发：某天同一平台购物类 ≥3 笔 ——
  const burstMap = new Map<string, { platform: string; date: string; count: number; amountMinor: number; merchants: string[] }>()
  for (const t of exp) {
    if (!isShop(t)) continue
    const p = platformOf(t.merchant)
    if (!p) continue
    const key = `${dateKey(t.time)}|${p}`
    const e = burstMap.get(key) ?? { platform: p, date: dateKey(t.time), count: 0, amountMinor: 0, merchants: [] }
    e.count++
    e.amountMinor += t.amountMinor
    if (e.merchants.length < 3 && !e.merchants.includes(t.merchant)) e.merchants.push(t.merchant)
    burstMap.set(key, e)
  }
  for (const e of burstMap.values()) {
    if (e.count < 3) continue
    const isToday = e.date === todayKeyStr
    events.push({
      type: 'platform_burst',
      level: levelByCount(e.count, 3, 5, 8),
      title: `${e.platform}${isToday ? '今天' : e.date.slice(5)}同平台爆发`,
      detail: `${e.platform} 在 ${e.date} 一天内下单 ${e.count} 笔，合计 ¥${yuan(e.amountMinor)}${e.merchants.length > 0 ? `（如：${e.merchants.join('、')}）` : ''}`,
      date: e.date,
      platform: e.platform,
      amount: yuan(e.amountMinor),
      count: e.count,
    })
  }

  // —— ② 预算超限 / 逼近超限 ——
  const budget = await getBudget()
  const mk = monthKey(now)
  let monthSpent = 0
  for (const t of txs) {
    if (isIncome(t) || isTransfer(t)) continue
    if (monthKey(new Date(t.time)) !== mk) continue
    monthSpent += t.amountMinor
  }
  const usedPct = budget > 0 ? Math.round((monthSpent / budget) * 100) : 0
  if (budget > 0 && usedPct >= 90) {
    events.push({
      type: 'over_budget',
      level: usedPct >= 100 ? '极高' : usedPct >= 95 ? '高' : '中',
      title: usedPct >= 100 ? '本月已超支' : '预算接近用完',
      detail: `本月已支出 ¥${yuan(monthSpent)} / 预算 ¥${yuan(budget)}（使用率 ${usedPct}%），剩余 ¥${yuan(Math.max(0, budget - monthSpent))}`,
      amount: yuan(monthSpent),
    })
  }

  // —— ③ 平台每日限额被触发（settings: platformLimit = [{platform, amountMinor}]） ——
  const limitRaw = await getSetting('platformLimit')
  let limitList: { platform: string; amountMinor: number }[] = []
  if (typeof limitRaw === 'string' && limitRaw) {
    try {
      const parsed = JSON.parse(limitRaw)
      if (Array.isArray(parsed)) {
        limitList = parsed.filter((x): x is { platform: string; amountMinor: number } =>
          x && typeof x.platform === 'string' && typeof x.amountMinor === 'number')
      }
    } catch { /* 忽略损坏数据 */ }
  }
  if (limitList.length > 0) {
    const todaySpend = new Map<string, number>()
    for (const t of txs) {
      if (isIncome(t) || isTransfer(t)) continue
      if (dateKey(t.time) !== todayKeyStr) continue
      const p = platformOf(t.merchant)
      if (!p) continue
      todaySpend.set(p, (todaySpend.get(p) ?? 0) + t.amountMinor)
    }
    for (const lim of limitList) {
      const spent = todaySpend.get(lim.platform) ?? 0
      if (lim.amountMinor > 0 && spent >= lim.amountMinor) {
        events.push({
          type: 'platform_over_limit',
          level: spent >= lim.amountMinor * 1.5 ? '高' : '中',
          title: `${lim.platform} 今日已达限额`,
          detail: `今日 ${lim.platform} 已消费 ¥${yuan(spent)}，达到设定限额 ¥${yuan(lim.amountMinor)}`,
          platform: lim.platform,
          amount: yuan(spent),
        })
      }
    }
  }

  // —— ④ 深夜购物消费（窗口内 22:00-06:00 的购物类） ——
  const nightShops = exp.filter(t => isShop(t) && isDeepNightHour(new Date(t.time).getHours()))
  if (nightShops.length >= 3) {
    const nightTotal = nightShops.reduce((s, t) => s + t.amountMinor, 0)
    events.push({
      type: 'deep_night',
      level: levelByCount(nightShops.length, 3, 6, 10),
      title: '深夜购物偏多',
      detail: `近 ${days} 天深夜（22:00-06:00）购物类消费 ${nightShops.length} 笔，合计 ¥${yuan(nightTotal)}`,
      amount: yuan(nightTotal),
      count: nightShops.length,
    })
  }

  // —— ⑤ 重复购买：近30天同一商家 ≥3 笔 ——
  const m30Cutoff = now.getTime() - 30 * 86_400_000
  const m30 = txs.filter(t => {
    if (isIncome(t) || isTransfer(t)) return false
    const ts = new Date(t.time).getTime()
    return ts <= now.getTime() && ts >= m30Cutoff
  })
  const merchantMap = new Map<string, { count: number; amountMinor: number; lastTime: string }>()
  for (const t of m30) {
    if (!t.merchant) continue
    const e = merchantMap.get(t.merchant) ?? { count: 0, amountMinor: 0, lastTime: t.time }
    e.count++
    e.amountMinor += t.amountMinor
    if (t.time > e.lastTime) e.lastTime = t.time
    merchantMap.set(t.merchant, e)
  }
  const repeatMerchants = [...merchantMap.entries()]
    .filter(([, e]) => e.count >= 3)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3)
  for (const [merchant, e] of repeatMerchants) {
    events.push({
      type: 'repeat_merchant',
      level: levelByCount(e.count, 3, 6, 10),
      title: `「${merchant}」重复购买`,
      detail: `近30天在「${merchant}」消费 ${e.count} 笔，合计 ¥${yuan(e.amountMinor)}（最近一次 ${dateKey(e.lastTime)}）`,
      merchant,
      amount: yuan(e.amountMinor),
      count: e.count,
    })
  }

  events.sort((a, b) => (LEVEL_RANK[b.level] ?? 0) - (LEVEL_RANK[a.level] ?? 0))
  // 隐私分层：事件标题/详情/字段里含商户名与平台名 → 档1 商户脱敏（平台保留为聚合）、档2 两者都脱敏
  return maskToolResult({ days, today: todayKeyStr, count: events.length, events }, tierOf(ctx)) as object
}

/** get_behavior_profile：读取已积累的消费画像（统计转等级 + 逐次复盘笔记） */
async function getBehaviorProfileTool(): Promise<object> {
  const p = await getProfile()
  const events = await db.consumerEvents.toArray()
  const d30 = events.filter(e => Date.now() - new Date(e.time).getTime() <= 30 * 86_400_000).length
  const notes = (p.coachNotes ?? []).slice(-20).map(n => ({
    ts: n.ts, type: n.type, tag: n.tag, content: n.content, dataRef: n.dataRef ?? null,
  }))
  return {
    stats: {
      baseEventCount30: d30,
      nightRisk: { pct: p.nightRisk, level: levelOf(p.nightRisk, 15, 35, 55) },
      discountSensitivity: { pct: p.discountSensitivity, level: levelOf(p.discountSensitivity, 20, 40, 60) },
      repeatRisk: { pct: p.repeatRisk, level: levelOf(p.repeatRisk, 20, 40, 60) },
      impulseProbability: { pct: p.impulseProbability, level: levelOf(p.impulseProbability, 15, 30, 50) },
      delayedGratification: { pct: p.delayedGratification, level: levelOf(p.delayedGratification, 30, 55, 75) },
      highRiskWindows: p.highRiskWindows,
      highRiskCategories: p.highRiskCategories,
      avgPurchaseQuality: p.avgPurchaseQuality,
    },
    notes,
  }
}

/** save_behavior_notes：把用户关键回答/洞察写入画像存档（供下次复盘引用） */
async function saveBehaviorNotesTool(args: Record<string, unknown>): Promise<object> {
  const content = String(args.content ?? '').trim()
  if (!content) return { success: false, error: '存档内容为空' }
  const type = String(args.type ?? 'review') as CoachNote['type']
  const tag = args.tag ? String(args.tag).slice(0, 30) : null
  const dataRef = args.dataRef ? String(args.dataRef).slice(0, 200) : null
  const saved = await addCoachNote({ type, tag, content: content.slice(0, 500), dataRef })
  return { success: true, saved }
}

/** get_debt_summary：负债概况（总额 + 各项待还 + 最近还款日） */
async function getDebtSummary(): Promise<object> {
  return getDebts()
}

// ==================== F5 知识库检索 / 反馈卡入队工具 ====================

/** 周反馈上限（#14）：每周反馈卡（正面+负面合计）≤ 3 条，超出只存档不打扰 */
const WEEKLY_FEEDBACK_LIMIT = 3

/** 本周一 00:00（本地时间）的 ISO 字符串，用于周上限统计 */
function mondayOfThisWeek(): string {
  const now = new Date()
  const diff = now.getDay() === 0 ? 6 : now.getDay() - 1 // 周日算上周一
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff, 0, 0, 0, 0)
  return monday.toISOString()
}

/** 次日 09:00（本地时间）的 ISO 字符串（F5 7.3⑨：反馈卡次日 09:00 展示） */
function nextMorningNine(): string {
  const now = new Date()
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0)
  return t.toISOString()
}

/**
 * search_knowledge（F5 7.3⑤）：用 Agent 的推理语境到知识库做"情境检索"（非关键词硬匹配）。
 * 返回命中条目（thesis / 人话科普 / 动作模板 / citation）。
 * 纪律：citation 仅供"了解更多"折叠区展示（F5 7.5.3），禁止写进反馈正文。
 */
async function searchKnowledgeTool(args: Record<string, unknown>): Promise<object> {
  const context = String(args.context ?? '').trim()
  if (!context) return { count: 0, note: '缺少检索语境', hits: [] }
  await ensureKnowledgeSeeded()
  const hits = await searchKnowledge(context, {
    limit: 3,
    patternKey: args.patternKey ? String(args.patternKey) : null,
  })
  return {
    count: hits.length,
    note: '命中条目的 citation 仅供"了解更多"折叠区使用，禁止写进反馈正文',
    hits: hits.map(h => ({
      id: h.ref.id,
      concept: h.ref.concept,
      thesis: h.ref.thesis,
      plain_explanation: h.ref.plain_explanation,
      action_templates: h.ref.action_templates,
      citation: h.ref.citation,
      effect: h.effect, // 历史效果：effective=此前有效 / ineffective=此前无效
    })),
  }
}

/**
 * queue_feedback_card（F5 7.3⑨ 入队反馈卡）：Agent 表达"有必要提醒"的工作流工具。
 * - 触发对象：对象A=欲望清单犹豫≥14天或反复进出≥2次最终仍购买；对象B=AI 判定冲动高且用户对话中明确承认陷阱
 * - 周上限（#14）：本周已入队（feedback_logs）≥3 条 → 拒绝入队，只记画像不打扰
 * - 成功：写 feedback_logs（⑩ 效果回查） + agent_inbox（scheduledAt=次日 09:00）
 */
async function queueFeedbackCardTool(args: Record<string, unknown>): Promise<object> {
  const title = String(args.title ?? '').trim()
  const opening = String(args.opening ?? '').trim()
  const hypothesis = String(args.hypothesis ?? '').trim()
  const patternKey = String(args.patternKey ?? '').trim()
  const beforeMinor = Math.max(0, Math.round(Number(args.beforeMinor) || 0))
  const objectType = args.objectType === 'event' ? 'event' : 'wishlist'
  const objectId = String(args.objectId ?? '').trim()
  const knowledgeRefId = args.knowledgeRefId ? String(args.knowledgeRefId) : null
  const type = args.type === 'positive' ? 'positive' : 'negative'
  if (!title || !opening || !objectId) {
    return { queued: false, reason: 'missing_params', error: '缺少必填参数（title/opening/objectId）' }
  }

  // 周上限检查（#14）：本周已入队反馈卡 ≥3 条则拒绝（logs 每卡一条，为计数源）
  const weekStart = mondayOfThisWeek()
  const logs = await getAllFeedbackLogs()
  const weekCount = logs.filter(l => l.createdAt >= weekStart).length
  if (weekCount >= WEEKLY_FEEDBACK_LIMIT) {
    return { queued: false, reason: 'weekly_limit', message: `本周反馈卡已达上限（${WEEKLY_FEEDBACK_LIMIT} 条），只记录不打扰` }
  }

  const now = new Date().toISOString()
  const scheduledAt = nextMorningNine()
  const inboxId = await addAgentInboxItem({
    kind: 'feedback_card',
    objectType,
    objectId,
    title,
    opening,
    knowledgeRefId,
    feedbackLogId: null,
    scheduledAt,
    status: 'pending',
    rounds: 0,
    createdAt: now,
    updatedAt: now,
  })
  const logId = await addFeedbackLog({
    inboxId,
    type,
    objectType,
    objectId,
    knowledgeRefId,
    hypothesis,
    opening,
    patternKey,
    beforeMinor,
    afterMinor: null,
    effectStatus: null,
    effectCheckedAt: null,
    rounds: 0,
    createdAt: now,
    updatedAt: now,
  })
  await updateAgentInboxItem(inboxId, { feedbackLogId: logId })
  return { queued: true, inboxId, logId, scheduledAt, title }
}

/** 复盘对话可调用的工具名（只读查询 + 笔记存档 + 知识检索 + 反馈入队；写交易/清单等普通工具不给复盘对话） */
export const COACH_TOOL_NAMES = [
  'get_recent_transactions',
  'get_spending_pattern',
  'get_alert_events',
  'get_budget_status',
  'get_debt_summary',
  'get_savings',
  'get_schedules',
  'get_behavior_profile',
  'save_behavior_notes',
  'search_knowledge',
  'queue_feedback_card',
]

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
    description: '获取负债总览（总额与各项待还金额、真实年化、每日利息、本期应还/最低还款、最近还款日、清零日估算）。纪律：只能使用返回的数据；利率/金额/天数/日期四字段尤其严格，未返回的数字一律不得输出，数据不足就明说，绝不估算编造',
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
    name: 'get_spending_pattern',
    description: '获取近 N 天多维度消费模式画像（时段分布/平台/分类/商家Top5/金额偏离/支付方式/消费节奏），含深夜占比、头号平台占比、信用支付占比的等级（低/中/高/极高）',
    parameters: objSchema({ days: { type: 'number', description: '天数，默认 30，范围 7~90' } }),
    execute: getSpendingPattern,
  },
  {
    name: 'get_alert_events',
    description: '获取"消费事件"（同平台爆发/预算超限/平台每日限额触发/深夜购物偏多/重复购买），按严重等级（低/中/高/极高）降序排列，用于主动拎出需要关注的消费事件。参数 days：统计窗口天数，默认 7，范围 1~90',
    parameters: objSchema({ days: { type: 'number', description: '统计天数，默认 7，范围 1~90' } }),
    execute: getAlertEvents,
  },
  {
    name: 'get_behavior_profile',
    description: '读取用户已积累的消费画像（各风险指标等级、高风险时段/分类、购买质量）与历次复盘笔记（供开场引用"上次你说…"）',
    parameters: objSchema({}),
    execute: getBehaviorProfileTool,
  },
  {
    name: 'save_behavior_notes',
    description: '把用户关键回答/洞察/自我标记写入消费画像存档（供下次复盘引用）。type：onboarding/review/self_label/reflection；tag：消费习惯/场景触发/存钱目标/风险点/自我认知/模式命名',
    parameters: objSchema({
      content: { type: 'string', description: '存档内容（用户原话或提炼的洞察结论）' },
      type: { type: 'string', description: 'onboarding/review/self_label/reflection' },
      tag: { type: 'string', description: '主题标签：消费习惯/场景触发/存钱目标/风险点/自我认知/模式命名，可选' },
      dataRef: { type: 'string', description: '引用的真实数据描述（如"深夜订单 3 笔 ¥128"），可选' },
    }, ['content']),
    execute: saveBehaviorNotesTool,
  },
  {
    name: 'get_debt_summary',
    description: '获取负债概况（总额/本期应还/加权年化/总每日利息，各账户待还/真实年化/每日利息/还款日/清零日）。纪律：只能使用返回的数据；利率/金额/天数/日期四字段尤其严格，未返回的数字一律不得输出；不确定就再调一次本工具查证；数据不足就明说，绝不估算编造',
    parameters: objSchema({}),
    execute: getDebtSummary,
  },
  {
    name: 'search_knowledge',
    description: '知识库检索（F5）：输入你的推理语境（context），返回最相关的心理/行为概念条目（含人话科普 plain_explanation、可落地动作 action_templates、出处 citation）。用于给反馈找理论支撑时翻"图书馆"。纪律：citation 仅供"了解更多"折叠区，禁止写进正文',
    parameters: objSchema({
      context: { type: 'string', description: '你的推理语境/假设描述（如"用户犹豫了14天最后还是买了，且给自己找了很多理由"）' },
      patternKey: { type: 'string', description: '模式标识（如"深夜购物"），可选，用于带上历史反馈效果' },
    }, ['context']),
    execute: searchKnowledgeTool,
  },
  {
    name: 'queue_feedback_card',
    description: '入队一张反馈卡（F5）：当确认反馈对象（对象A=欲望清单犹豫≥14天或反复进出≥2次仍购买；对象B=冲动高且用户对话中明确承认陷阱）时调用。参数：title 标题、opening 开场（一个数据观察+一个开放问题，禁止结论）、hypothesis 假设、patternKey 模式标识、beforeMinor 该模式反馈前金额（分）、objectType wishlist/event、objectId 对应记录id、knowledgeRefId 检索命中的知识条目id（可选）、type positive/negative（默认 negative）。周上限 3 条由代码强制，超出自动拒绝',
    parameters: objSchema({
      title: { type: 'string', description: '卡片标题' },
      opening: { type: 'string', description: '开场：一个数据观察 + 一个开放问题，不下结论' },
      hypothesis: { type: 'string', description: '当前假设（供效果回查）' },
      patternKey: { type: 'string', description: '模式标识（如"深夜购物"/"犹豫后购买"）' },
      beforeMinor: { type: 'number', description: '该模式反馈前消费金额（单位：分）' },
      objectType: { type: 'string', description: 'wishlist（对象A）/ event（对象B）' },
      objectId: { type: 'string', description: '欲望清单条目 id 或消费事件 id' },
      knowledgeRefId: { type: 'string', description: '知识库命中条目 id（可选）' },
      type: { type: 'string', description: 'positive=进步正面反馈 / negative=问题反馈，默认 negative' },
    }, ['title', 'opening', 'hypothesis', 'patternKey', 'beforeMinor', 'objectType', 'objectId']),
    execute: queueFeedbackCardTool,
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

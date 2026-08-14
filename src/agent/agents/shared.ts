// ==================== 各 Agent 共享的实时数据计算 ====================

import { db } from '../../db/database'
import { getSetting } from '../../db/crud'
import { isImpulsive } from '../../utils/impulseEngine'

const BUDGET_KEY = 'monthlyBudget'
const DEFAULT_BUDGET = 1000_00
const DAY = 86_400_000

export function pad2(n: number): string { return String(n).padStart(2, '0') }

export function monthKey(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}` }

export function dateKey(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }

export function yuan(minor: number): number { return Math.round((minor / 100) * 100) / 100 }

export function fmtYuan(minor: number): string {
  return (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })
}

export function isIncome(t: { txType?: string }): boolean { return t.txType === 'income' }

export function isTransfer(t: { note?: string }): boolean { return t.note === '储蓄转入' }

export function isExpense(t: { txType?: string; note?: string }): boolean { return !isIncome(t) && !isTransfer(t) }

async function getBudget(): Promise<number> {
  const raw = await getSetting(BUDGET_KEY)
  return typeof raw === 'number' && raw > 0 ? raw : DEFAULT_BUDGET
}

export interface MonthOverview {
  budgetMinor: number
  spentMinor: number
  remainingMinor: number
  incomeMinor: number
  impulseCount: number
  impulseMinor: number
  perDayMinor: number
}

/** 本月收支/预算/冲动概览（实时） */
export async function getMonthOverview(): Promise<MonthOverview> {
  const txs = await db.transactions.toArray()
  const mk = monthKey(new Date())
  let spent = 0
  let income = 0
  let impulseCount = 0
  let impulseMinor = 0
  for (const t of txs) {
    if (monthKey(new Date(t.time)) !== mk) continue
    if (isIncome(t)) { income += t.amountMinor; continue }
    if (isTransfer(t)) continue
    spent += t.amountMinor
    if (isImpulsive(t.impulseLevel)) { impulseCount++; impulseMinor += t.amountMinor }
  }
  const budget = await getBudget()
  const now = new Date()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const daysLeft = Math.max(1, daysInMonth - now.getDate())
  return {
    budgetMinor: budget,
    spentMinor: spent,
    remainingMinor: budget - spent,
    incomeMinor: income,
    impulseCount,
    impulseMinor,
    perDayMinor: Math.max(0, Math.round((budget - spent) / daysLeft)),
  }
}

export interface RecentTx {
  merchant: string
  amountMinor: number
  category: string
  time: string
  impulseLevel: string
}

/** 最近 n 条支出（实时） */
export async function getRecentTx(n = 6): Promise<RecentTx[]> {
  const txs = await db.transactions.toArray()
  return txs
    .filter(t => isExpense(t))
    .sort((a, b) => (a.time < b.time ? 1 : -1))
    .slice(0, n)
    .map(t => ({
      merchant: t.merchant,
      amountMinor: t.amountMinor,
      category: t.category,
      time: t.time,
      impulseLevel: t.impulseLevel,
    }))
}

export interface CategoryRow {
  category: string
  amountMinor: number
  count: number
  percent: number
}

/** 近 days 天分类支出 Top（实时） */
export async function getCategoryBreakdown(days = 30): Promise<CategoryRow[]> {
  const txs = await db.transactions.toArray()
  const now = Date.now()
  const map = new Map<string, { amount: number; count: number }>()
  let total = 0
  for (const t of txs) {
    if (!isExpense(t)) continue
    const ts = new Date(t.time).getTime()
    if (ts > now || now - ts > days * DAY) continue
    const row = map.get(t.category) ?? { amount: 0, count: 0 }
    row.amount += t.amountMinor
    row.count++
    map.set(t.category, row)
    total += t.amountMinor
  }
  return [...map.entries()]
    .map(([category, e]) => ({ category, amountMinor: e.amount, count: e.count, percent: total > 0 ? Math.round((e.amount / total) * 100) : 0 }))
    .sort((a, b) => b.amountMinor - a.amountMinor)
}

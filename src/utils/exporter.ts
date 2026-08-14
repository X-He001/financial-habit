import { db } from '../db/database'
import { getAllSettings, getSetting, getAllBalanceSnapshots } from '../db/crud'
import { computeFragileWindows, getFragileWindowNow } from '../agent/metrics'
import { commitmentProgress } from './commitmentEngine'
import { isImpulsive } from './impulseEngine'
import { buildDebtSnapshot } from '../debt/debtContext'

// ==================== 工具 ====================

function pad2(n: number): string { return String(n).padStart(2, '0') }

function dateKey(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }

function monthKey(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}` }

function daysInMonth(y: number, m: number): number { return new Date(y, m + 1, 0).getDate() }

function fmt(minor: number): string { return '¥' + (minor / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 }) }

function isIncome(tx: { txType?: string }): boolean { return tx.txType === 'income' }

function isTransfer(tx: { note?: string }): boolean { return tx.note === '储蓄转入' }

// ==================== 桌宠 summary.json ====================

export interface DeskPetSummary {
  date: string
  summary: {
    monthlyBudget: number
    spentThisMonth: number
    remainingThisMonth: number
    todaySpent: number
    savingsCurrent: number
    savingsTarget: number
    savingsPercent: number
    totalDebt: number
    impulseCountThisMonth: number
    impulseTotalThisMonth: number
    netWorth: number
    daysLeftThisMonth: number
    dailyAllowance: number
    upcomingSchedules: { name: string; amount: number; date: string; type: string }[]
    activeCommitment: string | null
    commitmentProgress: string | null
    fragileWindows: string[]
  }
  deskPetMessage: string
  alerts: string[]
}

/** 从数据库实时计算桌宠需要的 JSON（金额单位：元） */
export async function buildSummaryJson(): Promise<DeskPetSummary> {
  const now = new Date()
  const mk = monthKey(now)
  const today = dateKey(now)

  const [txs, goals, schedules, commitments, snaps, budgetRaw, fragileRaw] = await Promise.all([
    db.transactions.toArray(),
    db.savingsGoals.toArray(),
    db.schedules.toArray(),
    db.commitments.toArray(),
    getAllBalanceSnapshots(),
    getSetting('monthlyBudget'),
    getSetting('fragileWindows'),
  ])

  // 本月支出 / 今日支出 / 冲动统计
  let spentThisMonth = 0
  let todaySpent = 0
  let impulseCount = 0
  let impulseTotal = 0
  for (const tx of txs) {
    if (isIncome(tx) || isTransfer(tx)) continue
    const k = dateKey(new Date(tx.time))
    if (k.startsWith(mk)) spentThisMonth += tx.amountMinor
    if (k === today) todaySpent += tx.amountMinor
    if (k.startsWith(mk) && isImpulsive(tx.impulseLevel)) {
      impulseCount++
      impulseTotal += tx.amountMinor
    }
  }

  const monthlyBudget = typeof budgetRaw === 'number' ? budgetRaw : 1000_00
  const remaining = Math.max(0, monthlyBudget - spentThisMonth)
  const dInMonth = daysInMonth(now.getFullYear(), now.getMonth())
  const daysLeft = dInMonth - now.getDate()
  const dailyAllowance = daysLeft > 0 ? remaining / 100 / daysLeft : 0

  // 储蓄
  const goal = goals.find(g => g.isActive) ?? goals[0] ?? null
  const savingsCurrent = goal?.currentMinor ?? 0
  const savingsTarget = goal?.targetMinor ?? 0
  const savingsPercent = savingsTarget > 0 ? Math.round((savingsCurrent / savingsTarget) * 100) : 0

  // 负债（统一口径：旧自定义债务 + 花呗/白条等负债账户待还，与债务页/净资产一致）
  const debtSnap = await buildDebtSnapshot()
  const totalDebt = debtSnap.creditPrincipalMinor

  // 净资产（最近快照）
  let netWorth = 0
  if (snaps.length > 0) {
    const sorted = [...snaps].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
    const last = sorted[0]
    netWorth = last.cashMinor + last.bankMinor + last.wechatMinor + last.alipayMinor + last.otherMinor - last.liabilityMinor
  }

  // 未来日程（30天内）
  const upcomingSchedules = schedules
    .map(s => ({ name: s.name, amount: s.amountMinor / 100, date: s.date, type: s.type }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 8)

  // 承诺
  let activeCommitment: string | null = null
  let commitmentText: string | null = null
  const active = commitments.find(c => c.status === 'active')
  if (active) {
    activeCommitment = active.text
    const p = await commitmentProgress(active)
    commitmentText = `已花${fmt(p.spentMinor)}/${fmt(p.targetMinor)}`
  }

  // 高频窗口（读已存，没有则算一次）
  let fragileWindows: string[] = []
  if (typeof fragileRaw === 'string') {
    try {
      const list = JSON.parse(fragileRaw) as { label: string }[]
      if (Array.isArray(list)) fragileWindows = list.map(w => w.label)
    } catch { /* ignore */ }
  }
  if (fragileWindows.length === 0) {
    try {
      fragileWindows = (await computeFragileWindows()).map(w => w.label)
    } catch { /* ignore */ }
  }

  // 提示文案
  const msgParts: string[] = []
  msgParts.push(`你这个月还剩${fmt(remaining)}`)
  if (savingsTarget > 0) msgParts.push(`已存${fmt(savingsCurrent)}/${fmt(savingsTarget)}（${savingsPercent}%）`)
  if (totalDebt > 0) msgParts.push(`负债${fmt(totalDebt)}`)
  else msgParts.push('零负债')
  const deskPetMessage = msgParts.join('，') + '！继续保持~'

  const alerts: string[] = []
  if (impulseCount > 0) alerts.push(`本月已有 ${impulseCount} 笔冲动消费（共${fmt(impulseTotal)}），注意冷静`)
  const fragileNow = await getFragileWindowNow()
  if (fragileNow) alerts.push(`深夜是高危时段（${fragileNow.label}，占冲动${fragileNow.share}%），注意冷静`)
  if (alerts.length === 0) alerts.push('一切正常，继续保持！')

  return {
    date: today,
    summary: {
      monthlyBudget: monthlyBudget / 100,
      spentThisMonth: spentThisMonth / 100,
      remainingThisMonth: remaining / 100,
      todaySpent: todaySpent / 100,
      savingsCurrent: savingsCurrent / 100,
      savingsTarget: savingsTarget / 100,
      savingsPercent,
      totalDebt: totalDebt / 100,
      impulseCountThisMonth: impulseCount,
      impulseTotalThisMonth: impulseTotal / 100,
      netWorth: netWorth / 100,
      daysLeftThisMonth: daysLeft,
      dailyAllowance: Math.round(dailyAllowance * 100) / 100,
      upcomingSchedules,
      activeCommitment,
      commitmentProgress: commitmentText,
      fragileWindows,
    },
    deskPetMessage,
    alerts,
  }
}

// ==================== 全量数据备份 / 恢复 ====================

export interface BackupData {
  transactions: unknown[]
  accounts: unknown[]
  savingsGoals: unknown[]
  sinkingFunds: unknown[]
  wishlist: unknown[]
  wishlistChats: unknown[]
  debts: unknown[]
  savingsRules: unknown[]
  notificationLogs: unknown[]
  categories: unknown[]
  schedules: unknown[]
  settings: unknown[]
  balanceSnapshots: unknown[]
  commitments: unknown[]
  moods: unknown[]
  consumerEvents: unknown[]
  decisionRecords: unknown[]
  behaviorProfiles: unknown[]
  insights: unknown[]
  creditAccounts: unknown[]
  creditStatements: unknown[]
  installments: unknown[]
}

export interface BackupFile {
  app: string
  version: number
  exportedAt: string
  data: BackupData
}

const TABLE_KEYS: (keyof BackupData)[] = [
  'transactions', 'accounts', 'savingsGoals', 'sinkingFunds', 'wishlist', 'wishlistChats',
  'debts', 'savingsRules', 'notificationLogs', 'categories', 'schedules', 'settings',
  'balanceSnapshots', 'commitments', 'moods',
  'consumerEvents', 'decisionRecords', 'behaviorProfiles', 'insights',
  'creditAccounts', 'creditStatements', 'installments',
]

/** 读取全部表 → 组装备份 JSON */
export async function buildFullBackup(): Promise<BackupFile> {
  const [transactions, accounts, savingsGoals, sinkingFunds, wishlist, wishlistChats,
    debts, savingsRules, notificationLogs, categories, schedules, settings,
    balanceSnapshots, commitments, moods,
    consumerEvents, decisionRecords, behaviorProfiles, insights,
    creditAccounts, creditStatements, installments] = await Promise.all([
    db.transactions.toArray(), db.accounts.toArray(), db.savingsGoals.toArray(),
    db.sinkingFunds.toArray(), db.wishlist.toArray(), db.wishlistChats.toArray(),
    db.debts.toArray(), db.savingsRules.toArray(), db.notificationLogs.toArray(),
    db.categories.toArray(), db.schedules.toArray(), getAllSettings(),
    db.balanceSnapshots.toArray(), db.commitments.toArray(), db.moods.toArray(),
    db.consumerEvents.toArray(), db.decisionRecords.toArray(), db.behaviorProfiles.toArray(), db.insights.toArray(),
    db.creditAccounts.toArray(), db.creditStatements.toArray(), db.installments.toArray(),
  ])

  return {
    app: 'financial-habit',
    version: 2,
    exportedAt: new Date().toISOString(),
    data: {
      transactions, accounts, savingsGoals, sinkingFunds, wishlist, wishlistChats,
      debts, savingsRules, notificationLogs, categories, schedules, settings,
      balanceSnapshots, commitments, moods,
      consumerEvents, decisionRecords, behaviorProfiles, insights,
      creditAccounts, creditStatements, installments,
    },
  }
}

export interface ImportStats {
  [key: string]: number
}

/**
 * 导入备份。
 * mode='overwrite'：清空每张表后批量写入；
 * mode='merge'：跳过已存在的 id，仅插入新记录（去重合并）。
 * 返回每张表的处理条数。
 */
export async function importFullBackup(file: BackupFile, mode: 'overwrite' | 'merge' = 'overwrite'): Promise<ImportStats> {
  const stats: ImportStats = {}
  for (const key of TABLE_KEYS) {
    const rows = (file.data?.[key] ?? []) as Record<string, unknown>[]
    const table = db[key] as unknown as { clear(): Promise<void>; bulkPut(items: unknown[]): Promise<void>; toArray(): Promise<unknown[]> }
    if (!table) continue
    if (mode === 'overwrite') {
      await table.clear()
      if (rows.length > 0) {
        await table.bulkPut(rows)
        stats[key] = rows.length
      }
      continue
    }
    // merge：去重合并
    if (rows.length > 0) {
      const existing = new Set((await table.toArray()).map((r) => (r as { id?: unknown }).id))
      const fresh = rows.filter((r) => !existing.has(r.id))
      if (fresh.length > 0) {
        await table.bulkPut(fresh)
        stats[key] = fresh.length
      }
    }
  }
  return stats
}

/** 触发浏览器下载 Blob */
export function downloadJson(filename: string, obj: unknown): void {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

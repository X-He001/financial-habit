// =====================================================================
// 后端 API 封装（src/sync/api.ts）
// 统一管理所有后端接口调用
//
// baseUrl 解析优先级：
//   1. build 时设置 VITE_API_URL（如 VITE_API_URL=https://your-server.com）
//   2. 默认同源（不写就用当前域名，前后端一体部署时正好）
//   3. 运行时可在设置页覆盖（存 IndexedDB，pushSync 会调 setBaseUrl）
// =====================================================================

// 生产构建时可用 VITE_API_URL 指定后端地址；默认同源（相对路径）
const ENV_BASE_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? ''

let _baseUrl = ENV_BASE_URL

export function getBaseUrl(): string {
  return _baseUrl.replace(/\/+$/, '')
}

export function setBaseUrl(url: string): void {
  _baseUrl = url.trim().replace(/\/+$/, '')
}

import { getClientId } from './clientId'

// ----- 通用请求工具 -----

async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  const url = `${getBaseUrl()}${path}`
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      // 携带客户端标识：服务端写入后广播 by=本端 id，前端可忽略自身变更
      'x-client-id': getClientId(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

// ----- 健康检查 -----

export interface HealthResult {
  status: string
}

export function checkHealth(): Promise<HealthResult> {
  return request<HealthResult>('/api/health', 'GET')
}

// ----- 交易 (transactions) -----

export interface Transaction {
  id: string
  amountMinor: number
  category: string
  merchant: string
  time: string
  txType: string
  paymentMethod: string
  source: string
  impulseScore: number
  impulseLevel: string
  isRevoked: boolean
  revokedAt?: string | null
  regretValue?: boolean | null
  regretAt?: string | null
  importId?: string | null
  note: string
  screenshot?: string | null
  fundingSource?: string | null
  lienAccountId?: string | null
  createdAt: string
}

export function fetchTransactions(): Promise<Transaction[]> {
  return request<Transaction[]>('/api/transactions', 'GET')
}

export function saveTransaction(data: Partial<Transaction>): Promise<Transaction> {
  return request<Transaction>('/api/transactions', 'POST', data)
}

export function updateTransaction(id: string, data: Partial<Transaction>): Promise<Transaction> {
  return request<Transaction>(`/api/transactions/${encodeURIComponent(id)}`, 'PUT', data)
}

export function deleteTransaction(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/transactions/${encodeURIComponent(id)}`, 'DELETE')
}

// ----- 储蓄目标 (savings-goals) -----

export interface SavingsGoal {
  id: string
  name: string
  reason: string
  image?: string | null
  targetMinor: number
  currentMinor: number
  milestones: string // JSON array
  deadline?: string | null
  isActive: boolean
  revokedContributionsMinor: number
}

export function fetchSavingsGoals(): Promise<SavingsGoal[]> {
  return request<SavingsGoal[]>('/api/savings-goals', 'GET')
}

export function saveSavingsGoal(data: Partial<SavingsGoal>): Promise<SavingsGoal> {
  return request<SavingsGoal>('/api/savings-goals', 'POST', data)
}

export function updateSavingsGoal(id: string, data: Partial<SavingsGoal>): Promise<SavingsGoal> {
  return request<SavingsGoal>(`/api/savings-goals/${encodeURIComponent(id)}`, 'PUT', data)
}

export function deleteSavingsGoal(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/savings-goals/${encodeURIComponent(id)}`, 'DELETE')
}

// ----- 债务 (debts) -----

export interface Debt {
  id: string
  name: string
  remainingMinor: number
  aprXirr: number
  nextDue?: string | null
  strategy: string
}

export function fetchDebts(): Promise<Debt[]> {
  return request<Debt[]>('/api/debts', 'GET')
}

export function saveDebt(data: Partial<Debt>): Promise<Debt> {
  return request<Debt>('/api/debts', 'POST', data)
}

export function updateDebt(id: string, data: Partial<Debt>): Promise<Debt> {
  return request<Debt>(`/api/debts/${encodeURIComponent(id)}`, 'PUT', data)
}

export function deleteDebt(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/debts/${encodeURIComponent(id)}`, 'DELETE')
}

// ----- 日程 (schedules) -----

export interface Schedule {
  id: string
  name: string
  type: string
  amountMinor: number
  date: string
  repeat: string
  note: string
  notified: boolean
}

export function fetchSchedules(): Promise<Schedule[]> {
  return request<Schedule[]>('/api/schedules', 'GET')
}

export function saveSchedule(data: Partial<Schedule>): Promise<Schedule> {
  return request<Schedule>('/api/schedules', 'POST', data)
}

export function updateSchedule(id: string, data: Partial<Schedule>): Promise<Schedule> {
  return request<Schedule>(`/api/schedules/${encodeURIComponent(id)}`, 'PUT', data)
}

export function deleteSchedule(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/schedules/${encodeURIComponent(id)}`, 'DELETE')
}

// ----- 设置 (settings) -----

export interface Setting {
  id: string
  value: string
}

export function fetchSettings(): Promise<Setting[]> {
  return request<Setting[]>('/api/settings', 'GET')
}

export function saveSetting(data: { id: string; value: string }): Promise<Setting> {
  return request<Setting>('/api/settings', 'POST', data)
}

export function updateSetting(id: string, data: { value: string }): Promise<Setting> {
  return request<Setting>(`/api/settings/${encodeURIComponent(id)}`, 'PUT', data)
}

export function deleteSetting(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/settings/${encodeURIComponent(id)}`, 'DELETE')
}

// ----- 仪表盘汇总 (dashboard-summary) -----

export interface DashboardSummary {
  date: string
  summary: Record<string, unknown>
  deskPetMessage: string
  alerts: string[]
}

export function fetchDashboardSummary(): Promise<DashboardSummary> {
  return request<DashboardSummary>('/api/dashboard-summary', 'GET')
}

// ----- 数据同步（云端全量拉取） -----

/** GET /api/sync/pull 返回的全部业务表数据（键名与 IndexedDB 表名一致） */
export interface PullData {
  transactions: unknown[]
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

export interface PullResponse {
  success: boolean
  data: PullData
}

/** 从云端拉取全部业务表数据（覆盖本地用） */
export function fetchSyncPull(): Promise<PullResponse> {
  return request<PullResponse>('/api/sync/pull', 'GET')
}

// ----- 数据同步（批量推送） -----

/** 单表推送统计（服务器返回） */
export interface PushTableStats {
  pushed: number
  updated: number
  skipped: number
  failed: number
}

export interface PushResponse {
  success: boolean
  total: number
  byTable: Record<string, PushTableStats>
}

/**
 * 批量推送：POST /api/sync/push，把各同步表的本地快照一次性发给云端。
 * 服务器按行 INSERT OR REPLACE（同 id 即视为更新），行级「最后写入优先」。
 * 返回每表的 pushed / updated / skipped / failed 统计。
 */
export function fetchSyncPush(tables: Record<string, unknown[]>): Promise<PushResponse> {
  return request<PushResponse>('/api/sync/push', 'POST', { tables })
}
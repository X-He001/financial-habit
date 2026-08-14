// =====================================================================
// 本地 → 云端 推送同步
// 本地 IndexedDB 为主，云端为备份/同步
// 用法：全量推送 pushSync()，遍历核心表逐条 POST/PUT 到后端
// =====================================================================
import { db } from '../db/database'
import { getSetting, setSetting } from '../db/crud'
import {
  setBaseUrl, getBaseUrl, checkHealth,
  fetchTransactions, saveTransaction, updateTransaction,
  fetchSavingsGoals, saveSavingsGoal, updateSavingsGoal,
  fetchDebts, saveDebt, updateDebt,
  fetchSchedules, saveSchedule, updateSchedule,
  fetchSettings, saveSetting, updateSetting,
} from './api'

export const SYNC_URL_KEY = 'syncServerUrl'
export const LAST_SYNC_AT_KEY = 'lastSyncAt'

// ---- 统计 ----

export interface TableStats {
  pushed: number  // 新增（POST）
  updated: number // 更新（PUT）
  skipped: number // 跳过（无 id 或云端一致）
  failed: number  // 请求失败
}

export interface SyncResult {
  ok: boolean
  byTable: Record<string, TableStats>
  total: number
  error?: string
}

// ---- 核心表配置 ----

type CoreTableName = 'transactions' | 'savingsGoals' | 'debts' | 'schedules' | 'settings'

interface TableConfig {
  name: CoreTableName
  /** 拉云端 id 列表 */
  fetchCloudIds: () => Promise<string[]>
  /** 保存：POST（id 不存在）或 PUT（id 已存在） */
  saveRow: (row: Record<string, unknown>, exists: boolean) => Promise<void>
}

function getTableConfigs(): TableConfig[] {
  return [
    {
      name: 'transactions',
      fetchCloudIds: async () => (await fetchTransactions()).map(t => t.id),
      saveRow: async (row, exists) => {
        if (exists) await updateTransaction(row.id as string, row as Parameters<typeof updateTransaction>[1])
        else await saveTransaction(row as Parameters<typeof saveTransaction>[0])
      },
    },
    {
      name: 'savingsGoals',
      fetchCloudIds: async () => (await fetchSavingsGoals()).map(g => g.id),
      saveRow: async (row, exists) => {
        if (exists) await updateSavingsGoal(row.id as string, row as Parameters<typeof updateSavingsGoal>[1])
        else await saveSavingsGoal(row as Parameters<typeof saveSavingsGoal>[0])
      },
    },
    {
      name: 'debts',
      fetchCloudIds: async () => (await fetchDebts()).map(d => d.id),
      saveRow: async (row, exists) => {
        if (exists) await updateDebt(row.id as string, row as Parameters<typeof updateDebt>[1])
        else await saveDebt(row as Parameters<typeof saveDebt>[0])
      },
    },
    {
      name: 'schedules',
      fetchCloudIds: async () => (await fetchSchedules()).map(s => s.id),
      saveRow: async (row, exists) => {
        if (exists) await updateSchedule(row.id as string, row as Parameters<typeof updateSchedule>[1])
        else await saveSchedule(row as Parameters<typeof saveSchedule>[0])
      },
    },
    {
      name: 'settings',
      fetchCloudIds: async () => (await fetchSettings()).map(s => s.id),
      saveRow: async (row, exists) => {
        const r = { id: row.id as string, value: String(row.value ?? '') }
        if (exists) await updateSetting(r.id, { value: r.value })
        else await saveSetting(r)
      },
    },
  ]
}

// ---- 地址管理 ----

export async function getSyncServerUrl(): Promise<string> {
  const raw = await getSetting(SYNC_URL_KEY)
  // 优先用已保存的地址；否则跟随 api.ts 的 baseUrl（生产构建默认同源）
  return typeof raw === 'string' && raw.trim() ? raw.trim() : getBaseUrl()
}

export async function setSyncServerUrl(url: string): Promise<void> {
  const normalized = url.trim().replace(/\/+$/, '')
  setBaseUrl(normalized)
  await setSetting(SYNC_URL_KEY, normalized)
}

/** 测试连通：调 /api/health */
export async function testServerConnection(url: string): Promise<{ ok: boolean; message: string }> {
  try {
    setBaseUrl(url)
    const data = await checkHealth()
    if (data.status === 'ok') {
      return { ok: true, message: '已连接' }
    }
    return { ok: false, message: `服务器返回异常：${JSON.stringify(data)}` }
  } catch (e) {
    return { ok: false, message: `连接失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

// ---- 同步推送 ----

/**
 * 全量推送：遍历本地核心表，逐条 POST/PUT 到云端
 * 返回每张表的 pushed / updated / skipped / failed 统计
 */
export async function pushSync(): Promise<SyncResult> {
  const result: SyncResult = { ok: false, byTable: {}, total: 0 }

  try {
    // 先确保连通
    await checkHealth()

    const configs = getTableConfigs()

    for (const cfg of configs) {
      const stats: TableStats = { pushed: 0, updated: 0, skipped: 0, failed: 0 }

      // 拉云端 id 集合
      let cloudIds: Set<string>
      try {
        const ids = await cfg.fetchCloudIds()
        cloudIds = new Set(ids)
      } catch {
        // 云端列表拉取失败（表可能为空或网络问题），当作空集合处理
        cloudIds = new Set()
      }

      // 读本地表
      const table = (db as unknown as Record<string, { toArray: () => Promise<Record<string, unknown>[]> }>)[cfg.name]
      const rows = await table.toArray()

      for (const row of rows) {
        const id = row.id as string | undefined
        if (!id) {
          stats.skipped++
          continue
        }
        const exists = cloudIds.has(id)
        try {
          await cfg.saveRow(row, exists)
          if (exists) stats.updated++
          else stats.pushed++
        } catch {
          stats.failed++
        }
      }

      result.byTable[cfg.name] = stats
    }

    result.total = Object.values(result.byTable).reduce(
      (s, t) => s + t.pushed + t.updated, 0,
    )
    result.ok = true
    await setSetting(LAST_SYNC_AT_KEY, Date.now())
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
  }

  return result
}
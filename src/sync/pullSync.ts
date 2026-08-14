// =====================================================================
// 云端 → 本地 拉取同步
// 把服务器 SQLite 的全部业务表数据下载到本地 IndexedDB，覆盖本地现有数据
// 用法：全量拉取 pullSync()，逐表 clear + bulkPut（云端为准）
// =====================================================================
import { db } from '../db/database'
import { setSetting } from '../db/crud'
import { checkHealth, fetchSyncPull, type PullData } from './api'
import { LAST_SYNC_AT_KEY, type TableStats } from './pushSync'

export interface PullResult {
  ok: boolean
  byTable: Record<string, TableStats>
  total: number
  error?: string
}

interface DexieTableLike {
  clear(): Promise<void>
  bulkPut(items: unknown[]): Promise<void>
}

/**
 * 全量拉取：从云端 GET /api/sync/pull 拿到全部业务表数据，
 * 逐表清空本地后写入（覆盖）。只处理云端返回的表，本地 accounts 等未同步表不受影响。
 * 返回每张表的条数统计。
 */
export async function pullSync(): Promise<PullResult> {
  const result: PullResult = { ok: false, byTable: {}, total: 0 }

  try {
    // 先确保连通，再拉全量数据
    await checkHealth()
    const resp = await fetchSyncPull()
    if (!resp?.success || !resp?.data) {
      throw new Error('服务器返回异常：' + JSON.stringify(resp ?? null))
    }

    const data = resp.data as PullData
    let total = 0

    for (const [key, rows] of Object.entries(data)) {
      const table = (db as unknown as Record<string, DexieTableLike | undefined>)[key]
      if (!table) continue
      const list = Array.isArray(rows) ? rows : []
      await table.clear()
      if (list.length > 0) await table.bulkPut(list)
      result.byTable[key] = { pushed: list.length, updated: 0, skipped: 0, failed: 0 }
      total += list.length
    }

    result.total = total
    result.ok = true
    // 记录最近同步时间（settings 已被云端覆盖，最后写回本地时间戳）
    await setSetting(LAST_SYNC_AT_KEY, Date.now())
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
  }

  return result
}

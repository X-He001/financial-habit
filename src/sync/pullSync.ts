// =====================================================================
// 云端 → 本地 拉取同步
// pullSync()：全量拉取（手动按钮，云端覆盖本地，需二次确认）
// mergePullSync()：合并拉取（自动同步用，逐行 LWW「最后写入优先」，本地优先）
//
// 合并规则（单用户，务实）：
//   - 同一 id 的记录，比较 updatedAt（ISO 时间戳），时间大者胜；
//   - 缺失 updatedAt 视为 0（旧数据兼容），永远输给有时间的版本；
//   - 两者时间相同或云端更旧 → 保留本地（本地优先，数据只在本机为准）；
//   - 远程写入期间用 begin/endRemoteWrite() 包裹，避免钩子把云端时间戳
//     覆盖成"现在"导致 LWW 失效、也避免推送回环。
// =====================================================================
import { db } from '../db/database'
import { setSetting } from '../db/crud'
import { checkHealth, fetchSyncPull, type PullData } from './api'
import type { TableStats } from './pushSync'
import { LAST_SYNC_AT_KEY } from './keys'
import { beginRemoteWrite, endRemoteWrite } from '../db/syncHooks'

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

interface MergeTableLike {
  get(id: unknown): Promise<unknown | undefined>
  put(row: unknown): Promise<unknown>
}

/** 解析时间戳：ISO 字符串 → 毫秒；缺失/非法 → 0（旧数据视为最旧，输给有时间的） */
function tsValue(v: unknown): number {
  if (typeof v !== 'string' || !v) return 0
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : 0
}

/**
 * 全量拉取：从云端 GET /api/sync/pull 拿到全部业务表数据，
 * 逐表清空本地后写入（覆盖，云端为准）。只处理云端返回的表，本地 accounts 等未同步表不受影响。
 * 返回每张表的条数统计。远程写入期间跳过钩子打点/推送。
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

    beginRemoteWrite()
    try {
      for (const [key, rows] of Object.entries(data)) {
        const table = (db as unknown as Record<string, DexieTableLike | undefined>)[key]
        if (!table) continue
        const list = Array.isArray(rows) ? rows : []
        await table.clear()
        if (list.length > 0) await table.bulkPut(list)
        result.byTable[key] = { pushed: list.length, updated: 0, skipped: 0, failed: 0 }
        total += list.length
      }
    } finally {
      endRemoteWrite()
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

/**
 * 合并拉取（自动同步用）：逐表逐行 LWW 合并，本地优先。
 * 只覆盖「云端 updatedAt > 本地 updatedAt」的行，本地更新的行保留不动。
 * 不做 clear，确保断网期间的本地记录不被云端覆盖丢弃。
 */
export async function mergePullSync(): Promise<PullResult> {
  const result: PullResult = { ok: false, byTable: {}, total: 0 }

  try {
    await checkHealth()
    const resp = await fetchSyncPull()
    if (!resp?.success || !resp?.data) {
      throw new Error('服务器返回异常：' + JSON.stringify(resp ?? null))
    }

    const data = resp.data as PullData
    let total = 0

    beginRemoteWrite()
    try {
      for (const [key, rows] of Object.entries(data)) {
        const table = (db as unknown as Record<string, MergeTableLike | undefined>)[key]
        if (!table) continue
        const list = Array.isArray(rows) ? rows : []
        let updated = 0
        for (const row of list as Record<string, unknown>[]) {
          const id = row.id
          if (id === undefined || id === null || id === '') continue
          const cloudTs = tsValue(row.updatedAt)
          // 读本地：无该 id 记录 → 直接采用云端（本地不存在冲突）
          const local = await table.get(id)
          const localTs = tsValue(local ? (local as Record<string, unknown>).updatedAt : undefined)
          if (cloudTs > localTs) {
            await table.put(row)
            updated++
          }
          // 否则保留本地（本地优先：云端时间更旧或相同 → 本地为准）
        }
        result.byTable[key] = { pushed: updated, updated: 0, skipped: 0, failed: 0 }
        total += updated
      }
    } finally {
      endRemoteWrite()
    }

    result.total = total
    result.ok = true
    // 记录最近同步时间（settings 写入不触发推送，避免自循环）
    await setSetting(LAST_SYNC_AT_KEY, Date.now())
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
  }

  return result
}

// =====================================================================
// 本地 → 云端 推送同步
// 本地 IndexedDB 为主，云端为仓库/备份。
// 用法：pushSync() —— 全部同步表逐表 toArray() 取本地快照，
// 一次性 POST /api/sync/push 批量写入；服务器按行 INSERT OR REPLACE
// （同 id 视为更新，行级「最后写入优先」）。
// 自动同步时由 realtimeSync 的 requestPushToCloud() 防抖触发（2.5s 合并）；
// 设置页保留「推送本地数据到云端」手动按钮作兜底。
// =====================================================================
import { db } from '../db/database'
import { getSetting, setSetting } from '../db/crud'
import { setBaseUrl, getBaseUrl, checkHealth, fetchSyncPush } from './api'
import { SYNC_TABLE_NAMES } from '../db/syncHooks'
import { SYNC_URL_KEY, LAST_SYNC_AT_KEY } from './keys'

// 兼容旧导入路径（crud/pullSync 已改为从 keys 导入，这里保留再导出）
export { SYNC_URL_KEY, LAST_SYNC_AT_KEY } from './keys'

// ---- 统计 ----

export interface TableStats {
  pushed: number  // 新增（云端原本没有该 id）
  updated: number // 更新（云端已存在该 id）
  skipped: number // 跳过（无有效 id）
  failed: number  // 服务器写入失败
}

export interface SyncResult {
  ok: boolean
  byTable: Record<string, TableStats>
  total: number
  error?: string
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
 * 全量推送：把全部同步表（21 张）当前数据整表快照批量 POST 到云端。
 * 服务器对每条记录 INSERT OR REPLACE（相同 id 视为更新），行级 LWW。
 * 返回每张表的 pushed / updated / skipped / failed 统计。
 */
export async function pushSync(): Promise<SyncResult> {
  const result: SyncResult = { ok: false, byTable: {}, total: 0 }

  try {
    // 先确保连通
    await checkHealth()

    // 逐表取本地快照（表缺失时跳过，避免旧版库结构差异导致失败）
    const tables: Record<string, unknown[]> = {}
    for (const name of SYNC_TABLE_NAMES) {
      const table = (db as unknown as Record<string, { toArray: () => Promise<unknown[]> } | undefined>)[name]
      if (!table) continue
      tables[name] = await table.toArray()
    }

    const resp = await fetchSyncPush(tables)
    if (!resp?.success) {
      throw new Error('服务器返回异常：' + JSON.stringify(resp ?? null))
    }

    result.byTable = resp.byTable
    result.total = resp.total
    result.ok = true
    // 记录最近同步时间（settings 表写入不触发推送，避免自循环）
    await setSetting(LAST_SYNC_AT_KEY, Date.now())
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
  }

  return result
}

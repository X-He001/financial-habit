// =====================================================================
// 本地写入自动打点 + 自动推送触发（src/db/syncHooks.ts）
// 通过 Dexie 钩子统一处理同步表的本地写入：
//   1. creating/updating：补 updatedAt（ISO 时间戳），供「最后写入优先（LWW）」冲突合并
//   2. creating/updating/deleting：触发 requestPushToCloud()（2.5s 防抖），
//      让「交易/负债/欲望清单/设置等」一切本地增删改自动推送云端，无需手动点推送
// 旧数据无 updatedAt 字段时按 0 处理（mergePullSync 里比较），兼容存量。
//
// 远程合并/拉取写入本地时用 beginRemoteWrite()/endRemoteWrite() 包裹，
// 让钩子跳过打点与推送，避免把云端时间戳覆盖成"现在"导致 LWW 失效、避免推送回环。
// =====================================================================
import type Dexie from 'dexie'
import { requestPushToCloud } from '../sync/realtimeSync'
import { LAST_SYNC_AT_KEY } from '../sync/keys'

/** 是否正在应用远程数据（拉取/合并写入本地）：true 时钩子不覆写 updatedAt、不触发推送 */
let applyingRemote = false

export function beginRemoteWrite(): void {
  applyingRemote = true
}

export function endRemoteWrite(): void {
  applyingRemote = false
}

/** 参与同步的表名（与 server/routes/sync.js 的 TABLES 保持一致） */
export const SYNC_TABLE_NAMES = [
  'transactions', 'savingsGoals', 'sinkingFunds', 'wishlist', 'wishlistChats',
  'debts', 'savingsRules', 'notificationLogs', 'categories', 'schedules',
  'settings', 'balanceSnapshots', 'commitments', 'moods', 'consumerEvents',
  'decisionRecords', 'behaviorProfiles', 'insights',
  'creditAccounts', 'creditStatements', 'installments',
  'knowledgeRefs', 'feedbackLogs', 'agentInbox',
] as const

/**
 * 注册同步钩子（应用启动时调用一次；须在 db 实例初始化完成后、首次写库前调用）。
 * 覆盖 add / put / update / delete / bulkPut / bulkAdd 等一切写入路径。
 */
export function installUpdatedAtHooks(db: Dexie): void {
  const stamp = (): string => new Date().toISOString()
  for (const name of SYNC_TABLE_NAMES) {
    const table = db.table(name)
    table.hook('creating', (primKey, obj) => {
      if (applyingRemote) return
      const o = obj as Record<string, unknown>
      o.updatedAt = stamp()
      requestPushForSettings(name, primKey)
    })
    table.hook('updating', (mods, primKey) => {
      if (applyingRemote) return
      const m = mods as Record<string, unknown>
      m.updatedAt = stamp()
      requestPushForSettings(name, primKey)
    })
    table.hook('deleting', (primKey) => {
      if (applyingRemote) return
      requestPushForSettings(name, primKey)
    })
  }
}

/**
 * 触发推送。settings 表的 lastSyncAt 是同步流程自身的记账字段，
 * 排除在外避免「推送 → 写 lastSyncAt → 触发推送」的多端互推死循环。
 */
function requestPushForSettings(tableName: string, primKey: unknown): void {
  if (tableName === 'settings' && String(primKey) === LAST_SYNC_AT_KEY) return
  requestPushToCloud()
}

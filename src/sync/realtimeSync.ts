// =====================================================================
// 实时同步编排（src/sync/realtimeSync.ts）
// 防回环规则：
//   用户写操作成功 → requestPushToCloud()（只推，绝不拉；由 syncHooks 钩子统一触发）
//   收到 data-changed 广播 → syncFromCloud()（只拉，绝不推）
//   广播 by === 本端 clientId → 忽略（自己引起的变更，本地已最新）
// 全局锁 syncing 防止并发重入；推送 2.5s 防抖合并连续写。
// 自动拉取时机：WS 连接成功、收到 data-changed、页面回到前台、每 30s 轮询兜底。
// 「自动同步」开关（设置页可关，默认开）：
//   关闭后自动推送与自动拉取全部停止，仅保留手动「推送/拉取」按钮兜底。
// =====================================================================
import { mergePullSync } from './pullSync'
import { pushSync } from './pushSync'
import { getClientId } from './clientId'
import { connectRealtime, ensureWsConnected } from './ws'
import { getSetting } from '../db/crud'

/** 自动同步开关的 settings key（设置页复用同一 key） */
export const AUTO_SYNC_KEY = 'autoSync'

/** 同步锁：同一时刻只允许一个拉取/推送在执行（防并发重入、防重复拉取） */
let syncing = false
/** 推送防抖定时器：2.5s 内多次写合并为一次推送 */
let pushTimer: number | null = null
/** 轮询兜底定时器：自动同步开启时每 30s 拉取合并一次（ws 断开时的兜底，ws 正常时也兜底） */
let pollTimer: number | null = null
let initialized = false

/** 内存中的自动同步开关（默认开；initRealtime 启动时从设置读取） */
let autoSync = true

const PUSH_DEBOUNCE_MS = 2500
const POLL_INTERVAL_MS = 30000

/** 读取自动同步开关（设置缺失时默认开） */
export async function getAutoSyncEnabled(): Promise<boolean> {
  const v = await getSetting(AUTO_SYNC_KEY)
  return v === undefined ? true : v !== 'false'
}

/** 设置自动同步开关（内存即时生效；设置页开关时调用） */
export function setAutoSyncEnabled(on: boolean): void {
  autoSync = on
  if (on) startPolling()
  else stopPolling()
}

/** 从云端拉取合并：逐行 LWW 合并（只拉，绝不推） */
async function syncFromCloud(): Promise<void> {
  if (!autoSync || syncing) return // 关闭或已有同步在执行，忽略本次
  syncing = true
  try {
    const r = await mergePullSync()
    if (!r.ok) {
      console.warn('⚠️ 自动拉取失败：', r.error)
      return
    }
    // 云端可能同步了本端的自动同步开关，拉取后同步内存状态
    const on = await getAutoSyncEnabled()
    if (on !== autoSync) setAutoSyncEnabled(on)
    // 通知各页面重新读取本地数据（Home/Debt/Wishlist 已监听该事件）
    window.dispatchEvent(new CustomEvent('dashboard-refresh'))
  } catch (e) {
    console.warn('⚠️ 自动拉取异常：', e)
  } finally {
    syncing = false
  }
}

/** 推送到云端：全表批量推送（只推，绝不拉；成功后服务端广播，本端会忽略自身消息） */
async function pushToCloud(): Promise<void> {
  if (!autoSync || syncing) return
  syncing = true
  try {
    const r = await pushSync()
    if (!r.ok) console.warn('⚠️ 自动推送失败：', r.error)
  } catch (e) {
    console.warn('⚠️ 自动推送异常：', e)
  } finally {
    syncing = false
  }
}

/** 业务写操作成功后调用（syncHooks 钩子统一触发）；2.5s 防抖合并连续写 */
export function requestPushToCloud(): void {
  if (!autoSync) return // 自动同步关闭：只保留手动推送按钮
  if (pushTimer !== null) return // 已有一次待推送，合并
  pushTimer = window.setTimeout(() => {
    pushTimer = null
    void pushToCloud()
  }, PUSH_DEBOUNCE_MS)
}

/** 轮询兜底：自动同步开启时每 30s 拉取合并一次 */
function startPolling(): void {
  if (pollTimer !== null) return
  pollTimer = window.setInterval(() => { void syncFromCloud() }, POLL_INTERVAL_MS)
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/** 初始化实时同步（幂等，App 入口调用一次即可） */
export function initRealtime(): void {
  if (initialized) return
  initialized = true

  // 启动时读取自动同步开关；开启则开始 30s 轮询兜底
  void getAutoSyncEnabled().then(on => { autoSync = on; if (on) startPolling() })

  connectRealtime((msg) => {
    if (msg.reason === 'connected') {
      void syncFromCloud() // 连接成功（含重连）先合并一次
    } else if (msg.reason === 'data-changed') {
      if (msg.by && msg.by === getClientId()) return // 自己引起的变更，本地已最新
      void syncFromCloud()
    } else if (msg.reason === 'disconnected') {
      // ws 不可用：30s 轮询兜底（自动同步开启时 startPolling 已启动，无需额外动作）
    }
  })

  // 页面恢复可见：确保连接并合并一次
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      ensureWsConnected()
      void syncFromCloud()
    }
  })
}

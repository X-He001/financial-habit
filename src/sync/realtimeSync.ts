// =====================================================================
// 实时同步编排（src/sync/realtimeSync.ts）
// 防回环规则：
//   用户写操作成功 → requestPushToCloud()（只推，绝不拉）
//   收到 data-changed 广播 → syncFromCloud()（只拉，绝不推）
//   广播 by === 本端 clientId → 忽略（自己引起的变更，本地已最新）
// 全局锁 syncing 防止并发重入；推送 2s 节流合并连续写。
// ws 断开时启动轮询降级（HTTP 环境 WebSocket 不稳定的兜底方案）。
// =====================================================================
import { pullSync } from './pullSync'
import { pushSync } from './pushSync'
import { getClientId } from './clientId'
import { connectRealtime, ensureWsConnected } from './ws'

/** 同步锁：同一时刻只允许一个拉取/推送在执行（防并发重入、防重复拉取） */
let syncing = false
/** 推送节流定时器：2s 内多次写合并为一次推送 */
let pushTimer: number | null = null
/** 轮询降级定时器：ws 断开时的兜底 */
let pollTimer: number | null = null
let initialized = false

/** 从云端拉取：全量覆盖本地（只拉，绝不推） */
export async function syncFromCloud(): Promise<void> {
  if (syncing) return // 已有同步在执行，忽略本次
  syncing = true
  try {
    const r = await pullSync()
    if (!r.ok) {
      console.warn('⚠️ 实时拉取失败：', r.error)
      return
    }
    // 通知各页面重新读取本地数据（Home/Debt/Wishlist 已监听该事件）
    window.dispatchEvent(new CustomEvent('dashboard-refresh'))
  } catch (e) {
    console.warn('⚠️ 实时拉取异常：', e)
  } finally {
    syncing = false
  }
}

/** 推送到云端：全量推送（只推，绝不拉；成功后服务端广播，本端会忽略自身消息） */
export async function pushToCloud(): Promise<void> {
  if (syncing) return
  syncing = true
  try {
    const r = await pushSync()
    if (!r.ok) console.warn('⚠️ 实时推送失败：', r.error)
  } catch (e) {
    console.warn('⚠️ 实时推送异常：', e)
  } finally {
    syncing = false
  }
}

/** 业务写操作成功后调用；2s 节流合并连续写 */
export function requestPushToCloud(): void {
  if (pushTimer !== null) return // 已有一次待推送，合并
  pushTimer = window.setTimeout(() => {
    pushTimer = null
    void pushToCloud()
  }, 2000)
}

/** ws 断开时启动轮询兜底（15s 一次全量拉取），连接恢复后停止 */
function startPolling(): void {
  if (pollTimer !== null) return
  pollTimer = window.setInterval(() => { void syncFromCloud() }, 15000)
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

  connectRealtime((msg) => {
    if (msg.reason === 'connected') {
      stopPolling()
      void syncFromCloud() // 连接成功（含重连）先同步一次
    } else if (msg.reason === 'data-changed') {
      if (msg.by && msg.by === getClientId()) return // 自己引起的变更，本地已最新
      void syncFromCloud()
    } else if (msg.reason === 'disconnected') {
      startPolling() // ws 不可用 → 轮询降级
    }
  })

  // 页面恢复可见：确保连接并同步一次
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      ensureWsConnected()
      void syncFromCloud()
    }
  })
}

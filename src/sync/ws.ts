// =====================================================================
// WebSocket 实时同步客户端（src/sync/ws.ts）
// - 基于 getBaseUrl() 推导 ws 地址（同源部署或显式后端地址）
// - 断线自动重连：指数退避 1s,2s,4s,8s... 封顶 30s
// - 连接成功（含重连）与收到 data-changed 消息时回调上层
// - ensureWsConnected()：页面恢复可见时若未连接则立即重连
// =====================================================================
import { getBaseUrl } from './api'
import { getClientId } from './clientId'

/** 上层同步编排收到的消息类型 */
export type RealtimeMessage =
  | { reason: 'connected' }            // 连接成功（首次建立或重连成功）
  | { reason: 'data-changed'; by?: string } // 服务端广播的数据变更通知
  | { reason: 'disconnected' }         // 连接断开（上层可启动轮询降级）

/** 推导 WebSocket 地址 */
export function getWsUrl(): string {
  const base = getBaseUrl()
  if (base) {
    // 显式配置了后端地址（http(s)://host）→ 替换为 ws(s)://host/ws
    return `${base.replace(/^http/, 'ws')}/ws`
  }
  // 同源部署：直接用当前 host
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

let ws: WebSocket | null = null
let handlerFn: ((msg: RealtimeMessage) => void) | null = null
let retryDelay = 1000
let retryTimer: number | null = null
let stopped = false

function clearRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

function scheduleReconnect(): void {
  if (stopped) return
  clearRetry()
  retryTimer = window.setTimeout(() => {
    retryTimer = null
    connectNow()
  }, retryDelay)
  retryDelay = Math.min(retryDelay * 2, 30000) // 1s→30s 封顶
}

function connectNow(): void {
  if (stopped) return
  // 已有活跃/正在建立的连接则不重复建
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  try {
    ws = new WebSocket(`${getWsUrl()}?clientId=${encodeURIComponent(getClientId())}`)
  } catch {
    scheduleReconnect()
    return
  }
  ws.onopen = () => {
    retryDelay = 1000 // 连接成功，重置退避
    handlerFn?.({ reason: 'connected' })
  }
  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(String(ev.data)) as { type?: string; by?: string }
      if (data && data.type === 'data-changed') {
        handlerFn?.({ reason: 'data-changed', by: data.by })
      }
    } catch { /* 忽略无法解析的消息 */ }
  }
  ws.onclose = () => {
    ws = null
    if (stopped) return
    handlerFn?.({ reason: 'disconnected' })
    scheduleReconnect()
  }
  ws.onerror = () => {
    ws?.close() // 触发 onclose 统一走重连
  }
}

/**
 * 建立 WebSocket 连接并监听（重复调用安全，复用同一连接）。
 * @param handler 连接成功 / 收到 data-changed / 断开 时回调
 */
export function connectRealtime(handler: (msg: RealtimeMessage) => void): void {
  handlerFn = handler
  stopped = false
  connectNow()
}

/** 页面恢复可见时调用：若未连接则立即重连（不等退避计时器） */
export function ensureWsConnected(): void {
  if (stopped) return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  retryDelay = 1000
  clearRetry()
  connectNow()
}

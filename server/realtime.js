// =====================================================================
// WebSocket 实时同步（server/realtime.js）
// 维护在线连接集合，向所有在线客户端广播「数据变更」通知。
// 只做通知中转，不承载数据：前端收到通知后自行全量拉取 /api/sync/pull。
// =====================================================================
import { WebSocketServer, WebSocket } from 'ws'

/** 在线连接集合：Set<{ ws, clientId }> */
const clients = new Set()

/**
 * 在 HTTP server 上挂载 WebSocket 服务（路径 /ws）。
 * 前端连接时通过 query 参数携带 clientId（如 ws://host/ws?clientId=xxx）。
 */
export function initRealtime(server) {
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws, req) => {
    // 从 query 参数读取客户端标识
    const url = new URL(req.url, 'http://localhost')
    const clientId = url.searchParams.get('clientId') ?? 'unknown'
    const conn = { ws, clientId }
    clients.add(conn)

    ws.on('close', () => clients.delete(conn))
    ws.on('error', () => clients.delete(conn))
  })
}

/**
 * 向所有在线客户端广播一条 JSON 消息。
 * 例：broadcast({ type: 'data-changed', by: 'server', at: Date.now() })
 */
export function broadcast(payload) {
  const data = JSON.stringify(payload)
  for (const conn of clients) {
    if (conn.ws.readyState === WebSocket.OPEN) {
      try {
        conn.ws.send(data)
      } catch {
        // 单连接发送失败不影响其他客户端
      }
    }
  }
}

// =====================================================================
// 客户端 ID（src/sync/clientId.ts）
// 每个浏览器一个持久 UUID，用途：
//   - WebSocket 连接标识（连接 URL 的 query 参数，服务端广播 by 字段）
//   - HTTP 请求头 x-client-id（服务端透传到广播，本端据此忽略自身变更）
//
// 多窗口联调测试：同一浏览器两个普通窗口共享 localStorage，clientId 相同，
// 后者会忽略前者的广播导致看不到实时刷新。可在 URL 加 ?fhClientId=xxx 覆盖，
// 例如开第二个窗口访问 http://localhost:3001/?fhClientId=client-B。
// =====================================================================
const CLIENT_ID_KEY = 'fh-client-id'

/** 生成 UUID v4（非安全上下文 HTTP 下 crypto.randomUUID 不可用，提供兜底） */
function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // 手动生成 UUID v4：xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  const chars = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
  return chars.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** 读取或生成本端持久 clientId（支持 ?fhClientId=xxx 覆盖，便于多窗口联调） */
export function getClientId(): string {
  const override = new URLSearchParams(window.location.search).get('fhClientId')
  if (override && override.trim()) return override.trim()
  let id = localStorage.getItem(CLIENT_ID_KEY)
  if (!id) {
    id = generateId()
    localStorage.setItem(CLIENT_ID_KEY, id)
  }
  return id
}

// =====================================================================
// Financial Habit 后端入口（SQLite 版）
// 启动：npm run server（监听 3001 端口）
//
// 环境变量：
//   PORT            端口（默认 3001）
//   DATA_DIR        SQLite 文件路径（默认 server/data.sqlite）
//   FRONTEND_DIST   前端构建产物目录；若存在则同时托管前端（生产模式前后端一体）
//
// 生产模式：npm run build 生成 dist/ 后，npm run server 会同时服务网站和 API，
// 服务器上只需跑一个进程。
// =====================================================================
import express from 'express'
import cors from 'cors'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { initSchema } from './db.js'
import { apiRouter } from './routes/index.js'
import { initRealtime } from './realtime.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT ?? 3001)
const FRONTEND_DIST = process.env.FRONTEND_DIST
  ? path.resolve(process.env.FRONTEND_DIST)
  : path.resolve(__dirname, '../dist')

const app = express()
app.use(cors())
app.use(express.json())

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' })
})

// 业务路由
app.use('/api', apiRouter)

// ---- 生产模式：托管前端构建产物（dist/）----
// 若 dist 存在则静态服务 + SPA 回退（所有非 /api 请求返回 index.html）
const distExists = existsSync(FRONTEND_DIST)
if (distExists) {
  app.use(express.static(FRONTEND_DIST))
  // SPA 回退：非 /api 的 GET 请求都返回 index.html（Express 5 兼容写法）
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next()
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'))
  })
  console.log(`🌐 托管前端产物：${FRONTEND_DIST}`)
}

// 404（仅 API 未匹配时）
app.use((req, res) => {
  res.status(404).json({ error: 'not found', path: req.path })
})

// 统一错误处理
app.use((err, req, res, _next) => {
  console.error('❌', err?.message ?? err)
  res.status(500).json({ error: String(err?.message ?? err) })
})

// 启动
initSchema()
const server = http.createServer(app)
// WebSocket 实时同步（/ws 路径，与 HTTP 共用同一端口 3001）
initRealtime(server)
server.listen(PORT, () => {
  console.log(`🚀 Financial Habit 已启动：http://localhost:${PORT}`)
  console.log(`   健康检查：http://localhost:${PORT}/api/health`)
  console.log(`   实时同步：ws://localhost:${PORT}/ws`)
  if (distExists) {
    console.log(`   网站：http://localhost:${PORT}/ （前后端一体，单进程）`)
  } else {
    console.log(`   （未检测到 dist/，仅提供 API。生产部署请先 npm run build）`)
  }
})
// =====================================================================
// 通用 CRUD 路由工厂（SQLite 版）
// =====================================================================
import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { db } from '../db.js'
import { broadcast } from '../realtime.js'

function reverseMap(fieldMap) {
  const rev = {}
  for (const [k, v] of Object.entries(fieldMap)) rev[v] = k
  return rev
}

/** 写操作成功后广播变更通知（by 透传请求头 x-client-id，前端可据此忽略自身变更） */
function broadcastDataChanged(req) {
  broadcast({ type: 'data-changed', by: req.header('x-client-id') ?? 'server', at: Date.now() })
}

/**
 * @param {object} cfg
 * @param {string} cfg.table         数据库表名
 * @param {object} cfg.fields        camelCase → snake_case 字段映射
 * @param {string} [cfg.idCol]       主键列名（默认 'id'；settings 表为 'key'）
 * @param {object} [cfg.filters]     GET 列表支持的查询参数 { from: col, to: col, category: col, txType: col }
 * @param {string} [cfg.orderBy]    列表默认排序，如 'time DESC'
 */
export function createCrudRouter(cfg) {
  const router = Router()
  const { table, fields, orderBy = null, idCol = 'id' } = cfg
  const rev = reverseMap(fields)

  const toJson = (row) => {
    const out = {}
    if (row[idCol] !== undefined) out.id = row[idCol]
    for (const [col, val] of Object.entries(row)) {
      const api = rev[col]
      if (api && api !== idCol) out[api] = val
    }
    return out
  }

  const pickKnown = (body) => {
    const clean = {}
    for (const [api, col] of Object.entries(fields)) {
      if (body[api] !== undefined) clean[col] = body[api]
    }
    return clean
  }

  // better-sqlite3 不能绑定 boolean，统一转 0/1
  const sanitize = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)

  // GET /：列表
  router.get('/', (req, res, next) => {
    try {
      const wheres = []
      const params = []
      for (const f of Object.keys(cfg.filters ?? {})) {
        const col = cfg.filters[f]
        if (!col || req.query[f] === undefined) continue
        params.push(req.query[f])
        if (f === 'from') {
          wheres.push(`${col} >= ?`)
        } else if (f === 'to') {
          wheres.push(`${col} <= ?`)
        } else {
          wheres.push(`${col} = ?`)
        }
      }
      const sql = `SELECT * FROM ${table}` +
        (wheres.length ? ' WHERE ' + wheres.join(' AND ') : '') +
        (orderBy ? ` ORDER BY ${orderBy}` : '')
      const rows = db.prepare(sql).all(...params)
      res.json(rows.map(toJson))
    } catch (e) { next(e) }
  })

  // POST /：插入
  router.post('/', (req, res, next) => {
    try {
      const body = req.body ?? {}
      const clean = pickKnown(body)
      const id = body.id !== undefined && String(body.id).length > 0 ? String(body.id) : randomUUID()
      const cols = [idCol, ...Object.keys(clean)]
      const vals = [id, ...Object.values(clean)].map(sanitize)
      const placeholders = cols.map(() => '?').join(', ')
      const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`
      db.prepare(sql).run(...vals)
      const row = db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ?`).get(id)
      broadcastDataChanged(req)
      res.status(201).json(toJson(row))
    } catch (e) { next(e) }
  })

  // PUT /:id：更新
  router.put('/:id', (req, res, next) => {
    try {
      const clean = pickKnown(req.body ?? {})
      const keys = Object.keys(clean)
      if (keys.length === 0) {
        const row = db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ?`).get(req.params.id)
        if (!row) return res.status(404).json({ error: 'not found' })
        return res.json(toJson(row))
      }
      const sets = keys.map(k => `${k} = ?`)
      const sql = `UPDATE ${table} SET ${sets.join(', ')} WHERE ${idCol} = ?`
      db.prepare(sql).run(...keys.map(k => sanitize(clean[k])), req.params.id)
      const row = db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ?`).get(req.params.id)
      if (!row) return res.status(404).json({ error: 'not found' })
      broadcastDataChanged(req)
      res.json(toJson(row))
    } catch (e) { next(e) }
  })

  // DELETE /:id
  router.delete('/:id', (req, res, next) => {
    try {
      const info = db.prepare(`DELETE FROM ${table} WHERE ${idCol} = ?`).run(req.params.id)
      if (info.changes === 0) return res.status(404).json({ error: 'not found' })
      broadcastDataChanged(req)
      res.json({ ok: true })
    } catch (e) { next(e) }
  })

  return router
}
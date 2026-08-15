// =====================================================================
// AI 代理路由（server/routes/ai.js）
// 用途：智能记账「批量导入」的后端代理 + 统一对话接口。
// 前端把文件解析出的原始文本（Excel/PDF/OCR）POST 到这里，
// 服务端读取 settings 表里的模型配置（modelConfig，兼容旧版 deepseekApiKey）
// 调对应厂商的 OpenAI 兼容 /chat/completions 接口，避免在前端暴露 Key。
//
// 约定：
//   POST /api/ai/extract  { text, source } → { items: [...] }
//   POST /api/ai/chat     { messages }     → { content }
//   409 MISSING_KEY/MISSING_CONFIG  服务器 settings 表里没有模型配置（前端可降级为直连调用）
//   401 INVALID_KEY  Key 无效
//   402 BALANCE      余额不足
//   502 AI_*         AI 服务错误（网络/上游 4xx/5xx/空响应/解析失败）
// =====================================================================
import { Router } from 'express'
import { db } from '../db.js'

const TIMEOUT_MS = 60_000
const MAX_TEXT_LEN = 20_000 // 超出截断，避免超长输入浪费 token

/**
 * 读取服务器 settings 表里的模型配置。
 * 优先 modelConfig（JSON：{ provider, modelName, apiUrl, apiKey }），
 * 兼容旧版 deepseekApiKey（自动映射为 DeepSeek 配置）。
 * 无配置返回 null。
 */
function readModelConfig() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'modelConfig'`).get()
  if (row?.value) {
    try {
      const cfg = JSON.parse(row.value)
      if (
        cfg &&
        String(cfg.apiUrl || '').trim() &&
        String(cfg.modelName || '').trim() &&
        String(cfg.apiKey || '').trim()
      ) {
        return {
          provider: String(cfg.provider || 'custom'),
          modelName: String(cfg.modelName).trim(),
          apiUrl: String(cfg.apiUrl).trim().replace(/\/+$/, ''),
          apiKey: String(cfg.apiKey).trim(),
        }
      }
    } catch {
      // 配置数据损坏则忽略，走旧版兼容
    }
  }
  const old = db.prepare(`SELECT value FROM settings WHERE key = 'deepseekApiKey'`).get()
  if (old?.value && String(old.value).trim()) {
    return {
      provider: 'deepseek',
      modelName: 'deepseek-v4-flash',
      apiUrl: 'https://api.deepseek.com',
      apiKey: String(old.value).trim(),
    }
  }
  return null
}

const SYSTEM_PROMPT = `你是一个记账助手。用户会给你一份账单的原始文本（可能来自 Excel 表格、PDF 账单或 OCR 截图识别），里面可能包含一条或多条交易记录。请把所有交易记录逐条提取出来，不能合并也不能遗漏。
只输出一个严格 JSON 对象：{"items": [ {记录}, {记录}, ... ]}，不要输出任何其他文字。

每条记录的格式：
{"amount": 金额（元，数字）, "txType": "expense" 支出 或 "income" 收入（无法判断时默认 "expense"）, "category": "餐饮|购物|日用百货|娱乐|交通|虚拟消费|其他", "merchant": "商家名称或交易对方（未知填 未知商家）", "time": "交易日期（YYYY-MM-DD，无法确定日期用今天）", "paymentMethod": "微信|支付宝|银行卡|现金|花呗|信用支付|先用后付|分期", "note": "备注或空字符串"}

要求：
1. 逐条提取，不能合并或遗漏。原始数据里明确有 5 笔交易就输出 5 条，有 20 笔就输出 20 条。
2. 金额只提取实际交易金额，统一为正数（若原表用负号或「支出」列表示支出，转换为正数）。
3. 跳过退款、手续费说明、合计/汇总行、以及无关说明文字，它们不算交易记录。
4. 时间优先用原始数据里的日期；没有日期时用今天。
5. 日期格式必须是 YYYY-MM-DD。`

export const aiRouter = Router()

/** 递归把（可能嵌套的）数组拍平为纯对象列表 */
function flattenList(v) {
  if (!Array.isArray(v)) return []
  const out = []
  for (const item of v) {
    if (Array.isArray(item)) out.push(...flattenList(item))
    else if (item && typeof item === 'object') out.push(item)
  }
  return out
}

/**
 * 从模型返回内容里提取 JSON 对象数组（兼容多余文字/代码块/包装对象/嵌套数组/数字键对象/单条对象）：
 *  1) 顶层数组              [ {...}, {...} ]
 *  2) 包装对象              {"items": [...], "total": 2} / {"transactions": [...]}
 *  3) 数字键对象            {"0": {...}, "1": {...}}
 *  4) 嵌套数组（按页返回）   [[ {...} ], [ {...} ]]
 *  5) 单条记录对象          {"amount": 88.5, ...}
 */
function extractJsonArray(content) {
  const cleaned = content.replace(/```json/gi, '').replace(/```/g, '').trim()

  // 1) 数组（含被 {"items": [...]} 等包装的数组）：扫描最外层 []，取「展开后条目最多」的候选（并列取靠后者）
  const arrCandidates = []
  const arrStack = []
  let inStr = false
  let quote = ''
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) inStr = false
      continue
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue }
    if (ch === '[') arrStack.push(i)
    else if (ch === ']' && arrStack.length > 0) {
      const start = arrStack.pop()
      if (arrStack.length === 0) {
        try {
          const parsed = JSON.parse(cleaned.slice(start, i + 1))
          if (Array.isArray(parsed)) arrCandidates.push({ start, list: flattenList(parsed) })
        } catch { /* 忽略解析失败的候选 */ }
      }
    }
  }
  if (arrCandidates.length > 0) {
    let best = null
    for (const c of arrCandidates) {
      if (!best || c.list.length > best.list.length || (c.list.length === best.list.length && c.start > best.start)) best = c
    }
    if (best && best.list.length > 0) return best.list
  }

  // 2) 对象：包装对象 / 数字键对象 / 单条记录
  const objStack = []
  inStr = false
  quote = ''
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) inStr = false
      continue
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue }
    if (ch === '{') objStack.push(i)
    else if (ch === '}' && objStack.length > 0) {
      const start = objStack.pop()
      if (objStack.length === 0) {
        try {
          const parsed = JSON.parse(cleaned.slice(start, i + 1))
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            // 2a) 包装对象：取第一个数组值
            for (const v of Object.values(parsed)) {
              if (Array.isArray(v)) return flattenList(v)
            }
            // 2b) 数字键对象：按 key 数值顺序取值
            const keys = Object.keys(parsed)
            if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
              return keys
                .sort((a, b) => Number(a) - Number(b))
                .map(k => parsed[k])
                .filter(v => v && typeof v === 'object' && !Array.isArray(v))
            }
            // 2c) 单条记录对象
            return [parsed]
          }
        } catch { /* 忽略解析失败的候选 */ }
      }
    }
  }
  return null
}

/** POST /api/ai/extract：把原始账单文本结构化提取为记账条目数组 */
aiRouter.post('/extract', async (req, res) => {
  try {
    // 1. 模型配置：只从服务器 settings 表读取，前端拿不到 Key
    const cfg = readModelConfig()
    if (!cfg) {
      return res.status(409).json({ error: 'MISSING_KEY' })
    }

    // 2. 入参
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
    if (!text) return res.status(400).json({ error: 'EMPTY_TEXT' })
    const source = typeof req.body?.source === 'string' && req.body.source ? req.body.source : '账单'
    const clipped = text.length > MAX_TEXT_LEN
      ? `${text.slice(0, MAX_TEXT_LEN)}\n…（内容过长已截断）`
      : text

    // 3. 调模型（OpenAI 兼容；部分厂商不支持 response_format 时自动去掉重试）
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `账单来源：${source}\n\n账单原始内容：\n"""${clipped}"""` },
    ]
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const doFetch = (withJson) => fetch(`${cfg.apiUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.modelName,
        messages,
        temperature: 0.1,
        stream: false,
        ...(withJson ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    })
    let resp
    try {
      resp = await doFetch(true)
      if (resp.status === 400) resp = await doFetch(false)
    } catch {
      return res.status(502).json({ error: 'AI_NETWORK_ERROR' })
    } finally {
      clearTimeout(timer)
    }

    if (resp.status === 401) return res.status(401).json({ error: 'INVALID_KEY' })
    if (resp.status === 402) return res.status(402).json({ error: 'BALANCE' })
    if (!resp.ok) return res.status(502).json({ error: `AI_API_ERROR:${resp.status}` })

    // 4. 解析返回
    const data = await resp.json().catch(() => null)
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(502).json({ error: 'EMPTY_RESPONSE' })
    }
    let items = null
    try {
      items = extractJsonArray(content)
    } catch {
      return res.status(502).json({ error: 'PARSE_ERROR' })
    }
    if (!items || !Array.isArray(items)) return res.status(502).json({ error: 'PARSE_ERROR' })

    res.json({ items })
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) })
  }
})

/** POST /api/ai/chat：统一对话接口，从 settings 表读 modelConfig 动态选模型 */
aiRouter.post('/chat', async (req, res) => {
  try {
    const cfg = readModelConfig()
    if (!cfg) {
      return res.status(409).json({ error: 'MISSING_CONFIG' })
    }
    const messages = req.body?.messages
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'EMPTY_MESSAGES' })
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    let resp
    try {
      resp = await fetch(`${cfg.apiUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.modelName,
          messages,
          temperature: 0.3,
          stream: false,
        }),
        signal: controller.signal,
      })
    } catch {
      return res.status(502).json({ error: 'AI_NETWORK_ERROR' })
    } finally {
      clearTimeout(timer)
    }

    if (resp.status === 401) return res.status(401).json({ error: 'INVALID_KEY' })
    if (resp.status === 402) return res.status(402).json({ error: 'BALANCE' })
    if (!resp.ok) return res.status(502).json({ error: `AI_API_ERROR:${resp.status}` })

    const data = await resp.json().catch(() => null)
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(502).json({ error: 'EMPTY_RESPONSE' })
    }
    res.json({ content })
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e) })
  }
})

// =====================================================================
// AI 代理路由（server/routes/ai.js）
// 用途：智能记账「批量导入」的后端代理。
// 前端把文件解析出的原始文本（Excel/PDF/OCR）POST 到这里，
// 服务端读取 settings 表里的 DeepSeek API Key 调模型做结构化提取，
// 避免在前端暴露 Key。
//
// 约定：
//   POST /api/ai/extract  { text, source } → { items: [...] }
//   409 MISSING_KEY  服务器 settings 表里没有 Key（前端可降级为直连调用）
//   401 INVALID_KEY  Key 无效
//   402 BALANCE      余额不足
//   502 AI_*         AI 服务错误（网络/上游 4xx/5xx/空响应/解析失败）
// =====================================================================
import { Router } from 'express'
import { db } from '../db.js'

const API_BASE = 'https://api.deepseek.com'
const MODEL = 'deepseek-chat'
const TIMEOUT_MS = 60_000
const MAX_TEXT_LEN = 20_000 // 超出截断，避免超长输入浪费 token

const SYSTEM_PROMPT = `你是一个记账助手。用户会给你一份账单的原始文本（可能来自 Excel 表格、PDF 账单或 OCR 截图识别），里面可能包含一条或多条交易记录。请把所有交易记录逐条提取出来，整理成结构化 JSON 数组返回，不要输出任何其他文字。

每条记录的格式：
{"amount": 金额（元，数字）, "txType": "expense" 支出 或 "income" 收入（无法判断时默认 "expense"）, "category": "餐饮|购物|日用百货|娱乐|交通|虚拟消费|其他", "merchant": "商家名称或交易对方（未知填 未知商家）", "time": "交易日期（YYYY-MM-DD，无法确定日期用今天）", "paymentMethod": "微信|支付宝|银行卡|现金|花呗|信用支付|先用后付|分期", "note": "备注或空字符串"}

要求：
1. 逐条提取，不能合并或遗漏。原始数据里明确有 5 笔交易就输出 5 条，有 20 笔就输出 20 条。
2. 金额只提取实际交易金额，统一为正数（若原表用负号或「支出」列表示支出，转换为正数）。
3. 跳过退款、手续费说明、合计/汇总行、以及无关说明文字，它们不算交易记录。
4. 时间优先用原始数据里的日期；没有日期时用今天。
5. 日期格式必须是 YYYY-MM-DD。`

export const aiRouter = Router()

/** 从模型返回内容里提取 JSON 数组（兼容输出多余文字/代码块） */
function extractJsonArray(content) {
  const cleaned = content.replace(/```json/gi, '').replace(/```/g, '').trim()
  const arrStart = cleaned.indexOf('[')
  const arrEnd = cleaned.lastIndexOf(']')
  if (arrStart >= 0 && arrEnd > arrStart) {
    const parsed = JSON.parse(cleaned.slice(arrStart, arrEnd + 1))
    if (Array.isArray(parsed)) return parsed
  }
  const objStart = cleaned.indexOf('{')
  const objEnd = cleaned.lastIndexOf('}')
  if (objStart >= 0 && objEnd > objStart) {
    const parsed = JSON.parse(cleaned.slice(objStart, objEnd + 1))
    return [parsed]
  }
  return null
}

/** POST /api/ai/extract：把原始账单文本结构化提取为记账条目数组 */
aiRouter.post('/extract', async (req, res) => {
  try {
    // 1. Key：只从服务器 settings 表读取，前端拿不到
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'deepseekApiKey'`).get()
    const key = row?.value
    if (!key || !String(key).trim()) {
      return res.status(409).json({ error: 'MISSING_KEY' })
    }

    // 2. 入参
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
    if (!text) return res.status(400).json({ error: 'EMPTY_TEXT' })
    const source = typeof req.body?.source === 'string' && req.body.source ? req.body.source : '账单'
    const clipped = text.length > MAX_TEXT_LEN
      ? `${text.slice(0, MAX_TEXT_LEN)}\n…（内容过长已截断）`
      : text

    // 3. 调 DeepSeek
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    let resp
    try {
      resp = await fetch(`${API_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${String(key).trim()}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `账单来源：${source}\n\n账单原始内容：\n"""${clipped}"""` },
          ],
          temperature: 0.1,
          stream: false,
          response_format: { type: 'json_object' },
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

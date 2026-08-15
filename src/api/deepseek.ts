import { getModelConfig, isVisionModel, DEEPSEEK_API_KEY } from './modelConfig'
import type { ModelConfig } from './modelConfig'
import { ocrImageDataUrl } from '../utils/ocr'

// ==================== 常量 ====================

// 旧版设置项 key（自动迁移用）；新配置统一存 modelConfig（见 src/api/modelConfig.ts）
export { DEEPSEEK_API_KEY }
const REQUEST_TIMEOUT_MS = 30_000 // 所有 AI 调用统一 30 秒超时

// 结构化记账返回
export interface ParsedLedgerItem {
  amount: number // 金额（元）
  category: string // 餐饮/购物/日用百货/娱乐/交通/虚拟消费/其他
  merchant: string
  time: string // YYYY-MM-DD
  paymentMethod: string // 微信/支付宝/银行卡/现金/花呗/信用支付/先用后付/分期
  note: string
  /** 收支类型（批量导入视觉路径用，便于收入/支出区分） */
  txType?: 'income' | 'expense'
}

// 系统固定分类与支付方式（供确认卡片下拉）
export const LEDGER_CATEGORIES = ['餐饮', '购物', '日用百货', '娱乐', '交通', '虚拟消费', '其他']
export const LEDGER_PAYMENTS = ['微信', '支付宝', '银行卡', '现金', '花呗', '信用支付', '先用后付', '分期']

// 模型不支持图片识别（调用方应降级为手动填写）
export class VisionUnsupportedError extends Error {
  constructor() {
    super('当前模型不支持图片识别')
    this.name = 'VisionUnsupportedError'
  }
}

// ==================== Key 检查 ====================

/** 检查是否已配置 AI 模型（有有效 API Key），未配置返回 false */
export async function hasApiKey(): Promise<boolean> {
  return (await getModelConfig()) !== null
}

// ==================== 内部工具 ====================

export type ChatContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>
export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}
export interface ChatTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: ChatContent | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ChatCompletionOptions {
  /** 流式输出回调：每收到一个文本增量调用一次（启用后走 SSE） */
  onChunk?: (delta: string) => void
  temperature?: number
  /** 要求返回严格 JSON */
  json?: boolean
}

async function getApiKey(): Promise<string | null> {
  const cfg = await getModelConfig()
  return cfg?.apiKey ?? null
}

/**
 * 通用对话接口：非流式或流式（SSE）均可。
 * 未配置 Key 抛 NO_API_KEY；网络错误抛 NETWORK_ERROR；超时抛 TIMEOUT。
 */
export async function chatCompletion(
  messages: ChatMessage[],
  options: ChatCompletionOptions = {}
): Promise<string> {
  const cfg = await getModelConfig()
  if (!cfg) throw new Error('NO_API_KEY')
  const key = cfg.apiKey
  const apiUrl = cfg.apiUrl.replace(/\/+$/, '')

  const useStream = typeof options.onChunk === 'function'
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, REQUEST_TIMEOUT_MS)

  const body: Record<string, unknown> = {
    model: cfg.modelName,
    messages,
    temperature: options.temperature ?? 0.3,
    stream: useStream,
  }
  if (options.json) body.response_format = { type: 'json_object' }

  let resp: Response
  try {
    resp = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch {
    if (timedOut) throw new Error('TIMEOUT')
    throw new Error('NETWORK_ERROR')
  } finally {
    clearTimeout(timer)
  }

  if (!resp.ok) {
    // 400 = 请求内容不被接受（如模型不支持图片）→ 图片识别走降级
    if (resp.status === 400) throw new VisionUnsupportedError()
    if (resp.status === 401) throw new Error('INVALID_KEY')
    throw new Error(`API_ERROR:${resp.status}`)
  }

  // ---- 流式（SSE） ----
  if (useStream && resp.body) {
    let full = ''
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    const timeoutReader = setTimeout(() => { reader.cancel().catch(() => undefined) }, REQUEST_TIMEOUT_MS)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        // 按行解析 SSE：data: {...}
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>
            }
            const delta = parsed.choices?.[0]?.delta?.content
            if (delta) {
              full += delta
              options.onChunk!(delta)
            }
          } catch {
            // 忽略无法解析的心跳/空行
          }
        }
      }
    } catch {
      if (timedOut) throw new Error('TIMEOUT')
      throw new Error('NETWORK_ERROR')
    } finally {
      clearTimeout(timeoutReader)
    }
    if (!full.trim()) throw new Error('EMPTY_RESPONSE')
    return full
  }

  // ---- 非流式 ----
  const data = await resp.json().catch(() => null)
  const content: unknown = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('EMPTY_RESPONSE')
  return content
}

/** Agent 工具调用回合结果 */
export interface AgentTurnResult {
  /** 模型生成的文本（可能为 null，此时通常伴随 tool_calls） */
  content: string | null
  toolCalls: ToolCall[]
}

/**
 * Agent 专用对话接口：非流式，携带 tools（OpenAI 兼容 function calling）。
 * 返回模型决策：要么给出最终文本，要么请求调用一个或多个工具。
 */
export async function agentCompletion(
  messages: ChatMessage[],
  tools: ChatTool[],
  options: { temperature?: number } = {}
): Promise<AgentTurnResult> {
  const cfg = await getModelConfig()
  if (!cfg) throw new Error('NO_API_KEY')
  const key = cfg.apiKey
  const apiUrl = cfg.apiUrl.replace(/\/+$/, '')

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, REQUEST_TIMEOUT_MS)

  let resp: Response
  try {
    resp = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: cfg.modelName,
        messages,
        tools,
        temperature: options.temperature ?? 0.3,
        stream: false,
      }),
      signal: controller.signal,
    })
  } catch {
    if (timedOut) throw new Error('TIMEOUT')
    throw new Error('NETWORK_ERROR')
  } finally {
    clearTimeout(timer)
  }

  if (!resp.ok) {
    if (resp.status === 401) throw new Error('INVALID_KEY')
    throw new Error(`API_ERROR:${resp.status}`)
  }

  const data = await resp.json().catch(() => null)
  const msg = data?.choices?.[0]?.message
  const content: unknown = msg?.content
  const toolCalls: ToolCall[] = Array.isArray(msg?.tool_calls) ? (msg.tool_calls as ToolCall[]) : []
  return { content: typeof content === 'string' ? content : null, toolCalls }
}

// ==================== 健壮 JSON 列表提取 ====================
// 兼容模型在 json_object 模式下的各种包装形态：
//  1) 顶层数组            [ {...}, {...} ]
//  2) 包装对象            {"items": [...], "total": 2} / {"transactions": [...]} / {"result": [...]}
//  3) 数字键对象          {"0": {...}, "1": {...}}
//  4) 嵌套数组（按页返回） [[ {...} ], [ {...} ]]
//  5) 单条记录对象        {"amount": 88.5, ...}
// =====================================================================

/** 递归把（可能嵌套的）数组拍平为纯对象列表 */
function flattenList(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return []
  const out: Record<string, unknown>[] = []
  for (const item of v) {
    if (Array.isArray(item)) out.push(...flattenList(item))
    else if (item && typeof item === 'object') out.push(item as Record<string, unknown>)
  }
  return out
}

/**
 * 扫描字符串中最外层的成对 [ ]（跳过字符串里的括号），
 * 对每个候选做 JSON 解析，返回「展开后条目最多」的那个数组（并列时取靠后者，
 * 兼容 json_object 包装对象里真实数据字段在后的情况）。
 */
function extractOutermostArray(s: string): Record<string, unknown>[] | null {
  const candidates: { start: number; parsed: unknown }[] = []
  const stack: number[] = []
  let inStr = false
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) inStr = false
      continue
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue }
    if (ch === '[') stack.push(i)
    else if (ch === ']' && stack.length > 0) {
      const start = stack.pop()!
      if (stack.length === 0) {
        try {
          const parsed = JSON.parse(s.slice(start, i + 1))
          if (Array.isArray(parsed)) candidates.push({ start, parsed })
        } catch { /* 忽略解析失败的候选 */ }
      }
    }
  }
  if (candidates.length === 0) return null
  let best: { start: number; parsed: unknown } = candidates[0]
  for (const c of candidates) {
    const len = flattenList(c.parsed).length
    const bestLen = flattenList(best.parsed).length
    if (len > bestLen || (len === bestLen && c.start > best.start)) best = c
  }
  return flattenList(best.parsed)
}

/** 扫描字符串中最外层的成对 { }，解析为对象；失败返回 null */
function tryParseOuterObject(s: string): Record<string, unknown> | null {
  const stack: number[] = []
  let inStr = false
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) inStr = false
      continue
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue }
    if (ch === '{') stack.push(i)
    else if (ch === '}' && stack.length > 0) {
      const start = stack.pop()!
      if (stack.length === 0) {
        try {
          const parsed = JSON.parse(s.slice(start, i + 1))
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>
          }
        } catch { /* 忽略解析失败的候选 */ }
      }
    }
  }
  return null
}

/**
 * 从 AI 返回内容中提取 JSON 对象数组（兼容多余文字/代码块/包装对象/嵌套数组/数字键对象/单条对象）。
 * 解析失败抛 PARSE_ERROR。
 */
export function extractJsonList(content: string): Record<string, unknown>[] {
  const cleaned = content.replace(/```json/gi, '').replace(/```/g, '').trim()

  // 1) 数组（含被 {"items": [...]} 等包装的数组）
  const arr = extractOutermostArray(cleaned)
  if (arr !== null) return arr

  // 2) 对象：包装对象 / 数字键对象 / 单条记录
  const obj = tryParseOuterObject(cleaned)
  if (obj) {
    // 2a) 包装对象：取第一个数组值（items/transactions/records/result/data…）
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) return flattenList(v)
    }
    // 2b) 数字键对象：按 key 数值顺序取值
    const keys = Object.keys(obj)
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      return keys
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => obj[k])
        .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v))
    }
    // 2c) 单条记录对象
    return [obj]
  }
  throw new Error('PARSE_ERROR')
}

/** 从 AI 返回内容中提取 JSON 数组（旧内部函数名，内部调用走 extractJsonList） */
function parseJsonArray(content: string): Record<string, unknown>[] {
  return extractJsonList(content)
}

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 校验/补全 AI 返回的单条记录 */
export function normalizeItem(raw: Record<string, unknown> | null | undefined): ParsedLedgerItem {
  if (!raw) {
    return { amount: 0, category: '其他', merchant: '', time: todayStr(), paymentMethod: '微信', note: '' }
  }
  const amount = Math.max(0, parseFloat(String(raw.amount)) || 0)
  const category = LEDGER_CATEGORIES.includes(String(raw.category)) ? String(raw.category) : '其他'
  const paymentMethod = LEDGER_PAYMENTS.includes(String(raw.paymentMethod)) ? String(raw.paymentMethod) : '微信'
  // 时间：优先匹配 YYYY-MM-DD
  const timeMatch = String(raw.time ?? '').match(/\d{4}-\d{2}-\d{2}/)
  const time = timeMatch ? timeMatch[0] : todayStr()
  return {
    amount,
    category,
    merchant: String(raw.merchant ?? '').trim() || '未知商家',
    time,
    paymentMethod,
    note: String(raw.note ?? '').trim(),
  }
}

/** 把 AI 抛出的错误转成面向用户的友好提示 */
export function aiErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg === 'NO_API_KEY') return '请先到设置页配置 API Key'
  if (msg === 'NETWORK_ERROR') return '网络异常，请检查网络后重试'
  if (msg === 'TIMEOUT') return '请求超时（30秒），请稍后再试'
  if (msg === 'INVALID_KEY') return 'API Key 无效，请到设置页检查'
  if (msg === 'EMPTY_RESPONSE') return 'AI 返回为空，请重试'
  if (msg === 'PARSE_ERROR') return 'AI 返回格式有误，请重试'
  if (msg.startsWith('API_ERROR:')) {
    const code = Number(msg.slice(10))
    if (code === 402) return '所选模型厂商账户余额不足，请到对应平台充值'
    if (code === 429) return '请求过于频繁，请稍后再试'
    if (code === 401) return 'API Key 无效，请到设置页检查'
    return `服务暂时不可用（${code}），请稍后再试`
  }
  if (e instanceof VisionUnsupportedError) return '当前模型不支持图片识别'
  return 'AI 服务出错，请稍后再试'
}

// ==================== 记账解析（截图 / 语音） ====================

const SYSTEM_MSG = '你是一个记账助手，负责把交易截图或口语描述整理成结构化记账数据。只输出 JSON，不要任何额外文字或解释。'

/**
 * 批量识别支付/交易截图，返回结构化记账数据数组（与图片顺序一一对应）。
 * 模型支持视觉 → 直接传图片；纯文本模型 → 先本地 OCR 提取文字再交给模型。
 * 两者都失败（如图片识别不出文字）抛 VisionUnsupportedError，调用方降级为手动填写。
 */
export async function analyzeReceiptImage(imageDataUrls: string[]): Promise<ParsedLedgerItem[]> {
  if (imageDataUrls.length === 0) throw new Error('EMPTY_IMAGES')

  const cfg = await getModelConfig()
  const vision = !!cfg && isVisionModel(cfg.modelName)

  // ---- 视觉模型：直接传图片 ----
  if (vision) {
    const content = await chatCompletion([
      { role: 'system', content: SYSTEM_MSG },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `以下有 ${imageDataUrls.length} 张交易截图，请按顺序逐张识别消费信息，返回 JSON 数组（数组长度必须为 ${imageDataUrls.length}，顺序与图片一致）。每项格式：{"amount": 金额（元，数字，必须识别出具体数值）, "category": "餐饮|购物|日用百货|娱乐|交通|虚拟消费|其他", "merchant": "商家名称", "time": "交易日期（YYYY-MM-DD）", "paymentMethod": "微信|支付宝|银行卡|现金|先用后付|分期", "note": "备注或空字符串"}。无法识别的图对应元素返回 null。`,
          },
          ...imageDataUrls.map(url => ({ type: 'image_url', image_url: { url } })),
        ],
      },
    ], { json: true, temperature: 0.1 })

    const rawList = parseJsonArray(content)
    return rawList.map(r => normalizeItem(r))
  }

  // ---- 纯文本模型：本地 OCR 提取文字，再交给模型解析 ----
  const texts: string[] = []
  for (const url of imageDataUrls) {
    try { texts.push(await ocrImageDataUrl(url)) } catch { texts.push('') }
  }
  if (texts.every(t => !t.trim())) throw new VisionUnsupportedError()

  const content = await chatCompletion([
    { role: 'system', content: SYSTEM_MSG },
    {
      role: 'user',
      content:
        `以下是 ${texts.length} 张交易截图 OCR 识别出的文字（按图片顺序），请逐张解析消费信息，返回 JSON 数组（数组长度必须为 ${texts.length}，顺序与图片一致）。` +
        `每项格式：{"amount": 金额（元，数字，必须识别出具体数值）, "category": "餐饮|购物|日用百货|娱乐|交通|虚拟消费|其他", "merchant": "商家名称", "time": "交易日期（YYYY-MM-DD）", "paymentMethod": "微信|支付宝|银行卡|现金|先用后付|分期", "note": "备注或空字符串"}。无法识别的图对应元素返回 null。\n\n` +
        texts.map((t, i) => `【第 ${i + 1} 张】\n${t || '（未能识别出文字）'}`).join('\n\n'),
    },
  ], { json: true, temperature: 0.1 })

  const rawList = parseJsonArray(content)
  return rawList.map(r => normalizeItem(r))
}

// ---- 多记录提取（一张图/一份文件里可能有多条账单） ----

/** 多记录提取的公共提示语（要求返回 {"items": [...]}，兼容 json_object 模式） */
const MULTI_SYSTEM_MSG =
  '你是一个记账助手，负责从支付/交易截图或账单列表中提取所有账单记录。只输出 JSON，不要任何额外文字或解释。'
const MULTI_ITEM_SCHEMA =
  '{"amount": 金额（元，数字，必须识别出具体数值）, "txType": "expense" 支出 或 "income" 收入（默认 "expense"）, "category": "餐饮|购物|日用百货|娱乐|交通|虚拟消费|其他", "merchant": "商家名称", "time": "交易日期（YYYY-MM-DD，无法确定用今天）", "paymentMethod": "微信|支付宝|银行卡|现金|先用后付|分期", "note": "备注或空字符串"}'
const MULTI_COMMON_RULE =
  '要求：一张图/一份文件里可能出现 1~20 条记录，请逐条提取、不能合并也不能遗漏；跳过退款、手续费说明、合计/汇总行和无关文字；金额统一为正数。' +
  '返回格式（严格 JSON 对象）：{"items": [ {记录}, {记录}, ... ]}'

/**
 * 批量识别支付/交易截图中的「所有」账单记录（每张图可能含 1~20 条，全部合并返回）。
 * 模型支持视觉 → 直接传图片；纯文本模型 → 先本地 OCR 提取文字再交给模型。
 * 过滤掉金额为 0 的无效条目（模型没识别出金额的算失败）。
 */
export async function analyzeReceiptImagesMulti(imageDataUrls: string[]): Promise<ParsedLedgerItem[]> {
  if (imageDataUrls.length === 0) throw new Error('EMPTY_IMAGES')

  const cfg = await getModelConfig()
  const vision = !!cfg && isVisionModel(cfg.modelName)

  const toItem = (r: Record<string, unknown>): ParsedLedgerItem => ({
    ...normalizeItem(r),
    txType: String(r.txType ?? '').toLowerCase() === 'income' ? 'income' : 'expense',
  })
  const toItems = (rawList: Record<string, unknown>[]) => rawList.map(toItem).filter(it => it.amount > 0)

  // ---- 视觉模型：直接传图片 ----
  if (vision) {
    const content = await chatCompletion([
      { role: 'system', content: MULTI_SYSTEM_MSG },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `以下是 ${imageDataUrls.length} 张交易截图，请识别其中出现的所有交易记录（每张图可能有 1~20 条），全部提取后合并为一个列表返回。\n` +
              `${MULTI_COMMON_RULE}\n每条记录格式：${MULTI_ITEM_SCHEMA}`,
          },
          ...imageDataUrls.map(url => ({ type: 'image_url', image_url: { url } })),
        ],
      },
    ], { json: true, temperature: 0.1 })

    const rawList = extractJsonList(content)
    return toItems(rawList)
  }

  // ---- 纯文本模型：本地 OCR 提取文字，再交给模型提取全部记录 ----
  const texts: string[] = []
  for (const url of imageDataUrls) {
    try { texts.push(await ocrImageDataUrl(url)) } catch { texts.push('') }
  }
  if (texts.every(t => !t.trim())) throw new VisionUnsupportedError()

  const content = await chatCompletion([
    { role: 'system', content: MULTI_SYSTEM_MSG },
    {
      role: 'user',
      content:
        `以下是 ${texts.length} 张交易截图 OCR 识别出的文字（按图片顺序），请提取其中出现的所有交易记录（一张图可能有 1~20 条），全部提取后合并为一个列表返回。\n` +
        `${MULTI_COMMON_RULE}\n每条记录格式：${MULTI_ITEM_SCHEMA}\n\n` +
        texts.map((t, i) => `【第 ${i + 1} 张】\n${t || '（未能识别出文字）'}`).join('\n\n'),
    },
  ], { json: true, temperature: 0.1 })

  const rawList = extractJsonList(content)
  return toItems(rawList)
}

/** 测试连接结果 */
export interface ConnectionTestResult {
  ok: boolean
  message: string
}

/**
 * 测试一组模型配置是否可用（设置页「测试连接」）：
 * 用当前填写的配置调用 /chat/completions 发送一条最小消息，能返回内容即视为成功。
 */
export async function testModelConnection(cfg: ModelConfig): Promise<ConnectionTestResult> {
  const key = (cfg.apiKey ?? '').trim()
  const url = (cfg.apiUrl ?? '').trim().replace(/\/+$/, '')
  const model = (cfg.modelName ?? '').trim()
  if (!key) return { ok: false, message: '请先填写 API Key' }
  if (!url) return { ok: false, message: '请先填写 API Base URL' }
  if (!model) return { ok: false, message: '请先填写模型 ID' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let resp: Response
  try {
    resp = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        temperature: 0,
        stream: false,
      }),
      signal: controller.signal,
    })
  } catch {
    return { ok: false, message: '网络连接失败，请检查 API Base URL 与网络' }
  } finally {
    clearTimeout(timer)
  }

  if (resp.status === 401) return { ok: false, message: 'API Key 无效（401），请检查后重试' }
  if (resp.status === 429) return { ok: false, message: '请求过于频繁（429），请稍后再试' }
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 200)
    return { ok: false, message: `服务返回错误（HTTP ${resp.status}）${detail ? '：' + detail : ''}` }
  }

  const data = await resp.json().catch(() => null)
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, message: '返回内容为空，请检查模型 ID 是否填写正确' }
  }
  return { ok: true, message: '连接成功' }
}

/** 把口语描述解析成一条结构化记账数据 */
export async function parseVoiceText(text: string): Promise<ParsedLedgerItem> {
  if (!text.trim()) throw new Error('EMPTY_TEXT')

  const content = await chatCompletion([
    { role: 'system', content: SYSTEM_MSG },
    {
      role: 'user',
      content: `请把下面这条口语描述解析成一条消费记录，返回严格 JSON：{"amount": 金额（元，数字）, "category": "餐饮|购物|日用百货|娱乐|交通|虚拟消费|其他", "merchant": "商家名称", "time": "YYYY-MM-DD（没提到日期就用今天）", "paymentMethod": "微信|支付宝|银行卡|现金|花呗|信用支付|先用后付|分期", "note": "备注或空字符串"}。
描述："""${text}"""`,
    },
  ], { json: true, temperature: 0.1 })

  const rawList = parseJsonArray(content)
  return normalizeItem(rawList[0])
}

// ==================== 报告 / 问答 / 冲动解读 ====================

/** 块标记格式硬约束：所有生成报告/回答的 Prompt 统一追加（前端 RichMessage 富渲染） */
const BLOCK_FORMAT_RULE =
  '你的回答必须使用块标记格式输出（[stat]/[insight]/[tip]/[progress]/[bars]/[text]/[conclusion]），' +
  '数字必须来自用户提供的 facts，禁止编造数字。数字卡最多3个，建议卡2-3条，发现卡1-2条。回答要简洁，不要输出多余解释。'

/** 块标记语法说明（随规则一起发给模型，保证格式正确） */
const BLOCK_FORMAT_SPEC = `
块标记语法（每个块成对出现，先开始标记后结束标记）：
[stat]
标签1|数字1|单位1
标签2|数字2|单位2
[/stat]
（数字卡，最多3行；单位可省略）

[insight]
一条发现（每行一条，1-2行）
[/insight]

[tip]
一条建议（每行一条，2-3行）
[/tip]

[progress]
标签|百分比数字
[/progress]
（如「本月预算|62」，标签只写名称，禁止包含 ██ 进度条符号或星号）

[bars]
标签|百分比数字（3-6行）
[/bars]
（每行格式为「标签|百分比」，如「餐饮|35」「购物|28」。标签只写分类名，禁止在标签里画 ████ 进度条或使用星号；百分比必须是纯数字（可带%，如 35%），不要写 0）

[text]
普通段落文字
[/text]

[conclusion]
一句话结论
[/conclusion]

规则：数字卡/进度条/条形图中的百分比必须是 facts 里能算出的真实比例；不要输出块标记之外的文字。`

/**
 * 生成财务报告：接收结构化 facts（数字全部由前端代码算出）+ 报告类型，
 * AI 只负责组织语言，按块标记格式输出（前端 RichMessage 富渲染）。
 */
export async function generateReport(
  facts: Record<string, unknown>,
  reportType: 'day' | 'week' | 'month'
): Promise<string> {
  const typeLabel = reportType === 'day' ? '每日摘要' : reportType === 'week' ? '每周分析' : '每月复盘'
  const structure = reportType === 'day'
    ? `【每日摘要】用块标记输出，建议包含：1 个 [stat]（今日支出/今日收入/预算剩余）、1 个 [progress]（本月预算使用率）、1-2 条 [insight] 发现、2-3 条 [tip] 明日建议、1 个 [conclusion]。
内容要点：
- 今日收支：今日支出总额，Top3 笔（商家+金额）、今日收入
- 今日冲动：冲动笔数（为 0 要给表扬）
- 今日冷静记录：如果 facts.coolingStats 存在且 triggerCount>0，在 insight 里用一条概括「🧊 今日冷静记录」：今天触发冷静流程 X 次、拦截（放清单/取消）金额合计 ¥Y、拆解要点用一句概括。引用数字只限 coolingStats 内的 triggerCount / blockedMinor，不要逐条复述拆解文案里的金额
- 明日建议：根据本月剩余预算和日均消费，给出明日可花额度建议
- 昨日承诺引用：如果 facts.yesterdayPromise 存在，用一条 [text] 或 [insight] 引用（如：昨天你承诺『${'${facts.yesterdayPromise}'}』，今天做到了吗？），引用承诺时不要重复写出具体金额`
    : reportType === 'week'
      ? `【每周分析】用块标记输出，建议包含：1 个 [stat]（本周总支出/上周支出/差额）、1 个 [bars]（分类占比）、1-2 条 [insight]、2-3 条 [tip] 改进建议、1 个 [conclusion]。
内容要点：
- 本周总结：本周总支出、环比上周变化%
- 消费结构：本周各分类占比（Top 分类）
- 情绪模式：基于冲动时段分布判断（深夜冲动多=压力型/报复性熬夜购物，白天高频小额=无聊型，大额偶发=FOMO型）——直接采用 facts 里给出的判断，不要自己猜
- 冲动分析：本周冲动总额、冲动次数
- 改进建议：1-3 条具体可执行的建议（基于真实数据，如"本周深夜消费 3 次共 ¥XX，建议设置 22 点后冷静提醒"）`
      : `【每月复盘】用块标记输出，建议包含：1 个 [stat]（总支出/预算/结余）、1 个 [progress]（预算执行率）、1 个 [bars]（分类占比）、1-2 条 [insight]、2-3 条 [tip] 下月建议、1 个 [conclusion]。
内容要点：
- 月度总览：总支出、总储蓄（或结余）、总负债、预算执行率
- 分类明细：各分类支出+占比+环比
- 储蓄分析：储蓄进度
- 债务分析：负债变化
- 冲动趋势：本月冲动与上月对比
- 下月建议：3 条具体建议`

  return chatCompletion([
    {
      role: 'system',
      content: `你是一名严谨的个人财务分析师。你只会基于用户提供的结构化数据（facts，JSON）来写报告，绝不编造 facts 中没有的数字。
纪律：以上数字已由本地精确计算，你只需组织语言，严禁编造数字；如果 facts 缺失某项，就明确说明"数据不足"；不要输出 facts 之外的任何金额。回答必须给出可验证的"结论+证据"：每个结论引用 facts 中的真实数字（金额/笔数/占比/时段），并可对应到界面图表。
${BLOCK_FORMAT_RULE}
${BLOCK_FORMAT_SPEC}`,
    },
    {
      role: 'user',
      content: `以下是前端代码从数据库算出的真实数据 facts（JSON）：\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\`\n\n请按下面规格生成${typeLabel}（块标记格式）：\n${structure}`,
    },
  ], { temperature: 0.4 })
}

/**
 * HTML 报告专用：AI 只生成"洞察/建议/行动项"三段文字（块标记格式）。
 * 数字全部来自前端算好的 facts，禁止编造。失败（无 Key/网络/解析）时抛错，调用方降级本地模板。
 */
export async function generateReportText(
  facts: Record<string, unknown>,
  reportType: 'day' | 'week' | 'month'
): Promise<string> {
  const typeLabel = reportType === 'day' ? '日报' : reportType === 'week' ? '周报' : '月报'
  const system = `你是一名严谨的个人财务分析师。只基于用户提供的 facts（JSON）生成报告的文字部分，数字必须来自 facts，绝不编造 facts 中不存在的数字。

输出格式（严格遵循，块标记成对出现，每条一行，不要输出这三个块以外的任何内容）：
[insight]
每条发现一行，共 1-2 条；每条≤60字，必须引用真实数字；指出消费模式或需要注意的点（如冲动集中时段、某分类占比过高、预算压力、负债或储蓄情况）。如果 facts.life 有数据，优先引用其中的生活数据：净资产变化（life.netWorth.delta）、降价追踪（life.priceDrop：冷静后买的X件平均便宜Y%）、情绪对比（life.moods：压力大日均 vs 平静日）、自我承诺（life.commitments 进度）
[/insight]

[tip]
每条建议一行，共 2-3 条；具体可执行，引用真实数字（如"把购物类控制在预算的30%以内"）
[/tip]

[action]
共 3 条行动项；每条以动词开头，8-15字，简洁明确、可勾选执行（如"设置本月购物支出上限500元"）
[/action]`
  const user = `报告类型：${typeLabel}
facts（JSON，全部由前端从数据库算出）：
\`\`\`json
${JSON.stringify(facts, null, 2)}
\`\`\`

请生成 [insight] / [tip] / [action] 三段文字。`
  return chatCompletion([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { temperature: 0.5 })
}

/** 数据问答：接收 facts + 用户问题，AI 基于 facts 组织语言回答 */
export async function chatQuery(
  facts: Record<string, unknown>,
  question: string,
  options: { onChunk?: (delta: string) => void } = {}
): Promise<string> {
  return chatCompletion([
    {
      role: 'system',
      content: `你是个人财务助手。只基于提供的 facts（JSON）回答，数字必须来自 facts，绝不编造。回答简洁、口语化。
${BLOCK_FORMAT_RULE}
${BLOCK_FORMAT_SPEC}`,
    },
    {
      role: 'user',
      content: `真实数据 facts（JSON）：\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\`\n\n用户问题：${question}\n\n请基于 facts 直接回答（块标记格式）。`,
    },
  ], { temperature: 0.3, onChunk: options.onChunk })
}

/** 冲动消费 AI 解读：接收本月冲动统计 facts，按"结论+证据"格式生成分析 */
export async function generateImpulseAnalysis(facts: Record<string, unknown>): Promise<string> {
  return chatCompletion([
    {
      role: 'system',
      content: '你是一名消费行为分析师。只基于 facts（JSON）分析用户的冲动消费情况，数字必须来自 facts，严禁编造 facts 中不存在的数字。' +
        '输出必须遵循"结论 + 证据"格式：每个结论必须引用 facts 中的真实数字（金额、笔数、占比、时段、平台、冲动指数），并标注证据来源（如"见平台环形图""见时段柱状图""见热力图"）。' +
        '每个结论必须能在界面图表中找到对应数据。' +
        '结构：1）一句话结论（如"本月冲动消费 8 笔共 ¥278"）；2）2-3 条证据（如"75% 金额集中在拼多多，见平台环形图""50% 发生在凌晨 0-2 点，见时段柱状图""最大单笔 ¥89、冲动指数 57 分"）；3）2 条具体可执行建议。' +
        '不超过 250 字，用 Markdown 分点。',
    },
    {
      role: 'user',
      content: `本月冲动消费真实数据 facts（JSON，已由本地精确计算）：\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\`\n\n请按"结论+证据"格式给出冲动消费分析。`,
    },
  ], { temperature: 0.4 })
}

/**
 * 情绪-消费关联洞察（HTML 片段）。
 * 数字全部来自前端算好的 stats（JSON），禁止编造；失败时抛错，调用方降级本地模板。
 */
export async function generateMoodInsight(stats: Record<string, unknown>): Promise<string> {
  return chatCompletion([
    {
      role: 'system',
      content: '你是一名个人财务行为教练。你只基于用户提供的真实统计数据（stats，JSON）说话，数字必须全部来自 stats，禁止编造 stats 中没有的数字。' +
        '输出必须是精美 HTML 片段（内联CSS、蓝白配色、主色#0040FF、数字加粗等宽字体、标题靛蓝带左侧竖条、重要信息浅琥珀框、建议浅青卡片），禁止使用 Markdown 语法。' +
        '语气温和不说教。结构：1 条"发现"（引用真实数字，如压力大的日子日均消费比平静日高 X%）+ 1-2 条具体建议（如压力大时先散步 20 分钟再决定是否消费）。',
    },
    {
      role: 'user',
      content: `情绪-消费关联真实统计（JSON，全部由代码从本地数据库算出）：\n\`\`\`json\n${JSON.stringify(stats, null, 2)}\n\`\`\`\n\n请生成情绪洞察 HTML。`,
    },
  ], { temperature: 0.5 })
}

// ==================== 每日互动复盘（多轮追问） ====================

export type ReviewStep = 'Q1' | 'Q2' | 'Q3' | 'summary'

export interface ReviewMsg {
  role: 'assistant' | 'user'
  content: string
}

/**
 * 每日复盘互动追问：把对话历史 + 当日冲动 facts 交给 AI 生成下一轮文案。
 * 只返回要展示的一句话追问/总结文本（选项按钮由前端提供）。
 * 失败返回空字符串，调用方降级为本地模板。
 */
export async function generateReviewTurn(
  history: ReviewMsg[],
  facts: object,
  step: ReviewStep
): Promise<string> {
  const stepGuide: Record<ReviewStep, string> = {
    Q1: '本轮：基于 facts 引导用户区分这笔冲动消费是「需要」还是「想要」，语气平和不评判。',
    Q2: '本轮：引导用户回忆当时是什么触发了这笔冲动（如深夜刷手机、促销优惠、心情不好等），只追问原因，不要给建议。',
    Q3: '本轮：引导用户为明天定一个小目标（方向：控制明天购物支出、明天不逛购物平台、把冲动的钱存起来），给出引导语即可。',
    summary: '本轮：这是最后一轮。请汇总前面对话中用户的全部回答，输出一段 3-5 句的鼓励收尾：肯定他的觉察、复述他明天的承诺、给一句有力量的话。',
  }
  const system = `你是一名消费心理复盘教练，像朋友一样温和地引导用户反思，绝不评判、不啰嗦。\n你只输出本轮要显示给用户的一句话文本：不带选项按钮、不带序号前缀、不用 Markdown 标记。\n所有数字必须来自用户提供的 facts，绝不编造。\n${stepGuide[step]}`
  const user = `当日冲动复盘数据（JSON）：\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\`\n\n对话历史：\n${history.map(m => `${m.role === 'assistant' ? '教练' : '用户'}：${m.content}`).join('\n')}\n\n请生成本轮${step === 'summary' ? '鼓励总结' : '追问'}文本。`

  try {
    const content = await chatCompletion([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { temperature: 0.6 })
    return content.trim()
  } catch {
    return ''
  }
}

// ==================== 冷静流程 AI 深度分析 ====================

export interface CoolingAnalysis {
  /** 2-4 条消费心理拆解（每条 ≤60 字） */
  insights: string[]
  /** 3 个针对性追问（最后一个固定为"放清单/现在就买"） */
  questions: { question: string; options: string[] }[]
}

export const COOLING_DEFAULT_QUESTIONS: { question: string; options: string[] }[] = [
  { question: '这个东西三个月后你还会用吗？', options: ['会用', '不好说', '不会'] },
  { question: '如果不买，省下的钱你会存起来吗？', options: ['会存', '没想过', '我还是想要'] },
  { question: '要不要放进欲望清单，冷静24小时再决定？', options: ['放清单', '现在就买'] },
]

/**
 * 冷静流程 AI 深度分析（混合大脑模式）：
 * 数字由本地算好传入 facts，AI 只负责生成心理拆解文案 + 个性化三问。
 * 未配置 Key / 调用失败 / 解析失败 → 返回 null，调用方降级本地模板。
 */
export async function generateCoolingAnalysis(facts: object): Promise<CoolingAnalysis | null> {
  const key = await getApiKey()
  if (!key) return null

  const system = '你是一名消费心理学专家，语气温和、不评判，像一位懂心理的朋友。' +
    '只根据用户提供的真实数据（facts，JSON）进行分析，绝不编造 facts 之外的数字。'

  const user = `以下是一笔被拦截的冲动消费的真实数据（JSON）：
\`\`\`json
${JSON.stringify(facts, null, 2)}
\`\`\`

请返回严格 JSON，格式：
{"insights": ["...", "..."], "questions": [{"question": "...", "options": ["...", "..."]}]}

要求：
1. insights：2-4 条针对这个人的消费心理拆解，每条≤60字；必须引用 facts 中的真实数字；指出具体心理机制（现时偏误、损失厌恶、稀缺效应、沉没成本、心理账户、支付痛感、从众等中的一个或多个）；语气温和不judge。每条以类型前缀开头："insight: "（心理机制发现，🔍）或 "tip: "（一句应对建议，📌），至少要有 1 条 insight。
2. questions：3 个针对性追问（基于 facts 个性化，例如用户同平台多单就问"这几单里哪一单是真需要的"），每个问题配 2-3 个按钮选项（简洁、可点击）；第 3 个问题必须固定为"要不要放进欲望清单，冷静24小时再决定？"，options 必须固定为 ["放清单", "现在就买"]。
3. 全部用中文，options 简洁（≤8字）。`

  try {
    const content = await chatCompletion([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { json: true, temperature: 0.6 })

    const cleaned = content.replace(/```json/gi, '').replace(/```/g, '').trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    const raw = JSON.parse(cleaned.slice(start, end + 1)) as {
      insights?: unknown
      questions?: unknown
    }

    const insights = Array.isArray(raw.insights)
      ? raw.insights.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map(s => s.trim()).slice(0, 4)
      : []
    const questions = Array.isArray(raw.questions)
      ? raw.questions
        .filter((q): q is { question: unknown; options: unknown } =>
          !!q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string' &&
          Array.isArray((q as { options?: unknown }).options))
        .map(q => ({
          question: String(q.question).trim(),
          options: (q.options as unknown[]).map(o => String(o).trim()).filter(Boolean).slice(0, 3),
        }))
        .filter(q => q.question && q.options.length > 0)
      : []

    if (insights.length === 0 && questions.length === 0) return null
    // 补齐/兜底为 3 个问题，最后一个固定"放清单/现在就买"
    while (questions.length < 3) {
      questions.push(COOLING_DEFAULT_QUESTIONS[questions.length])
    }
    questions[2] = COOLING_DEFAULT_QUESTIONS[2]
    return { insights, questions: questions.slice(0, 3) }
  } catch {
    return null
  }
}

/**
 * 欲望清单「AI帮我看」：判断清单物品的必要性并给出建议。
 * 返回块标记文本（[insight]+[tip]+[conclusion]），前端 RichMessage 渲染。
 */
export async function generateWishlistInsight(
  item: { name: string; priceMinor: number; coolingEndsAt: string },
  facts: object
): Promise<string> {
  const system = `你是消费决策顾问，语气温和、不评判。基于用户提供的物品信息和财务数据，判断这个想买的物品是否真的需要，并给出可执行的建议。只引用 facts 中的真实数字，绝不编造。
${BLOCK_FORMAT_RULE}
${BLOCK_FORMAT_SPEC}`
  const user = `用户欲望清单里的物品：
\`\`\`json
${JSON.stringify(item, null, 2)}
\`\`\`
用户财务数据（JSON）：
\`\`\`json
${JSON.stringify(facts, null, 2)}
\`\`\`

请用块标记输出：1-2 条 [insight]（必要性判断，引用价格与用户画像数字）、2-3 条 [tip]（具体建议，如放清单再冷静几天、怎样省出这笔钱）、结尾 1 个 [conclusion]。`
  return chatCompletion([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { temperature: 0.5 })
}

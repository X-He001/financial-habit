// =====================================================================
// 批量导入工具（src/utils/batchImport.ts）
// 智能记账「批量导入」核心逻辑：
//  1. parseImportFile      解析 Excel / PDF / 截图（OCR）为原始文本
//  2. structureTextToItems 调 DeepSeek 把非结构化文本结构化（后端代理优先，失败降级前端直连）
//  3. saveBatchItems       批量写入 IndexedDB（复用 guardTransaction 计算冲动分）
// =====================================================================
import type { Transaction } from '../types'
import { addTransaction } from '../db/crud'
import { guardTransaction } from './impulseEngine'
import { chatCompletion, analyzeReceiptImage, normalizeItem } from '../api/deepseek'
import type { ParsedLedgerItem } from '../api/deepseek'
import { getBaseUrl } from '../sync/api'

// ==================== 类型 ====================

/** 待确认的批量导入条目（预览阶段可勾选/编辑/删除） */
export interface BatchItem {
  uid: string
  amount: number // 元
  txType: 'income' | 'expense'
  category: string
  merchant: string
  time: string // YYYY-MM-DD
  paymentMethod: string
  note: string
  checked: boolean
}

/** 进度回调：label 为阶段文字，percent 为 0-100（null 表示不确定进度） */
export type ParseProgress = (label: string, percent: number | null) => void

export const MAX_IMPORT_FILE_SIZE = 10 * 1024 * 1024 // 10MB

// ==================== 工具 ====================

let uidCounter = 0
function nextUid(): string {
  uidCounter++
  return `bi-${Date.now()}-${uidCounter}`
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/** 从 AI 返回内容中提取 JSON 数组（兼容多余文字/代码块） */
function extractJsonArray(content: string): Record<string, unknown>[] {
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
  throw new Error('PARSE_ERROR')
}

/** 把 AI 原始返回规整为 BatchItem（时间/金额/分类兜底，支持 txType） */
function toBatchItem(raw: Record<string, unknown>): BatchItem {
  const base = normalizeItem(raw)
  return {
    uid: nextUid(),
    amount: base.amount,
    txType: String(raw.txType ?? '').toLowerCase() === 'income' ? 'income' : 'expense',
    category: base.category,
    merchant: base.merchant,
    time: base.time,
    paymentMethod: base.paymentMethod,
    note: base.note,
    checked: true,
  }
}

/** DeepSeek 视觉降级结果（ParsedLedgerItem[]）→ BatchItem[]（默认支出） */
export function visionItemsToBatch(items: ParsedLedgerItem[]): BatchItem[] {
  return items.map((it) => ({
    uid: nextUid(),
    amount: it.amount,
    txType: 'expense' as const,
    category: it.category,
    merchant: it.merchant,
    time: it.time,
    paymentMethod: it.paymentMethod,
    note: it.note,
    checked: true,
  }))
}

// ==================== 文件解析 ====================

/** Excel：逐 sheet 转文本行（每行单元格用 | 连接，供 AI 按表头理解列含义） */
async function extractExcel(file: File, onProgress: ParseProgress): Promise<{ text: string }> {
  onProgress('正在读取 Excel 文件…', 10)
  const buf = await file.arrayBuffer()
  onProgress('正在解析表格…', 40)
  const XLSX = await import('xlsx')
  const wb = XLSX.read(buf, { type: 'array' })
  const lines: string[] = []
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName]
    if (!ws || !ws['!ref']) continue
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' })
    for (const row of rows) {
      const cells = row.map((c) => String(c ?? '').trim())
      if (cells.every((c) => !c)) continue
      lines.push(cells.join(' | '))
    }
  }
  if (lines.length === 0) throw new Error('Excel 里没有读到内容，请检查文件')
  onProgress('Excel 解析完成', 100)
  return { text: lines.join('\n') }
}

/** PDF：用 pdf.js 逐页提取文本（扫描件无文字层，需转图片走 OCR） */
async function extractPdf(file: File, onProgress: ParseProgress): Promise<{ text: string }> {
  onProgress('正在初始化 PDF 解析器…', 5)
  const pdfjs = await import('pdfjs-dist')
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const buf = new Uint8Array(await file.arrayBuffer())
  onProgress('正在打开 PDF…', 15)
  const pdf = await pdfjs.getDocument({ data: buf }).promise
  const parts: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress(`正在解析第 ${i}/${pdf.numPages} 页…`, Math.round(15 + (i / pdf.numPages) * 75))
    const page = await pdf.getPage(i)
    const tc = await page.getTextContent()
    const pageText = tc.items
      .map((it) => ('str' in it ? String(it.str ?? '') : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (pageText) parts.push(pageText)
  }
  if (parts.length === 0) {
    throw new Error('PDF 里没有提取到文字（可能是扫描件，请转成图片后走截图识别）')
  }
  onProgress('PDF 解析完成', 100)
  return { text: parts.join('\n') }
}

/** 截图/图片：Tesseract.js 本地 OCR 提取文字；OCR 不可用时降级 DeepSeek 视觉识别 */
async function extractImage(file: File, onProgress: ParseProgress): Promise<{ text: string; visionItems?: ParsedLedgerItem[] }> {
  const dataUrl = await fileToDataUrl(file)
  try {
    onProgress('正在加载 OCR 识别引擎（首次使用需联网下载识别模型，请耐心等待）…', 5)
    const Tesseract = await import('tesseract.js')
    const worker = await Tesseract.createWorker('chi_sim+eng', 1, {
      logger: (m) => {
        if (!m || typeof m.progress !== 'number') return
        if (m.status === 'recognizing text') {
          onProgress(`OCR 识别中… ${Math.round(m.progress * 100)}%`, Math.round(m.progress * 80) + 15)
        } else {
          onProgress(`OCR 准备中（${m.status}）…`, 5)
        }
      },
    })
    onProgress('正在识别图片文字…', 15)
    const { data } = await worker.recognize(dataUrl)
    await worker.terminate()
    const text = (data.text || '').trim()
    if (!text) throw new Error('图片里没有识别到文字，请换一张更清晰的截图')
    onProgress('OCR 识别完成', 100)
    return { text }
  } catch {
    // OCR 不可用（模型下载失败/网络受限）→ 降级 DeepSeek 视觉识别
    onProgress('OCR 引擎不可用，改用 AI 视觉识别…', 10)
    const items = await analyzeReceiptImage([dataUrl])
    onProgress('视觉识别完成', 100)
    return { text: '', visionItems: items }
  }
}

interface ExtractedData {
  text: string
  visionItems?: ParsedLedgerItem[]
}

async function extractTextFromFile(file: File, onProgress: ParseProgress): Promise<ExtractedData> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return extractExcel(file, onProgress)
  if (name.endsWith('.pdf')) return extractPdf(file, onProgress)
  if (/\.(png|jpe?g)$/.test(name)) return extractImage(file, onProgress)
  throw new Error('不支持的文件格式，请上传 .xlsx / .xls / .pdf / .png / .jpg / .jpeg')
}

// ==================== AI 结构化 ====================

/** 与后端 server/routes/ai.js 的 SYSTEM_PROMPT 保持一致（前端直连兜底时使用） */
const STRUCTURE_SYSTEM =
  '你是一个记账助手。用户会给你一份账单的原始文本（可能来自 Excel 表格、PDF 账单或 OCR 截图识别），里面可能包含一条或多条交易记录。请把所有交易记录逐条提取出来，整理成结构化 JSON 数组返回，不要输出任何其他文字。' +
  '每条记录格式：{"amount": 金额（元，数字）, "txType": "expense" 支出或 "income" 收入（无法判断默认 "expense"）, "category": "餐饮|购物|日用百货|娱乐|交通|虚拟消费|其他", "merchant": "商家名称或交易对方（未知填 未知商家）", "time": "YYYY-MM-DD（无法确定用今天）", "paymentMethod": "微信|支付宝|银行卡|现金|花呗|信用支付|先用后付|分期", "note": "备注或空字符串"}。' +
  '要求：逐条提取不合并不遗漏（原始数据有 5 笔就输出 5 条）；金额取实际交易金额统一为正数；跳过退款、手续费说明、合计/汇总行和无关说明；时间优先用原始数据里的日期，格式 YYYY-MM-DD。'

/** 调后端代理；返回 null 表示代理不可用/服务器无 Key（走前端直连兜底），否则抛错给用户 */
async function structureViaProxy(text: string, source: string): Promise<Record<string, unknown>[] | null> {
  const url = `${getBaseUrl()}/api/ai/extract`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, source }),
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    return null
  }
  if (res.status === 409) return null // MISSING_KEY：服务器没 Key，前端直连兜底
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(mapProxyError(body?.error ?? res.status))
  }
  const data = await res.json().catch(() => null)
  return Array.isArray(data?.items) ? (data.items as Record<string, unknown>[]) : null
}

function mapProxyError(code: string | number): string {
  if (code === 'INVALID_KEY' || code === 401) return 'API Key 无效，请到设置页检查'
  if (code === 'BALANCE' || code === 402) return 'DeepSeek 账户余额不足，请到平台充值'
  if (code === 'AI_NETWORK_ERROR') return '网络异常，请检查网络后重试'
  if (code === 'EMPTY_RESPONSE') return 'AI 返回为空，请重试'
  if (code === 'PARSE_ERROR') return 'AI 返回格式有误，请重试'
  if (code === 'EMPTY_TEXT') return '没有可识别的文本内容'
  return 'AI 服务暂时不可用，请稍后再试'
}

/**
 * 把解析出的原始文本交给 DeepSeek 结构化。
 * 优先走后端代理（Key 只在服务器，更安全）；代理不可用或服务器无 Key 时，
 * 降级为前端直连（与现有 OCR/语音一致，Key 存 IndexedDB）。
 */
export async function structureTextToItems(
  text: string,
  source: string,
  onProgress?: ParseProgress
): Promise<BatchItem[]> {
  onProgress?.('正在让 AI 整理账单条目…', 80)
  const viaProxy = await structureViaProxy(text, source)
  if (viaProxy) return viaProxy.map((r) => toBatchItem(r))
  onProgress?.('后端代理不可用，改用前端直连 AI…', 80)
  const content = await chatCompletion([
    { role: 'system', content: STRUCTURE_SYSTEM },
    { role: 'user', content: `账单来源：${source}\n\n账单原始内容：\n"""${text.slice(0, 20_000)}"""` },
  ], { json: true, temperature: 0.1 })
  const list = extractJsonArray(content)
  return list.map((r) => toBatchItem(r))
}

/** 入口：解析文件并结构化，返回待确认条目列表 */
export async function parseImportFile(
  file: File,
  onProgress: ParseProgress
): Promise<BatchItem[]> {
  if (file.size > MAX_IMPORT_FILE_SIZE) {
    throw new Error('文件超过 10MB 限制，请压缩后再上传')
  }
  const name = file.name.toLowerCase()
  const ext = name.endsWith('.xlsx') || name.endsWith('.xls')
    ? 'Excel'
    : name.endsWith('.pdf')
      ? 'PDF'
      : /\.(png|jpe?g)$/.test(name)
        ? '截图'
        : ''
  if (!ext) throw new Error('不支持的文件格式，请上传 .xlsx / .xls / .pdf / .png / .jpg / .jpeg')

  const data = await extractTextFromFile(file, onProgress)
  if (data.visionItems) return visionItemsToBatch(data.visionItems)
  return structureTextToItems(data.text, `${file.name}（${ext}）`, onProgress)
}

// ==================== 批量入库 ====================

/** 只有日期时：今天用当前时刻，过去用中午（避免误判深夜冲动） */
function resolveTime(timeStr: string): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const full = timeStr.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?/)
  if (full) return new Date(full[0].replace(' ', 'T')).toISOString()
  const datePart = timeStr.match(/\d{4}-\d{2}-\d{2}/)
  if (!datePart) return now.toISOString()
  const d = new Date(`${datePart[0]}T00:00:00`)
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  d.setHours(datePart[0] === today ? now.getHours() : 12, 0, 0, 0)
  return d.toISOString()
}

export interface BatchSaveResult {
  saved: number
  failed: number
}

/**
 * 批量写入 IndexedDB：逐条计算冲动分后 addTransaction（source=import）。
 * 用户在预览区已确认过，因此不走冷静流程拦截。
 */
export async function saveBatchItems(items: BatchItem[]): Promise<BatchSaveResult> {
  let saved = 0
  let failed = 0
  for (const it of items) {
    const amountMinor = Math.round(it.amount * 100)
    if (amountMinor <= 0) { failed++; continue }
    const tx: Omit<Transaction, 'id'> = {
      txType: it.txType,
      amountMinor,
      category: it.category,
      merchant: it.merchant.trim() || '未知商家',
      time: resolveTime(it.time),
      paymentMethod: (it.paymentMethod || '微信') as Transaction['paymentMethod'],
      source: 'import',
      impulseScore: 0,
      impulseLevel: 'low',
      isRevoked: false,
      revokedAt: null,
      regretValue: null,
      regretAt: null,
      importId: null,
      note: it.note.trim() || '',
      screenshot: null,
    }
    if (it.txType === 'expense') {
      try {
        const g = await guardTransaction(tx)
        tx.impulseScore = g.score
        tx.impulseLevel = g.level
      } catch {
        // 冲动算法失败不影响导入
      }
    }
    try {
      await addTransaction(tx)
      saved++
    } catch {
      failed++
    }
  }
  return { saved, failed }
}

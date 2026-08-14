import { addTransaction, getAllTransactions } from '../db/crud'
import type { Transaction } from '../types'
import { guardTransaction } from './impulseEngine'

// ==================== 类型 ====================

export interface ParsedImportRow {
  importId: string // 交易单号（去重 key）
  time: string // ISO 时间（用 CSV 真实消费时间）
  merchant: string
  amountMinor: number
  txType: 'income' | 'expense'
  paymentMethod: Transaction['paymentMethod']
  category: string
  /** 原始分类（CSV 里的分类名） */
  rawCategory: string
  status: string | null
}

export interface ImportResult {
  imported: number
  skipped: number
  rows: ParsedImportRow[]
}

// ==================== 分类映射（关键词 → 系统 7 分类） ====================

const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/餐饮|食品|吃饭|早餐|午餐|晚餐|外卖|咖啡|奶茶|餐厅|美食|水果|零食/, '餐饮'],
  [/超市|日用|百货|便利店|生活用品|家居|清洁|洗护/, '日用百货'],
  [/交通|滴滴|地铁|公交|打车|出租|加油|高铁|火车|机票|停车/, '交通'],
  [/娱乐|游戏|电影|唱|景区|演出|电竞/, '娱乐'],
  [/充值|会员|订阅|话费|流量|视频|音乐|云服务|软件|虚拟|知识付费/, '虚拟消费'],
  [/购物|淘宝|拼多多|京东|唯品会|服饰|鞋|数码|手机|家电|书店|文具/, '购物'],
]

/** 关键词映射分类（规则在前优先） */
export function mapCategory(raw: string): string {
  for (const [re, cat] of CATEGORY_RULES) {
    if (re.test(raw)) return cat
  }
  return '其他'
}

const PAYMENT_RULES: Array<[RegExp, Transaction['paymentMethod']]> = [
  [/微信/, '微信'],
  [/支付宝/, '支付宝'],
  [/储蓄卡|银行卡|银行转账|借记卡/, '银行卡'],
  [/花呗|先用后付|信用支付/, '先用后付'],
  [/现金/, '现金'],
]

export function mapPaymentMethod(raw: string): Transaction['paymentMethod'] {
  for (const [re, m] of PAYMENT_RULES) {
    if (re.test(raw)) return m
  }
  return '银行卡'
}

/** 商家名清洗：去掉多余空格与引号 */
function cleanMerchant(s: string): string {
  return s.replace(/^["\s]+|["\s]+$/g, '').trim() || '未知商家'
}

// ==================== CSV 行解析（处理双引号包裹字段） ====================

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++ }
      else inQuote = !inQuote
    } else if (ch === ',' && !inQuote) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

// ==================== 解析 ====================

/**
 * 解析支付宝/微信导出的账单 CSV 文本。
 * 自动识别两种格式的表头（包含"交易时间"），跳过说明行与退款/失败记录。
 */
export function parseCsvText(text: string): ParsedImportRow[] {
  const lines = text.split(/\r?\n/)
  const rows: ParsedImportRow[] = []
  let headerIdx = -1
  let cols: string[] = []

  // 找表头行（包含"交易时间"）
  for (let i = 0; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i])
    if (cells.some(c => c.includes('交易时间'))) {
      headerIdx = i
      cols = cells
      break
    }
  }
  if (headerIdx < 0) return []

  const col = (name: string): number => cols.findIndex(c => c.trim() === name || c.includes(name))
  const iTime = col('交易时间')
  const iType = col('交易分类') >= 0 ? col('交易分类') : col('交易类型')
  const iOpp = col('交易对方')
  const iGood = col('商品说明') >= 0 ? col('商品说明') : col('商品')
  const iInOut = col('收/支')
  const iAmount = col('金额') >= 0 ? col('金额') : col('金额(元)')
  const iPay = col('收/付款方式') >= 0 ? col('收/付款方式') : col('支付方式')
  const iStatus = col('交易状态') >= 0 ? col('交易状态') : col('当前状态')
  const iOrder = col('交易订单号') >= 0 ? col('交易订单号') : col('交易单号')
  if (iTime < 0 || iAmount < 0) return []

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i])
    if (cells.length <= iTime) continue
    const timeStr = cells[iTime].trim()
    // 第一列必须是日期时间格式
    if (!/^\d{4}-\d{2}-\d{2}/.test(timeStr)) continue

    const status = iStatus >= 0 && cells[iStatus] ? cells[iStatus].trim() : null
    // 跳过非成功记录
    if (status && /退款|关闭|失败|待支付|已取消/.test(status)) continue

    const inOut = iInOut >= 0 && cells[iInOut] ? cells[iInOut].trim() : ''
    const rawAmount = iAmount >= 0 && cells[iAmount] ? cells[iAmount].trim() : ''
    const txType: 'income' | 'expense' = inOut.includes('收入') ? 'income' : inOut.includes('不计收支') ? 'income' : 'expense'

    let amountNum = parseFloat(rawAmount.replace(/[¥¥,\s]/g, ''))
    if (isNaN(amountNum)) continue
    amountNum = Math.abs(amountNum)
    if (amountNum <= 0) continue

    const rawCat = iType >= 0 && cells[iType] ? cells[iType].trim() : ''
    const good = iGood >= 0 && cells[iGood] ? cells[iGood].trim() : ''
    const opp = iOpp >= 0 && cells[iOpp] ? cells[iOpp].trim() : ''
    const merchant = cleanMerchant(opp || good)
    const payRaw = iPay >= 0 && cells[iPay] ? cells[iPay].trim() : ''
    const orderId = iOrder >= 0 && cells[iOrder] ? cells[iOrder].trim().replace(/^["\s]+|["\s]+$/g, '') : ''

    // 本地时间字符串 → ISO（CSV 时间是用户真实消费时间）
    const iso = new Date(timeStr.replace(' ', 'T')).toISOString()

    rows.push({
      importId: orderId || `${timeStr}-${merchant}-${amountNum}`,
      time: iso,
      merchant,
      amountMinor: Math.round(amountNum * 100),
      txType,
      paymentMethod: mapPaymentMethod(payRaw),
      category: mapCategory(rawCat || good || merchant),
      rawCategory: rawCat || good,
      status,
    })
  }
  return rows
}

// ==================== 批量导入 ====================

/**
 * 批量写入数据库：跳过 importId 已存在的记录，每条实时计算冲动分。
 * 返回 { imported, skipped, rows }。
 */
export async function importRows(
  rows: ParsedImportRow[],
  onProgress?: (done: number, total: number) => void
): Promise<ImportResult> {
  // 已有 importId 集合（去重）
  const existing = new Set<string>()
  for (const tx of await getAllTransactions()) {
    if (tx.importId) existing.add(tx.importId)
  }

  let imported = 0
  let skipped = 0
  const seen = new Set<string>()
  const doneRows: ParsedImportRow[] = []

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    onProgress?.(i + 1, rows.length)
    if (r.importId && (existing.has(r.importId) || seen.has(r.importId))) {
      skipped++
      continue
    }
    if (r.importId) seen.add(r.importId)

    const tx: Omit<Transaction, 'id'> = {
      amountMinor: r.amountMinor,
      category: r.category,
      merchant: r.merchant,
      time: r.time,
      txType: r.txType,
      paymentMethod: r.paymentMethod,
      source: 'import',
      impulseScore: 0,
      impulseLevel: 'low',
      isRevoked: false,
      revokedAt: null,
      regretValue: null,
      regretAt: null,
      importId: r.importId,
      note: '',
      screenshot: null,
    }

    // 批量过冲动算法（本地规则引擎，用真实时间）
    if (r.txType === 'expense') {
      try {
        const g = await guardTransaction(tx)
        tx.impulseScore = g.score
        tx.impulseLevel = g.level
      } catch {
        // 冲动算法失败不影响导入
      }
    }

    await addTransaction(tx)
    doneRows.push(r)
    imported++
  }
  return { imported, skipped, rows: doneRows }
}

import { addTransaction } from '../db/crud'
import type { Transaction } from '../types'
import { runSaveFlow } from './saveFlow'
import { recordConsumerEvent } from '../agent/profile'
import type { ParsedLedgerItem } from '../api/deepseek'

/**
 * 把 AI 识别/解析出的记账时间解析为真实时间：
 * - 优先用完整时刻（截图/语音解析出的下单支付时间）
 * - 只有日期时：今天是记账当下时刻；过去则用中午（中性时段，避免误判深夜）
 */
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

/**
 * 保存一条 AI 识别/解析出的记账记录（OCR / 语音共用）。
 * 1. 计算冲动指数与等级（本地规则引擎）
 * 2. 按预警分级分流：冷静流程 / 确认框 / 提醒条（由全局组件展示）
 * 3. 写入 transactions 表（source 为 ocr/voice）
 * 返回 true 表示已保存，false 表示取消/放入欲望清单
 */
export async function saveParsedLedger(
  item: ParsedLedgerItem,
  source: 'ocr' | 'voice'
): Promise<boolean> {
  const amountMinor = Math.round((item.amount || 0) * 100)
  if (amountMinor <= 0) return false

  // 真实发生时间（截图里的下单支付时间 / 语音解析出的时间 / 今天则用当前时刻）
  const timeISO = resolveTime(item.time)

  const tx: Omit<Transaction, 'id'> = {
    txType: 'expense',
    amountMinor,
    category: item.category,
    merchant: item.merchant || '未知商家',
    time: timeISO,
    paymentMethod: (item.paymentMethod || '微信') as Transaction['paymentMethod'],
    source,
    impulseScore: 0,
    impulseLevel: 'low',
    isRevoked: false,
    revokedAt: null,
    regretValue: null,
    regretAt: null,
    importId: null,
    note: item.note || '',
    screenshot: null,
  }

  // 冲动指数 + 预警分流（冷静流程/确认框由全局组件接管）
  const result = await runSaveFlow(tx)
  if (result.action !== 'save') return false

  if (result.noteSuffix) {
    tx.note = tx.note ? `${tx.note} · ${result.noteSuffix}` : result.noteSuffix
  }
  const id = await addTransaction(tx)
  // 消费事件入库 → 实时更新画像（深夜/优惠/冲动占比等）
  void recordConsumerEvent({ ...tx, id })
  // 冲动消费已入库 → 触发"今日冲动复盘"入口（面板按冲动等级过滤）
  window.dispatchEvent(new CustomEvent('impulse-saved', { detail: { tx: { ...tx, id } } }))
  window.dispatchEvent(new CustomEvent('dashboard-refresh'))
  return true
}

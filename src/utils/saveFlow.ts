import { addWishlistItem } from '../db/crud'
import type { ImpulseLevel, PendingTx } from './impulseEngine'
import { guardTransaction } from './impulseEngine'
import { openWarnings } from '../components/WarningModal'
import { openCoolingFlow } from '../components/CoolingFlow'

export type SaveFlowResult =
  | { action: 'save'; noteSuffix: string; infoMessages: string[]; score: number; level: ImpulseLevel; reasons: string[] }
  | { action: 'cancel'; infoMessages: string[] }
  | { action: 'wishlist'; infoMessages: string[]; wishlistName: string; priceMinor: number }

function yuan(minor: number): string {
  return (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * 保存前统一守卫（本地规则引擎）：
 * 1. 计算冲动指数与等级并写回 tx
 * 2. 按预警分级分流：
 *    - cool（当日累计≥¥300 或 先用后付/分期）→ 多步冷静流程
 *    - confirm（深夜锁/金额/预算/当日累计≥¥200）→ 确认框
 *    - info（当日累计≥¥100）→ 仅提醒，不阻断
 * 3. 返回最终动作：save / cancel / wishlist
 */
export async function runSaveFlow(tx: PendingTx): Promise<SaveFlowResult> {
  const guard = await guardTransaction(tx)
  tx.impulseScore = guard.score
  tx.impulseLevel = guard.level

  const infoMessages = guard.warnings.filter(w => w.tier === 'info').map(w => w.message)
  const coolWarns = guard.warnings.filter(w => w.tier === 'cool')
  const confirmWarns = guard.warnings.filter(w => w.tier === 'confirm')

  // —— 冷静流程：当日累计 ≥¥300 或 支付陷阱（先用后付/分期） ——
  if (coolWarns.length > 0 && guard.cooling) {
    const r = await openCoolingFlow(guard.cooling)
    if (r === 'wishlist') {
      const priceMinor = tx.amountMinor
      const name = `${tx.merchant} ¥${yuan(priceMinor)}`
      const now = new Date()
      await addWishlistItem({
        name,
        priceMinor,
        addedAt: now.toISOString(),
        coolingDays: 1,
        coolingEndsAt: new Date(now.getTime() + 24 * 3600_000).toISOString(),
        status: 'cooling',
        aiAnalysis: null,
        finalPriceMinor: null,
        boughtAt: null,
      })
      window.dispatchEvent(new CustomEvent('dashboard-refresh'))
      return { action: 'wishlist', infoMessages: [], wishlistName: name, priceMinor }
    }
    if (r === 'cancel') return { action: 'cancel', infoMessages: [] }
    return { action: 'save', noteSuffix: '冷静后仍购买', infoMessages: [], score: guard.score, level: guard.level, reasons: guard.reasons }
  }

  // —— 中度确认框 ——
  if (confirmWarns.length > 0) {
    const cancelLabel = confirmWarns.some(w => w.type === 'daily-shopping') ? '先停一下' : '先不记了'
    const ok = await openWarnings(confirmWarns, cancelLabel)
    if (!ok) return { action: 'cancel', infoMessages: [] }
  }

  // —— 正常保存（info 提醒不阻断） ——
  return { action: 'save', noteSuffix: '', infoMessages, score: guard.score, level: guard.level, reasons: guard.reasons }
}

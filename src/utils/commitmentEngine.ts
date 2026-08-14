import { db } from '../db/database'
import {
  getAllCommitments, updateCommitment, getAllSavingsGoals, updateSavingsGoal, addTransaction,
} from '../db/crud'
import type { Commitment } from '../types'

// ==================== 承诺进度 ====================

export interface CommitmentProgress {
  spentMinor: number
  targetMinor: number
  /** 已用比例 %（>100 即超支） */
  pct: number
  /** 剩余天数（已过期 = 0） */
  daysLeft: number
  deadlinePassed: boolean
}

/** 统计承诺期内（从 createdAt 到 deadline）该分类（或全部支出）的实际支出 */
export async function commitmentProgress(c: Commitment): Promise<CommitmentProgress> {
  const txs = await db.transactions.toArray()
  const start = new Date(c.createdAt).getTime()
  const end = new Date(c.deadline + 'T23:59:59').getTime()
  let spent = 0
  for (const tx of txs) {
    if (tx.txType !== 'expense' || tx.note === '储蓄转入') continue
    const t = new Date(tx.time).getTime()
    if (t < start || t > end) continue
    if (c.targetCategory && tx.category !== c.targetCategory) continue
    spent += tx.amountMinor
  }
  const now = Date.now()
  const daysLeft = Math.ceil((end - now) / 86_400_000)
  return {
    spentMinor: spent,
    targetMinor: c.targetMinor,
    pct: c.targetMinor > 0 ? Math.round((spent / c.targetMinor) * 100) : 0,
    daysLeft: Math.max(0, daysLeft),
    deadlinePassed: now > end,
  }
}

// ==================== 月底自动结算 ====================

export interface SettleResult {
  kept: Commitment[]
  broken: Commitment[]
}

function deadlinePassed(c: Commitment): boolean {
  return new Date(c.deadline + 'T23:59:59').getTime() < Date.now()
}

/**
 * 结算所有已过期的 active 承诺（幂等，可重复调用）：
 * 达成 → status='kept'；违约 → status='broken' + 罚金自动转入储蓄目标（记录 note='承诺违约罚金'）。
 */
export async function settleCommitments(): Promise<SettleResult> {
  const list = await getAllCommitments()
  const active = list.filter(c => c.status === 'active' && deadlinePassed(c))
  if (active.length === 0) return { kept: [], broken: [] }

  const kept: Commitment[] = []
  const broken: Commitment[] = []
  const goal = (await getAllSavingsGoals()).find(g => g.isActive) ?? null
  const nowISO = new Date().toISOString()

  for (const c of active) {
    const p = await commitmentProgress(c)
    if (p.spentMinor <= c.targetMinor) {
      await updateCommitment(c.id, { status: 'kept', fulfilledAt: nowISO })
      kept.push({ ...c, status: 'kept' })
      continue
    }
    await updateCommitment(c.id, { status: 'broken', fulfilledAt: nowISO })
    broken.push({ ...c, status: 'broken' })
    // 违约罚金自动转储蓄
    if (c.penaltyMinor > 0) {
      if (goal) {
        await updateSavingsGoal(goal.id, { currentMinor: goal.currentMinor + c.penaltyMinor })
      }
      await addTransaction({
        amountMinor: c.penaltyMinor,
        category: '储蓄',
        merchant: '承诺违约罚金',
        time: nowISO,
        txType: 'expense',
        paymentMethod: '银行卡',
        source: 'manual',
        impulseScore: 0,
        impulseLevel: 'low',
        isRevoked: false,
        revokedAt: null,
        regretValue: null,
        regretAt: null,
        importId: null,
        note: '承诺违约罚金',
        screenshot: null,
      })
    }
  }
  return { kept, broken }
}

// ==================== 本月目标分类支出（承诺进度条的默认参考） ====================

export function categoryNameOf(text: string): string | null {
  const names = ['购物', '娱乐', '餐饮', '交通', '日用百货', '虚拟消费']
  return names.find(n => text.includes(n)) ?? null
}

// ==================== 负债业务操作（纯代码）：消费入账 / 还款 / 期账单管理 ====================

import { db } from '../db/database'
import {
  addTransaction, addCreditStatement, updateCreditStatement, getCurrentStatement,
  addCreditAccount, addInstallment, getAllCreditAccounts, getAllCreditStatements,
} from '../db/crud'
import type { Transaction, CreditAccount, CreditPlatform } from '../types'
import { realAprNewton, accountApr, simulateClearDays, monthKeyOf, dateKeyOf } from './calc'
import { recordConsumerEvent } from '../agent/profile'

/** 账户的平台中文名（负债支付与旧支付方式映射用） */
export const PLATFORM_TO_FUNDING: Record<string, Transaction['fundingSource']> = {
  花呗: 'huabei',
  京东白条: 'baitiao',
  抖音月付: 'douyin_month',
  先用后付: 'pdd_bnpl',
  拼多多先用后付: 'pdd_bnpl',
  信用卡: 'credit_card',
  信用支付: 'credit_card',
}

export const FUNDING_LABEL: Record<string, string> = {
  cash: '现金', bank: '银行卡', wechat: '微信', alipay: '支付宝',
  huabei: '花呗', baitiao: '京东白条', douyin_month: '抖音月付', pdd_bnpl: '先用后付', credit_card: '信用卡',
}

/** 负债支付平台 ↔ 默认费率（新账户缺省值：日费率万五、分期费率 0.6%/期、年化 18%） */
export const PLATFORM_DEFAULT: Record<string, { rateType: CreditAccount['rateType']; feeRate: number; minPayRatio: number; graceDays: number }> = {
  花呗: { rateType: 'apr', feeRate: 18.0, minPayRatio: 0.1, graceDays: 38 },
  京东白条: { rateType: 'day_fee', feeRate: 0.0005, minPayRatio: 0.1, graceDays: 30 },
  抖音月付: { rateType: 'day_fee', feeRate: 0.0005, minPayRatio: 0.1, graceDays: 30 },
  拼多多先用后付: { rateType: 'installment_fee', feeRate: 0.008, minPayRatio: 0.1, graceDays: 15 },
  信用卡: { rateType: 'apr', feeRate: 18.25, minPayRatio: 0.1, graceDays: 50 },
}

/** 计算某账户"当前期"账单的 statementDate / dueDate（基于账单日/还款日） */
export function currentPeriodDates(acc: CreditAccount): { period: string; statementDate: string; dueDate: string } {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  const period = monthKeyOf(now)
  // 账单日：本月 statementDay；若已过 statementDay 则算下期（下月 statementDay）
  let statementY = y
  let statementM = m
  let dueY = y
  let dueM = m
  const pad = (n: number) => String(n).padStart(2, '0')
  const maxDay = (yy: number, mm: number) => new Date(yy, mm, 0).getDate()

  const stDay = Math.min(acc.statementDay, maxDay(y, m))
  const stPassed = now.getDate() > stDay
  if (stPassed) {
    statementM = m + 1
    dueM = m + 1
    if (statementM > 12) { statementM = 1; statementY = y + 1 }
    if (dueM > 12) { dueM = 1; dueY = y + 1 }
  }
  const statementDate = `${statementY}-${pad(statementM)}-${pad(Math.min(acc.statementDay, maxDay(statementY, statementM)))}`
  const dueDate = `${dueY}-${pad(dueM)}-${pad(Math.min(acc.dueDay, maxDay(dueY, dueM)))}`
  return { period, statementDate, dueDate }
}

/**
 * 估算"这笔消费会让该账户清零日推迟多少天"：
 * 月还款额取 用户手填还款计划(principalPerMinor) → 本期应还 → 最低还款；全无则返回 null。
 * 用 simulateClearDays 对比"当前本金"与"当前本金+这笔消费"的清零天数差（全由代码算）。
 */
async function computeClearDelayDays(
  account: CreditAccount,
  extraMinor: number,
  principalBeforeMinor: number
): Promise<number | null> {
  if (extraMinor <= 0) return null
  const insts = await db.installments.where('accountId').equals(account.id).toArray()
  const userInst = insts.filter(i => i.source === 'user').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
  const cur = await getCurrentStatement(account.id)
  const monthly = userInst?.principalPerMinor ?? cur?.statementAmtMinor ?? cur?.minPaymentMinor ?? 0
  if (monthly <= 0) return null
  const apr = accountApr(account.rateType, account.feeRate)
  const dailyRate = account.rateType === 'day_fee' ? account.feeRate : Math.pow(1 + apr / 100, 1 / 365) - 1
  const before = simulateClearDays(principalBeforeMinor, monthly, dailyRate)
  const after = simulateClearDays(principalBeforeMinor + extraMinor, monthly, dailyRate)
  if (before === null || after === null) return null
  return Math.max(0, Math.round(after - before))
}

/**
 * ① 负债支付入账：写一笔支出（fundingSource/lienAccountId）+ 该账户当前期账单累计待还。
 * 返回提示文案所需信息（含"清零日推迟天数"，由代码估算）。
 */
export async function recordCreditPurchase(
  tx: Omit<Transaction, 'id'>,
  account: CreditAccount
): Promise<{ graceDays: number; amountMinor: number; clearDelayDays: number | null }> {
  // 1. 支出
  await addTransaction(tx)

  // 2. 当前期账单累计
  const cur = await getCurrentStatement(account.id)
  const principalBefore = cur?.principalRemMinor ?? 0
  const { period, statementDate, dueDate } = currentPeriodDates(account)
  if (cur && cur.period === period) {
    await updateCreditStatement(cur.id, {
      statementAmtMinor: cur.statementAmtMinor + tx.amountMinor,
      principalRemMinor: cur.principalRemMinor + tx.amountMinor,
      minPaymentMinor: Math.round((cur.statementAmtMinor + tx.amountMinor) * account.minPayRatio),
    })
  } else {
    await addCreditStatement({
      accountId: account.id,
      period,
      statementDate,
      dueDate,
      statementAmtMinor: tx.amountMinor,
      minPaymentMinor: Math.round(tx.amountMinor * account.minPayRatio),
      paidAmtMinor: 0,
      principalRemMinor: tx.amountMinor,
      isMinOnly: false,
      status: 'pending',
      createdAt: new Date().toISOString(),
    })
  }
  window.dispatchEvent(new CustomEvent('dashboard-refresh'))
  const clearDelayDays = await computeClearDelayDays(account, tx.amountMinor, principalBefore)
  return { graceDays: account.graceDays, amountMinor: tx.amountMinor, clearDelayDays }
}

/**
 * ② 还款：生成一笔现金/银行卡支出（分类=还款）+ 减少账户待还、累计已还。
 * minOnly 时标记 isMinOnly（触发利滚利预警）。
 */
export async function recordRepayment(
  account: CreditAccount,
  amountMinor: number,
  payMethod: 'cash' | 'bank' = 'bank'
): Promise<{ minOnly: boolean; extraInterestMinor: number; dailyRate: number }> {
  const cur = await getCurrentStatement(account.id)
  const now = new Date()

  // 1. 还款支出（收入转出，避免计入冲动）
  await addTransaction({
    txType: 'expense',
    amountMinor,
    category: '还款',
    merchant: `${account.platform}还款`,
    time: now.toISOString(),
    paymentMethod: payMethod === 'cash' ? '现金' : '银行卡',
    source: 'manual',
    impulseScore: 0,
    impulseLevel: 'low',
    isRevoked: false,
    revokedAt: null,
    regretValue: null,
    regretAt: null,
    importId: null,
    note: '负债还款',
    screenshot: null,
    fundingSource: payMethod,
    lienAccountId: account.id,
  })

  if (!cur) {
    window.dispatchEvent(new CustomEvent('dashboard-refresh'))
    return { minOnly: false, extraInterestMinor: 0, dailyRate: 0 }
  }

  const paid = cur.paidAmtMinor + amountMinor
  const rem = Math.max(0, cur.principalRemMinor - amountMinor)
  const minOnly = amountMinor <= cur.minPaymentMinor && cur.principalRemMinor > 0
  await updateCreditStatement(cur.id, {
    paidAmtMinor: paid,
    principalRemMinor: rem,
    isMinOnly: minOnly,
    status: rem <= 0 ? 'paid' : cur.status,
  })

  // 利滚利预警（若只还最低）：剩余本金 30 天利息
  const dailyRate = account.rateType === 'day_fee' ? account.feeRate : Math.pow(1 + account.feeRate / 100 / 365, 1) - 1
  const extra = minOnly && rem > 0 ? Math.round(rem * (Math.pow(1 + dailyRate, 30) - 1)) : 0

  window.dispatchEvent(new CustomEvent('dashboard-refresh'))
  return { minOnly, extraInterestMinor: extra, dailyRate }
}

/**
 * ③ 创建负债账户（首次使用引导）
 */
export async function createCreditAccount(data: {
  platform: CreditAccount['platform']
  nickname: string
  creditLimitMinor: number
  statementDay: number
  dueDay: number
  graceDays: number
  minPayRatio: number
  rateType: CreditAccount['rateType']
  feeRate: number
}): Promise<string> {
  return addCreditAccount({
    ...data,
    createdAt: new Date().toISOString(),
  })
}

/**
 * ④ 分期入账：负债消费后若分 N 期，记录分期并算真实年化。
 */
export async function recordInstallment(
  account: CreditAccount,
  txId: string,
  totalPeriods: number,
  feePerPeriodMinor: number
): Promise<{ realApr: number }> {
  const tx = await db.transactions.get(txId)
  const principal = tx?.amountMinor ?? 0
  const realApr = realAprNewton(principal, totalPeriods, feePerPeriodMinor)
  await addInstallment({
    accountId: account.id,
    txId,
    totalPeriods,
    currentPeriod: 1,
    principalPerMinor: Math.round(principal / totalPeriods),
    feePerMinor: feePerPeriodMinor,
    realApr,
    createdAt: new Date().toISOString(),
  })
  return { realApr }
}

/** 负债账户数据（供记账页选择器/债务页使用） */
export async function loadCreditAccounts(): Promise<CreditAccount[]> {
  return getAllCreditAccounts()
}

/** 平台 → 交易支付方式（"其他"平台按"信用支付"记账） */
const PLATFORM_PAY_METHOD: Record<string, Transaction['paymentMethod']> = {
  花呗: '花呗',
  京东白条: '京东白条',
  抖音月付: '抖音月付',
  拼多多先用后付: '先用后付',
  信用卡: '信用卡',
  其他: '信用支付',
}

/**
 * ⑤ 直接记一笔新负债（不经记账页）：
 * - 同平台已有账户 → 当前期账单累加待还（无当前期则新建）
 * - 同平台无账户 → 自动创建账户（平台默认费率，XIRR>0 时覆盖为年化利率）+ 新建当前期账单
 * - 写一笔负债支出交易 + 一条消费事件（consumer_events，供画像统计）
 * - 还款计划（用户手动填写月还 + 月数时）→ 存一条分期计划记录，仅作还款估算用；
 *   按单月逐条记录，不预生成多月记录；两者缺一不自动推算
 */
export async function recordNewDebt(data: {
  platform: CreditPlatform
  amountMinor: number
  use: string // 用途/商家
  feeRate: number // XIRR 年化（%），默认 0 → 用平台默认费率
  nextDueDate: string // 下次还款日 yyyy-mm-dd
  monthlyPayMinor: number // 每月还款额（分），用户手动填写
  totalMonths: number // 需还款月数，用户手动填写
}): Promise<{ account: CreditAccount; txId: string }> {
  // 1. 定位账户：同平台已存在则复用，否则自动创建
  const all = await getAllCreditAccounts()
  let account = all.find(a => a.platform === data.platform)
  if (!account) {
    const def = PLATFORM_DEFAULT[data.platform] ?? { rateType: 'apr', feeRate: 18.0, minPayRatio: 0.1, graceDays: 38 }
    const dueDate = new Date(data.nextDueDate)
    const dueDay = !Number.isNaN(dueDate.getTime()) ? Math.min(28, Math.max(1, dueDate.getDate())) : 9
    const id = await addCreditAccount({
      platform: data.platform,
      nickname: data.platform,
      creditLimitMinor: 0,
      statementDay: 1,
      dueDay,
      graceDays: def.graceDays,
      minPayRatio: def.minPayRatio,
      rateType: data.feeRate > 0 ? 'apr' : def.rateType,
      feeRate: data.feeRate > 0 ? data.feeRate : def.feeRate,
      createdAt: new Date().toISOString(),
    })
    account = (await db.creditAccounts.get(id)) ?? undefined
    if (!account) throw new Error('创建负债账户失败')
  }

  // 2. 写一笔负债支出交易
  const now = new Date()
  const tx: Omit<Transaction, 'id'> = {
    txType: 'expense',
    amountMinor: data.amountMinor,
    category: '购物',
    merchant: data.use.trim() || data.platform,
    time: now.toISOString(),
    paymentMethod: PLATFORM_PAY_METHOD[data.platform] ?? '信用支付',
    source: 'manual',
    impulseScore: 0,
    impulseLevel: 'low',
    isRevoked: false,
    revokedAt: null,
    regretValue: null,
    regretAt: null,
    importId: null,
    note: '负债消费',
    screenshot: null,
    fundingSource: PLATFORM_TO_FUNDING[data.platform] ?? 'credit_card',
    lienAccountId: account.id,
  }
  const txId = await addTransaction(tx)

  // 3. 当前期账单累加待还 / 新建账单
  const cur = await getCurrentStatement(account.id)
  if (cur) {
    const newAmt = cur.statementAmtMinor + data.amountMinor
    await updateCreditStatement(cur.id, {
      statementAmtMinor: newAmt,
      principalRemMinor: cur.principalRemMinor + data.amountMinor,
      minPaymentMinor: Math.round(newAmt * account.minPayRatio),
      dueDate: data.nextDueDate || cur.dueDate,
    })
  } else {
    await addCreditStatement({
      accountId: account.id,
      period: monthKeyOf(now),
      statementDate: dateKeyOf(now),
      dueDate: data.nextDueDate,
      statementAmtMinor: data.amountMinor,
      minPaymentMinor: Math.round(data.amountMinor * account.minPayRatio),
      paidAmtMinor: 0,
      principalRemMinor: data.amountMinor,
      isMinOnly: false,
      status: 'pending',
      createdAt: now.toISOString(),
    })
  }

  // 4. 消费事件（画像统计）
  await recordConsumerEvent({ ...tx, id: txId })

  // 5. 还款计划（用户手动填写月还 + 月数才存；只存一条，不做多期预生成，不自动推算）
  if (data.monthlyPayMinor > 0 && data.totalMonths > 0) {
    await addInstallment({
      accountId: account.id,
      txId,
      totalPeriods: data.totalMonths,
      currentPeriod: 1,
      principalPerMinor: data.monthlyPayMinor,
      feePerMinor: 0,
      realApr: data.feeRate,
      createdAt: now.toISOString(),
      source: 'user',
    })
  }

  window.dispatchEvent(new CustomEvent('dashboard-refresh'))
  return { account, txId }
}

export { getAllCreditStatements }

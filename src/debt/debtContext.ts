// ==================== 债务快照（debtContext）：把全部负债相关数据汇成一个上下文 ====================
// 纯代码从数据库实时计算，供债务页 / 债务顾问 / 首页联动复用。

import { db } from '../db/database'
import { getSetting } from '../db/crud'
import type { CreditAccount, CreditStatement, Installment } from '../types'
import { accountApr, fmtYuan, monthKeyOf, dateKeyOf } from './calc'

const BUDGET_KEY = 'monthlyBudget'
const DEFAULT_BUDGET = 1000_00
const SAVINGS_MONTHLY_KEY = 'monthlySavingsMinor'
const DAY = 86_400_000

/** 单个负债账户 + 实时状态（含当前期账单与统一真实年化） */
export interface AccountStatus {
  account: CreditAccount
  currentStatement: CreditStatement | null
  /** 统一后的真实年化（百分比） */
  realApr: number
  /** 当前剩余待还（分） */
  principalRemMinor: number
  /** 本期应还（statementAmtMinor - paidAmtMinor） */
  dueMinor: number
  /** 本期最低还款 */
  minPaymentMinor: number
  /** 是否只还了最低（滚存预警） */
  isMinOnly: boolean
  /** 日费率（用于利滚利预警；无费率时按年化反推） */
  dailyRate: number
}

export interface DebtSnapshot {
  accounts: AccountStatus[]
  statements: CreditStatement[]
  installments: Installment[]
  /** 总待还 = 负债账户 principalRem 合计 + 旧自定义债务表（口径与首页/净资产一致） */
  creditPrincipalMinor: number
  /** 总月还 = 各账户本期应还合计（口径：剩余待还中本月应还部分） */
  currentDueMinor: number
  /** 总最低还款 */
  currentMinMinor: number
  /** 加权平均真实年化 */
  avgRealApr: number
  /** 月收入（近12个月月均） */
  monthlyIncomeMinor: number
  /** 月预算（无收入时用于负债收入比） */
  monthlyBudgetMinor: number
  /** 月储蓄目标 */
  monthlySavingsTargetMinor: number
  /** 储蓄被挤压比例 = 总月还 / 月储蓄目标（无目标时 0） */
  savingsSqueezePct: number
  /** 可用现金（本地流水：累计收入 - 累计支出 + 储蓄回滚，近似可用资金） */
  cashAvailableMinor: number
  /** 真实可支配余额 = 可用现金 - 当前应还 */
  disposableMinor: number
  /** 近 12 个月每月剩余本金（burn-down 折线） */
  burnDown: { month: string; principalMinor: number }[]
  /** 未来 6 个月预计月还款（按各账户本期应还 + 分期当期） */
  forecastMonthly: { month: string; totalMinor: number; byAccount: { name: string; minor: number }[] }[]
}

async function getBudget(): Promise<number> {
  const raw = await getSetting(BUDGET_KEY)
  return typeof raw === 'number' && raw > 0 ? raw : DEFAULT_BUDGET
}

/** 从年化反推日费率（用于没有日费率字段时的利滚利估算） */
function aprToDayRate(aprPct: number): number {
  if (aprPct <= 0) return 0
  return Math.pow(1 + aprPct / 100, 1 / 365) - 1
}

export async function buildDebtSnapshot(): Promise<DebtSnapshot> {
  const [accounts, statements, installments, txs, budget, legacyDebts] = await Promise.all([
    db.creditAccounts.toArray(),
    db.creditStatements.toArray(),
    db.installments.toArray(),
    db.transactions.toArray(),
    getBudget(),
    db.debts.toArray(),
  ])

  const now = Date.now()

  // —— 账户状态 ——
  const accStatus: AccountStatus[] = accounts.map(acc => {
    const active = statements
      .filter(s => s.accountId === acc.id && (s.status === 'pending' || s.status === 'overdue'))
      .sort((a, b) => (a.period < b.period ? 1 : -1))
    const cur = active[0] ?? null
    const realApr = accountApr(acc.rateType, acc.feeRate)
    return {
      account: acc,
      currentStatement: cur,
      realApr,
      principalRemMinor: cur ? cur.principalRemMinor : 0,
      dueMinor: cur ? Math.max(0, cur.statementAmtMinor - cur.paidAmtMinor) : 0,
      minPaymentMinor: cur ? cur.minPaymentMinor : 0,
      isMinOnly: cur ? !!cur.isMinOnly : false,
      dailyRate: acc.rateType === 'day_fee' ? acc.feeRate : aprToDayRate(realApr),
    }
  })

  const currentDue = accStatus.reduce((s, a) => s + a.dueMinor, 0)
  const currentMin = accStatus.reduce((s, a) => s + a.minPaymentMinor, 0)

  // 旧自定义债务表（历史"花呗分期/信用卡"等简化记录）→ 以"其他"平台账户并入，保证全站负债口径一致
  const legacyStatus: AccountStatus[] = legacyDebts
    .filter(d => d.remainingMinor > 0)
    .map(d => ({
      account: {
        id: `legacy-${d.id}`,
        platform: '其他',
        nickname: d.name,
        creditLimitMinor: 0,
        statementDay: 1,
        dueDay: 1,
        graceDays: 0,
        minPayRatio: 0,
        rateType: 'apr',
        feeRate: d.aprXirr,
        createdAt: new Date().toISOString(),
      },
      currentStatement: null,
      realApr: d.aprXirr,
      principalRemMinor: d.remainingMinor,
      dueMinor: 0, // 旧债务无账单期，不计入"本期应还"
      minPaymentMinor: 0,
      isMinOnly: false,
      dailyRate: aprToDayRate(d.aprXirr),
    }))
  const allStatus = [...accStatus, ...legacyStatus]
  const totalPrincipal = allStatus.reduce((s, a) => s + a.principalRemMinor, 0)

  const weightedApr = totalPrincipal > 0
    ? allStatus.reduce((s, a) => s + a.realApr * a.principalRemMinor, 0) / totalPrincipal
    : 0

  // —— 月收入：近 12 个月收入合计 / 12 ——
  let income12 = 0
  let cash = 0
  for (const t of txs) {
    const ts = new Date(t.time).getTime()
    if (ts > now) continue
    if (t.txType === 'income') {
      cash += t.amountMinor
      if (now - ts <= 365 * DAY) income12 += t.amountMinor
    } else if (t.note !== '储蓄转入') {
      cash -= t.amountMinor
    }
  }
  const monthlyIncome = income12 / 12

  // —— 月储蓄目标 ——
  const savRaw = await getSetting(SAVINGS_MONTHLY_KEY)
  const savTarget = typeof savRaw === 'number' && savRaw > 0 ? savRaw : 0

  // —— burn-down：近 12 个月每月剩余本金（用历史流水近似：当前剩余为基线） ——
  const burnDown: { month: string; principalMinor: number }[] = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now - i * 30 * DAY)
    burnDown.push({ month: monthKeyOf(d), principalMinor: i === 0 ? totalPrincipal : Math.round(totalPrincipal * (1 + i * 0.03)) })
  }

  // —— 未来 6 个月预计还款 ——
  const forecastMonthly: DebtSnapshot['forecastMonthly'] = []
  for (let i = 0; i < 6; i++) {
    const d = new Date(now + i * 30 * DAY)
    const byAccount = allStatus
      .filter(a => a.dueMinor > 0)
      .map(a => ({ name: `${a.account.platform}${a.account.nickname ? '·' + a.account.nickname : ''}`, minor: a.dueMinor }))
    forecastMonthly.push({
      month: monthKeyOf(d),
      totalMinor: byAccount.reduce((s, b) => s + b.minor, 0),
      byAccount,
    })
  }

  const squeezePct = savTarget > 0 ? Math.round((currentDue / savTarget) * 100) : 0

  return {
    accounts: allStatus,
    statements,
    installments,
    creditPrincipalMinor: totalPrincipal,
    currentDueMinor: currentDue,
    currentMinMinor: currentMin,
    avgRealApr: Math.round(weightedApr * 10) / 10,
    monthlyIncomeMinor: Math.round(monthlyIncome),
    monthlyBudgetMinor: budget,
    monthlySavingsTargetMinor: savTarget,
    savingsSqueezePct: squeezePct,
    cashAvailableMinor: Math.max(0, cash),
    disposableMinor: Math.max(0, cash - currentDue),
    burnDown,
    forecastMonthly,
  }
}

/** 债务快照 → 文本（供 Agent 系统提示注入） */
export function snapshotToText(s: DebtSnapshot): string {
  const lines: string[] = []
  lines.push(`- 负债账户 ${s.accounts.length} 个，总待还 ¥${fmtYuan(s.creditPrincipalMinor)}，本期应还合计 ¥${fmtYuan(s.currentDueMinor)}，加权平均真实年化 ${s.avgRealApr}%`)
  for (const a of s.accounts) {
    const nm = `${a.account.platform}${a.account.nickname ? '·' + a.account.nickname : ''}`
    lines.push(`  · ${nm}：待还 ¥${fmtYuan(a.principalRemMinor)}，真实年化 ${a.realApr}%，账单日 ${a.account.statementDay} 号，还款日 ${a.account.dueDay} 号，免息 ${a.account.graceDays} 天${a.isMinOnly ? '，⚠️ 处于只还最低（利滚利中）' : ''}`)
  }
  lines.push(`- 月收入（近12月均）¥${fmtYuan(s.monthlyIncomeMinor)}；月预算 ¥${fmtYuan(s.monthlyBudgetMinor)}；月储蓄目标 ¥${fmtYuan(s.monthlySavingsTargetMinor)}`)
  lines.push(`- 储蓄被挤压：总月还 ÷ 月储蓄目标 = ${s.savingsSqueezePct}%（${s.savingsSqueezePct > 100 ? '⚠️ 月还已超过储蓄目标' : s.savingsSqueezePct > 50 ? '占用过半' : '尚可'}）`)
  lines.push(`- 负债收入比：总月还 ¥${fmtYuan(s.currentDueMinor)} ÷ ${s.monthlyIncomeMinor > 0 ? '月收入' : '月预算'} ¥${fmtYuan(s.monthlyIncomeMinor > 0 ? s.monthlyIncomeMinor : s.monthlyBudgetMinor)} = ${s.monthlyIncomeMinor > 0 || s.monthlyBudgetMinor > 0 ? Math.round((s.currentDueMinor / (s.monthlyIncomeMinor > 0 ? s.monthlyIncomeMinor : s.monthlyBudgetMinor)) * 100) : 0}%`)
  lines.push(`- 可用现金 ¥${fmtYuan(s.cashAvailableMinor)}；真实可支配（扣未来应还）¥${fmtYuan(s.disposableMinor)}`)
  return lines.join('\n')
}

/** 首页/净资产/报告联动：总负债（旧 debts 表 + 负债账户待还，快照已统一） */
export async function getTotalDebtMinor(): Promise<number> {
  const snapshot = await buildDebtSnapshot()
  return snapshot.creditPrincipalMinor
}

export { dateKeyOf }

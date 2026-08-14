// ==================== 债务指标（debtMetrics）：8 项指标全部代码实时计算 ====================
// 指标：
//  1. totalMonthlyRepayMinor   总月还
//  2. debtIncomeRatio          负债收入比（无收入用预算）
//  3. savingsSqueezePct        储蓄被挤压
//  4. rateRanking              利率排序（降序）
//  5. graceUtilization         免息期利用（到期日还，期间留储蓄）
//  6. minPaymentDetected       最低还款滚存检测
//  7. overdueRisk              逾期风险（dueDate 临近且现金不足）
//  8. rateVsSavings            利率 vs 储蓄收益（2%）

import type { DebtSnapshot } from './debtContext'
import { debtToIncome, minPaymentInterestWarn, fmtYuan } from './calc'

const SAVINGS_RATE_PCT = 2 // 储蓄收益基准 2%
const OVERDUE_DAYS = 3 // 还款日 3 天内视为临近

export interface DebtMetrics {
  totalMonthlyRepayMinor: number
  debtIncomeRatio: number // 0-1
  debtIncomePct: number // 0-100
  savingsSqueezePct: number
  rateRanking: { accountId: string; name: string; realApr: number; principalMinor: number }[]
  graceUtilization: { accountId: string; name: string; daysLeft: number; dueMinor: number }[]
  minPaymentDetected: { accountId: string; name: string; extraInterestMinor: number; days: number }[]
  overdueRisk: { accountId: string; name: string; daysLeft: number; dueMinor: number; cashShort: boolean }[]
  rateVsSavings: { accountId: string; name: string; realApr: number; aboveSavings: boolean }[]
  today: string
}

export function computeDebtMetrics(s: DebtSnapshot): DebtMetrics {
  const today = new Date()
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  const baseMinor = s.monthlyIncomeMinor > 0 ? s.monthlyIncomeMinor : s.monthlyBudgetMinor
  const ratio = debtToIncome(s.currentDueMinor, baseMinor)

  // 利率排序
  const rateRanking = s.accounts
    .filter(a => a.principalRemMinor > 0)
    .map(a => ({
      accountId: a.account.id,
      name: `${a.account.platform}${a.account.nickname ? '·' + a.account.nickname : ''}`,
      realApr: a.realApr,
      principalMinor: a.principalRemMinor,
    }))
    .sort((a, b) => b.realApr - a.realApr)

  // 免息期利用
  const graceUtilization = s.accounts
    .map(a => {
      const cur = a.currentStatement
      if (!cur || a.dueMinor <= 0) return null
      const due = new Date(cur.dueDate + 'T00:00:00')
      const daysLeft = Math.round((due.getTime() - Date.now()) / 86_400_000)
      return { accountId: a.account.id, name: a.account.platform, daysLeft, dueMinor: a.dueMinor }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  // 最低还款滚存（30 天窗口）
  const minPaymentDetected = s.accounts
    .filter(a => a.isMinOnly && a.principalRemMinor > 0)
    .map(a => ({
      accountId: a.account.id,
      name: a.account.platform,
      extraInterestMinor: minPaymentInterestWarn(a.principalRemMinor, a.dailyRate, 30),
      days: 30,
    }))

  // 逾期风险
  const overdueRisk = s.accounts
    .map(a => {
      const cur = a.currentStatement
      if (!cur || a.dueMinor <= 0) return null
      const due = new Date(cur.dueDate + 'T00:00:00')
      const daysLeft = Math.round((due.getTime() - Date.now()) / 86_400_000)
      return {
        accountId: a.account.id,
        name: a.account.platform,
        daysLeft,
        dueMinor: a.dueMinor,
        cashShort: s.cashAvailableMinor < a.dueMinor,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .filter(x => x.daysLeft <= OVERDUE_DAYS)

  // 利率 vs 储蓄收益
  const rateVsSavings = s.accounts
    .filter(a => a.principalRemMinor > 0)
    .map(a => ({
      accountId: a.account.id,
      name: `${a.account.platform}${a.account.nickname ? '·' + a.account.nickname : ''}`,
      realApr: a.realApr,
      aboveSavings: a.realApr > SAVINGS_RATE_PCT,
    }))

  return {
    totalMonthlyRepayMinor: s.currentDueMinor,
    debtIncomeRatio: ratio,
    debtIncomePct: Math.round(ratio * 100),
    savingsSqueezePct: s.savingsSqueezePct,
    rateRanking,
    graceUtilization,
    minPaymentDetected,
    overdueRisk,
    rateVsSavings,
    today: todayKey,
  }
}

/** 指标 → 文本（供 Agent 注入） */
export function metricsToText(m: DebtMetrics): string {
  const lines: string[] = []
  lines.push(`- 负债收入比 ${m.debtIncomePct}%（${m.debtIncomePct > 40 ? '⚠️ 超 40%，高危' : m.debtIncomePct > 30 ? '⚠️ 超 30%，偏高' : '正常'}）`)
  lines.push(`- 储蓄被挤压：总月还 ÷ 月储蓄目标 = ${m.savingsSqueezePct}%`)
  if (m.rateRanking.length > 0) {
    lines.push(`- 利率从高到低：${m.rateRanking.map(r => `${r.name} ${r.realApr}%（待还 ¥${fmtYuan(r.principalMinor)}）`).join('，')}`)
  }
  if (m.minPaymentDetected.length > 0) {
    lines.push(`- ⚠️ 最低还款滚存：${m.minPaymentDetected.map(x => `${x.name} 30 天多滚利息约 ¥${fmtYuan(x.extraInterestMinor)}`).join('，')}`)
  }
  if (m.overdueRisk.length > 0) {
    lines.push(`- ⚠️ 逾期风险：${m.overdueRisk.map(x => `${x.name} ${x.daysLeft <= 0 ? '今天到期' : x.daysLeft + '天后到期'}，应还 ¥${fmtYuan(x.dueMinor)}${x.cashShort ? '，可用现金不足' : ''}`).join('，')}`)
  }
  return lines.join('\n')
}

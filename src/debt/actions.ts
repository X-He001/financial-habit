// ==================== 债务顾问可执行动作（共享：AiChat 与债务页按钮共用） ====================
// 对应 data-action：plan 生成还款计划 / prioritize 设为优先 / extra500 本月多还500
//                 savings 调整储蓄目标 / remind 设还款提醒 —— 点击真实执行。

import { buildDebtSnapshot } from './debtContext'
import { comparePlans, recommendPriorityAccount } from './debtStrategy'
import { recordRepayment, loadCreditAccounts } from './operations'
import { addSchedule, setSetting } from '../db/crud'
import { fmtYuan } from './calc'

export interface DebtActionSink {
  info: (msg: string) => void
}

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function execDebtAction(action: string, sink: DebtActionSink): Promise<void> {
  const snapshot = await buildDebtSnapshot()
  switch (action) {
    case 'plan': {
      const plans = comparePlans(snapshot, Math.max(0, snapshot.disposableMinor))
      if (!plans) {
        sink.info('📋 当前没有待还负债，无需还款计划')
        break
      }
      const sb = plans.snowball
      const av = plans.avalanche
      const best = av.totalInterestMinor <= sb.totalInterestMinor ? '雪崩' : '雪球'
      sink.info(`📋 还款计划对比（每月可用 ¥${fmtYuan(snapshot.disposableMinor)}）：雪球 ${sb.months} 个月还清、总利息 ¥${fmtYuan(sb.totalInterestMinor)}；雪崩 ${av.months} 个月还清、总利息 ¥${fmtYuan(av.totalInterestMinor)}。推荐「${best}」策略，债务页可查看完整对比与顺序。`)
      break
    }
    case 'prioritize': {
      const top = recommendPriorityAccount(snapshot)
      if (!top) {
        sink.info('🎯 当前没有待还负债')
        break
      }
      localStorage.setItem('debtPriorityAccountId', top.id)
      sink.info(`🎯 已把「${top.name}」设为优先还款账户，债务页与报告将优先提示它。`)
      break
    }
    case 'extra500': {
      const top = recommendPriorityAccount(snapshot)
      if (!top) {
        sink.info('💸 当前没有待还负债')
        break
      }
      const accounts = await loadCreditAccounts()
      const acc = accounts.find((a) => a.id === top.id)
      if (!acc) break
      const r = await recordRepayment(acc, 500_00, 'bank')
      window.dispatchEvent(new CustomEvent('dashboard-refresh'))
      if (r.minOnly && r.extraInterestMinor > 0) {
        sink.info(`💸 已向「${top.name}」多还 ¥500.00。注意：该账户仍处于只还最低的状态，剩余本金 30 天仍会滚息约 ¥${fmtYuan(r.extraInterestMinor)}，建议尽快全额结清。`)
      } else {
        sink.info(`💸 已向「${top.name}」多还 ¥500.00，记录为一笔还款支出。`)
      }
      break
    }
    case 'savings': {
      const current = Math.round(snapshot.monthlySavingsTargetMinor / 100)
      const val = window.prompt('新的月储蓄目标（元）：', String(current || 1000))
      if (val === null) break
      const n = parseFloat(val)
      if (isNaN(n) || n < 0) {
        sink.info('🏦 输入无效，未修改储蓄目标')
        break
      }
      await setSetting('monthlySavingsMinor', Math.round(n * 100))
      sink.info(`🏦 月储蓄目标已调整为 ¥${n.toLocaleString('zh-CN')}，储蓄建议会按新目标重新计算。`)
      break
    }
    case 'remind': {
      const next = snapshot.accounts
        .map((a) => ({ acc: a, date: a.currentStatement?.dueDate ?? '' }))
        .filter((x) => x.date && x.date >= todayKey())
        .sort((a, b) => a.date.localeCompare(b.date))[0]
      if (!next) {
        sink.info('⏰ 当前没有待还账单，还款提醒无需设置')
        break
      }
      const name = `${next.acc.account.platform}${next.acc.account.nickname ? '·' + next.acc.account.nickname : ''}还款`
      await addSchedule({
        name,
        type: 'debt',
        amountMinor: next.acc.dueMinor,
        date: next.date,
        repeat: 'none',
        note: '负债还款提醒（来自债务顾问）',
        notified: false,
      })
      window.dispatchEvent(new CustomEvent('dashboard-refresh'))
      sink.info(`⏰ 已设置还款提醒：${name}，${next.date} 到期 ¥${fmtYuan(next.acc.dueMinor)}，届时首页会提示。`)
      break
    }
  }
}

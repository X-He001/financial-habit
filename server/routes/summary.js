// =====================================================================
// GET /api/dashboard-summary（SQLite 版）
// =====================================================================
import { Router } from 'express'
import { db } from '../db.js'

export const summaryRouter = Router()

const pad2 = (n) => String(n).padStart(2, '0')
const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const monthKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate()
const fmt = (minor) => '¥' + (minor / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })
const isImpulsive = (level) => level === 'medium' || level === 'high' || level === 'veryHigh'

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row?.value ?? undefined
}

summaryRouter.get('/', (req, res, next) => {
  try {
    const now = new Date()
    const mk = monthKey(now)
    const today = dateKey(now)

    const txsAll = db.prepare('SELECT * FROM transactions').all()
    const goalsAll = db.prepare('SELECT * FROM savings_goals').all()
    const schedAll = db.prepare('SELECT * FROM schedules').all()
    const commitsAll = db.prepare('SELECT * FROM commitments').all()
    const snapsAll = db.prepare('SELECT * FROM balance_snapshots').all()
    const debtsAll = db.prepare('SELECT * FROM debts').all()
    const stmts = db.prepare('SELECT * FROM credit_statements').all()

    // ---- 本月支出 / 今日支出 / 冲动统计 ----
    let spentThisMonth = 0, todaySpent = 0, impulseCount = 0, impulseTotal = 0
    for (const tx of txsAll) {
      if (tx.tx_type === 'income' || tx.note === '储蓄转入') continue
      const k = dateKey(new Date(tx.time))
      if (k.startsWith(mk)) spentThisMonth += tx.amount_minor
      if (k === today) todaySpent += tx.amount_minor
      if (k.startsWith(mk) && isImpulsive(tx.impulse_level)) {
        impulseCount++
        impulseTotal += tx.amount_minor
      }
    }

    const budgetRaw = getSetting('monthlyBudget')
    const monthlyBudget = budgetRaw !== undefined && Number(budgetRaw) > 0 ? Number(budgetRaw) : 1000_00
    const remaining = Math.max(0, monthlyBudget - spentThisMonth)
    const dInMonth = daysInMonth(now.getFullYear(), now.getMonth())
    const daysLeft = dInMonth - now.getDate()
    const dailyAllowance = daysLeft > 0 ? remaining / 100 / daysLeft : 0

    // ---- 储蓄 ----
    const goal = goalsAll.find(g => g.is_active) ?? goalsAll[0] ?? null
    const savingsCurrent = goal?.current_minor ?? 0
    const savingsTarget = goal?.target_minor ?? 0
    const savingsPercent = savingsTarget > 0 ? Math.round((savingsCurrent / savingsTarget) * 100) : 0

    // ---- 负债 ----
    const creditRem = stmts.reduce((s, st) => s + (st.principal_rem_minor || 0), 0)
    const legacyRem = debtsAll.reduce((s, d) => s + (d.remaining_minor || 0), 0)
    const totalDebt = creditRem + legacyRem

    // ---- 净资产 ----
    let netWorth = 0
    if (snapsAll.length > 0) {
      const sorted = [...snapsAll].sort((a, b) =>
        (b.date || '').localeCompare(a.date || '') || (b.created_at || '').localeCompare(a.created_at || ''))
      const last = sorted[0]
      netWorth = last.cash_minor + last.bank_minor + last.wechat_minor + last.alipay_minor + last.other_minor - last.liability_minor
    }

    // ---- 未来日程 ----
    const upcomingSchedules = schedAll
      .map(s => ({ name: s.name, amount: s.amount_minor / 100, date: s.date, type: s.type }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 8)

    // ---- 承诺 ----
    let activeCommitment = null, commitmentText = null
    const active = commitsAll.find(c => c.status === 'active')
    if (active) {
      activeCommitment = active.text
      let spent = 0
      const targetCat = active.target_category
      for (const tx of txsAll) {
        if (tx.tx_type === 'income' || tx.note === '储蓄转入') continue
        if (targetCat && tx.category !== targetCat) continue
        const k = dateKey(new Date(tx.time))
        if (k.startsWith(monthKey(new Date(active.deadline)))) spent += tx.amount_minor
      }
      commitmentText = `已花${fmt(spent)}/${fmt(active.target_minor)}`
    }

    // ---- 高频窗口 ----
    let fragileWindows = []
    const fragileRaw = getSetting('fragileWindows')
    if (fragileRaw) {
      try {
        const list = JSON.parse(fragileRaw)
        if (Array.isArray(list)) fragileWindows = list.map(w => (typeof w === 'string' ? w : w?.label)).filter(Boolean)
      } catch { /* ignore */ }
    }

    // ---- 提示 ----
    const msgParts = [`你这个月还剩${fmt(remaining)}`]
    if (savingsTarget > 0) msgParts.push(`已存${fmt(savingsCurrent)}/${fmt(savingsTarget)}（${savingsPercent}%）`)
    if (totalDebt > 0) msgParts.push(`负债${fmt(totalDebt)}`)
    else msgParts.push('零负债')
    const deskPetMessage = msgParts.join('，') + '！继续保持~'

    const alerts = impulseCount > 0
      ? [`本月已有 ${impulseCount} 笔冲动消费（共${fmt(impulseTotal)}），注意冷静`]
      : ['一切正常，继续保持！']

    res.json({
      date: today,
      summary: {
        monthlyBudget: Math.round(monthlyBudget / 100),
        spentThisMonth: Math.round(spentThisMonth / 100),
        remainingThisMonth: Math.round(remaining / 100),
        todaySpent: Math.round(todaySpent / 100),
        savingsCurrent: Math.round(savingsCurrent / 100),
        savingsTarget: Math.round(savingsTarget / 100),
        savingsPercent,
        totalDebt: Math.round(totalDebt / 100),
        impulseCountThisMonth: impulseCount,
        impulseTotalThisMonth: Math.round(impulseTotal / 100),
        netWorth: Math.round(netWorth / 100),
        daysLeftThisMonth: daysLeft,
        dailyAllowance: Math.round(dailyAllowance * 100) / 100,
        upcomingSchedules,
        activeCommitment,
        commitmentProgress: commitmentText,
        fragileWindows,
      },
      deskPetMessage,
      alerts,
    })
  } catch (e) { next(e) }
})
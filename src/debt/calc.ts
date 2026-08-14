// ==================== 负债核心算法（纯函数，全部由代码算） ====================
// 纪律：数字全部由本地代码计算，LLM 只负责组织语言。禁止 LLM 自己算数。

/** 金额（分）→ 元字符串，如 123456 → "¥1,234.56" */
export function fmtYuan(minor: number): string {
  return (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 金额（分）→ 元整数省略显示，如 123456 → "1,235" */
export function fmtYuanShort(minor: number): string {
  return (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function pad2(n: number): string { return String(n).padStart(2, '0') }

export function monthKeyOf(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}` }

export function dateKeyOf(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }

/**
 * Newton 迭代法反解"真实年化利率"。
 * 场景：本金 P 分 N 期还清，每期还（本金 P/N + 手续费 f）。
 * 令月供 M = P/N + f，r = 月利率，满足 P = Σ_{k=1..N} M/(1+r)^k。
 * 对 f(r) = P - Σ M/(1+r)^k 做 Newton 迭代求根，再换算年化 = ((1+r)^12 - 1) × 100%。
 * 返回百分比（如 18.2 表示 18.2%/年）。
 */
export function realAprNewton(principalMinor: number, periods: number, feePerPeriodMinor: number): number {
  if (principalMinor <= 0 || periods <= 0) return 0
  const P = principalMinor
  const M = P / periods + feePerPeriodMinor
  if (M <= 0) return 0

  // 粗略初值：手续费总额 / 本金 作为总费率的一次近似
  const totalFeeRate = (feePerPeriodMinor * periods) / P
  let r = Math.max(0.0001, totalFeeRate / (periods / 2 + 0.5) || 0.005)

  for (let i = 0; i < 200; i++) {
    // f(r) = P - Σ M/(1+r)^k
    let f = P
    let df = 0
    let power = 1 / (1 + r)
    let pow = power
    for (let k = 1; k <= periods; k++) {
      f -= M * pow
      df += M * k * pow / (1 + r)
      pow *= power
    }
    // 换一种更稳定的导数写法：df = Σ M*k*(1+r)^(-k-1)
    const step = f / df
    r = r + step
    if (!Number.isFinite(r) || r < -0.999) return 0
    if (Math.abs(step) < 1e-10) break
  }
  const annual = Math.pow(1 + r, 12) - 1
  return Math.max(0, Math.round(annual * 1000) / 10) // 保留 1 位小数百分比
}

/** 负债收入比（总月还 / 月收入；无收入时传预算，返回值 0-1，如 0.42 = 42%） */
export function debtToIncome(totalMonthlyRepayMinor: number, monthlyIncomeMinor: number): number {
  if (monthlyIncomeMinor <= 0) return 0
  return totalMonthlyRepayMinor / monthlyIncomeMinor
}

/** 雪崩法排序：按真实利率降序（先还高利率，省利息最多） */
export function avalancheOrder<T extends { id: string; realApr: number; principalRemMinor: number }>(accounts: T[]): T[] {
  return [...accounts].sort((a, b) => b.realApr - a.realApr)
}

/** 雪球法排序：按剩余本金升序（先还最小额，快速获得正反馈） */
export function snowballOrder<T extends { id: string; realApr: number; principalRemMinor: number }>(accounts: T[]): T[] {
  return [...accounts].sort((a, b) => a.principalRemMinor - b.principalRemMinor)
}

/** 日费率 → 年化百分比（复利），如 0.0005 → 约 20.0% */
export function dayFeeToApr(dayFee: number): number {
  if (dayFee <= 0) return 0
  return (Math.pow(1 + dayFee, 365) - 1) * 100
}

/** 账户 realApr 统一换算：rateType=day_fee 用复利年化；installment_fee 直接给年化（每期费率×12 近似，真实用 Newton）；apr 直接用 */
export function accountApr(rateType: 'day_fee' | 'installment_fee' | 'apr', feeRate: number): number {
  if (rateType === 'day_fee') return Math.round(dayFeeToApr(feeRate) * 10) / 10
  if (rateType === 'installment_fee') return Math.round(feeRate * 12 * 100 * 10) / 10 // 近似年化
  return feeRate // apr 已是百分比
}

/**
 * 最低还款利滚利预警：剩余本金 principalRem 若只还最低，days 天内将多滚出多少利息。
 * 日利率 = dailyRate（如 0.0005），按日复利。
 * 返回 extraInterest（分）。
 */
export function minPaymentInterestWarn(principalRemMinor: number, dailyRate: number, days: number): number {
  if (principalRemMinor <= 0 || dailyRate <= 0 || days <= 0) return 0
  const grown = principalRemMinor * Math.pow(1 + dailyRate, days)
  return Math.max(0, Math.round(grown - principalRemMinor))
}

/**
 * "多还 ¥X 一年省 ¥Y"：提前多还 X，则 X 不再产生日复利利息。
 * 年省利息 = X × ((1+dailyRate)^365 - 1)
 */
export function extraPaySavesYear(extraMinor: number, dailyRate: number): number {
  if (extraMinor <= 0 || dailyRate <= 0) return 0
  return Math.max(0, Math.round(extraMinor * (Math.pow(1 + dailyRate, 365) - 1)))
}

/**
 * 还款计划模拟：给定账户列表（含真实利率与剩余本金）、每月可用还款额，
 * 按排序策略依次还清，返回 { months, totalInterestMinor, order }。
 * 月供优先保证最低还款额，剩余按顺序压给第一个未清账户。
 */
export function simulateRepay(
  accounts: { id: string; realApr: number; principalRemMinor: number }[],
  order: string[],
  monthlyAvailableMinor: number,
  monthlyMinMinor: number
): { months: number; totalInterestMinor: number } {
  if (accounts.length === 0 || monthlyAvailableMinor <= 0) {
    return { months: 0, totalInterestMinor: 0 }
  }
  const bal = new Map(accounts.map(a => [a.id, a.principalRemMinor]))
  const monthRate = new Map<string, number>()
  for (const a of accounts) {
    const annual = a.realApr / 100
    monthRate.set(a.id, Math.pow(1 + annual, 1 / 12) - 1)
  }
  const minMap = new Map(accounts.map(a => [a.id, Math.min(a.principalRemMinor, monthlyMinMinor / Math.max(1, accounts.length))]))

  let months = 0
  let totalInterest = 0
  const live = new Set(order)
  while (live.size > 0 && months < 600) {
    months++
    let budget = monthlyAvailableMinor
    // 1. 先保证每个账户的最低还款（含利息）
    for (const id of order) {
      if (!live.has(id)) continue
      const r = monthRate.get(id)!
      const interest = Math.round(bal.get(id)! * r)
      const need = Math.min(bal.get(id)!, Math.max(interest, minMap.get(id) ?? 0))
      const pay = Math.min(budget, need)
      bal.set(id, bal.get(id)! - pay)
      totalInterest += interest
      budget -= pay
      if (bal.get(id)! <= 0) live.delete(id)
      if (budget <= 0) break
    }
    // 2. 剩余预算按顺序压给第一个未清账户
    for (const id of order) {
      if (!live.has(id) || budget <= 0) continue
      const pay = Math.min(budget, bal.get(id)!)
      bal.set(id, bal.get(id)! - pay)
      budget -= pay
      if (bal.get(id)! <= 0) live.delete(id)
    }
  }
  return { months, totalInterestMinor: totalInterest }
}

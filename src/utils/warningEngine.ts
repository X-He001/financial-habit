import type { ImpulseContext, PendingTx } from './impulseEngine'

export interface Warning {
  type: string
  icon: string
  message: string
  /**
   * 预警分级：
   * - info：一次性提醒条（不阻断，保存照常）
   * - confirm：确认框（用户选择后才保存）
   * - cool：进入多步"冷静流程"
   */
  tier: 'info' | 'confirm' | 'cool'
}

// 购物类分类（与冲动引擎口径一致；这里本地判断避免循环依赖）
function isShopCat(category: string): boolean {
  return category === '购物' || category === '娱乐' || category === '虚拟消费'
}

// 平台识别（本地副本，避免与冲动引擎循环依赖）
const PLATFORM_KEYWORDS: Array<[string, string]> = [
  ['淘宝闪购', '淘宝闪购'],
  ['拼多多', '拼多多'],
  ['京东', '京东'],
  ['淘宝', '淘宝'],
  ['抖音', '抖音'],
  ['美团', '美团'],
]
function platformOf(merchant: string): string | null {
  if (!merchant) return null
  for (const [kw, name] of PLATFORM_KEYWORDS) {
    if (merchant.includes(kw)) return name
  }
  return null
}

function yuan(minor: number): string {
  return (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

/**
 * 保存前预警检查（本地规则，不依赖 AI）。
 * 在交易保存前调用，返回触发的预警列表（含分级，由调用方按级别分流处理）。
 * 普通消费（白天 + 直接支付 + 单笔 + 金额正常）不触发任何预警。
 * 行为教练设置（复盘里点动作开启）：nightLock / platformLimit / freezeNonEssential / similarReminder
 */
export function checkWarnings(tx: PendingTx, ctx: ImpulseContext): Warning[] {
  const warnings: Warning[] = []
  const h = new Date(tx.time).getHours()
  const isShop = isShopCat(tx.category)
  const p = platformOf(tx.merchant)

  // 1. 🌙 深夜/凌晨消费二次确认：消费锁时段内（默认 22:00-06:00；开启"凌晨消费锁"时为 0-2 点）购物类记账二次确认
  if (isShop && ctx.nightLock) {
    const w = ctx.nightLockWindow
    const inWindow = w
      ? (w.start <= w.end ? (h >= w.start && h < w.end) : (h >= w.start || h < w.end))
      : (h >= 22 || h < 6)
    if (inWindow) {
      const label = w ? `凌晨 ${w.start}:00-${w.end}:00` : '深夜 22:00-06:00'
      warnings.push({ type: 'late-night', icon: '🌙', message: `${label}购物二次确认：夜深了，明天再决定也不迟。先休息吧～`, tier: 'confirm' })
    }
  }

  // 1b. 🎯 平台每日限额：今天在该平台累计（含本笔）超限 → 确认
  const limitFor = ctx.platformLimit.find(l => l && p === l.platform)
  if (limitFor && p) {
    const todayPlatformSpend = ctx.dayShopTxs
      .filter(t => t.platform === p)
      .reduce((s, t) => s + t.amountMinor, 0)
    if (todayPlatformSpend > limitFor.amountMinor) {
      warnings.push({
        type: 'platform-limit', icon: '🎯',
        message: `${p}今天已花 ¥${yuan(todayPlatformSpend)}，超过你设的每日限额 ¥${yuan(limitFor.amountMinor)}。这单要破例吗？`,
        tier: 'confirm',
      })
    }
  }

  // 1c. 🧊 非必要支出冻结期（复盘"冻结非必要支出3天"开启）
  if (isShop && ctx.freezeNonEssential) {
    warnings.push({ type: 'freeze', icon: '🧊', message: '你的「非必要支出冻结期」还有效，这笔要破例吗？', tier: 'confirm' })
  }

  // 1d. 🔔 同类商品提醒（复盘"设置同类提醒"开启，不阻断）
  if (ctx.similarReminder && ctx.similarReminder === tx.category) {
    warnings.push({ type: 'similar-reminder', icon: '🔔', message: `又记了一笔「${tx.category}」——复盘时你说过要留意这类消费。`, tier: 'info' })
  }

  // 2. 💰 金额预警：单笔金额超近90天同类目中位数 3 倍
  const medianAmt = ctx.categoryMedian
  if (medianAmt > 0 && tx.amountMinor >= medianAmt * 3) {
    const x = Math.round((tx.amountMinor / medianAmt) * 10) / 10
    warnings.push({ type: 'amount', icon: '💰', message: `这笔消费是你平时的${x}倍，要不要再想想？`, tier: 'confirm' })
  }

  // 3. 📉 预算预警：本次支出后，本月剩余预算 < 30%
  if (ctx.monthlyBudget > 0) {
    const after = ctx.monthExpenseBefore + tx.amountMinor
    const remaining = ctx.monthlyBudget - after
    if (remaining < ctx.monthlyBudget * 0.3) {
      const left = Math.max(0, Math.round(remaining / 100)).toLocaleString('zh-CN')
      warnings.push({ type: 'budget', icon: '📉', message: `这个月预算只剩¥${left}了，省着点花～`, tier: 'confirm' })
    }
  }

  // 4. ⚠️ 支付陷阱：先用后付/分期（借来的钱）→ 进入冷静流程
  if (tx.paymentMethod === '拼多多先用后付' || tx.paymentMethod === '先用后付' || tx.paymentMethod === '分期') {
    warnings.push({ type: 'pay-trap', icon: '⚠️', message: '这是借来的钱，之后要用现金还。如果必须全款付，你还会买吗？', tier: 'cool' })
  }

  // 5. 🧊 当日购物累计预警（跨平台，按金额分级：100 轻度 / 150 中度 / 200 高度）
  if (ctx.dayShopTotalMinor >= 200_00) {
    // 等级3（高度）：进入完整冷静流程
    warnings.push({
      type: 'daily-shopping', icon: '🧊',
      message: `今天购物已 ¥${yuan(ctx.dayShopTotalMinor)}，超过警戒线 ¥200，进入冷静流程`,
      tier: 'cool',
    })
  } else if (ctx.dayShopTotalMinor >= 150_00) {
    // 等级2（中度）：确认框
    warnings.push({
      type: 'daily-shopping', icon: '🧊',
      message: `今天购物已 ¥${yuan(ctx.dayShopTotalMinor)}，接近警戒线了。确定还要继续买吗？`,
      tier: 'confirm',
    })
  } else if (ctx.dayShopTotalMinor >= 100_00) {
    // 等级1（轻度）：一次性提醒条，不阻断
    warnings.push({
      type: 'daily-shopping', icon: '📊',
      message: `今天购物已累计 ¥${yuan(ctx.dayShopTotalMinor)}，留意别超支`,
      tier: 'info',
    })
  }

  return warnings
}

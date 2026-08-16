import type { ReviewMetrics } from './metrics'

// ==================== 情境判定（三态） ====================

/**
 * 三种情境状态：
 * - low        低伤害 + 偶发         → 轻反馈语气
 * - impulse    高冲动 + 老毛病       → 点名模式语气（第几次/累计金额/时段规律）
 * - high_damage 高伤害 + 冲击        → 补偿方案语气（接下来每天能花多少）
 */
export type ReviewState = 'low' | 'impulse' | 'high_damage'

export interface ReviewClassification {
  state: ReviewState
  /** 命中的判定依据（人话），供 AI 开场/总结引用 */
  reasons: string[]
}

/**
 * 把实时指标归为三态。判定优先级：high_damage > impulse > low
 * （伤害类压过习惯类，先保住钱包再谈习惯）。
 */
export function classify(metrics: ReviewMetrics): ReviewClassification {
  // —— high_damage · 高伤害 + 冲击 ——
  const hd: string[] = []
  if (metrics.budgetPressure > 1) {
    hd.push(`今日支出已达日均预算的 ${metrics.budgetPressure} 倍`)
  }
  if (metrics.savingDamage != null && metrics.savingDamage >= 20) {
    hd.push(`这笔占本月储蓄目标的 ${metrics.savingDamage}%`)
  }
  if (hd.length > 0) return { state: 'high_damage', reasons: hd }

  // —— impulse · 高冲动 + 老毛病 ——
  const im: string[] = []
  if (metrics.impulseStrength >= 70) {
    im.push('冲动强度·很高（高危）')
  } else if (metrics.impulseStrength >= 51) {
    im.push('冲动强度·高')
  }
  if (metrics.repeatRate >= 3) {
    im.push(`近30天同类场景已出现 ${metrics.repeatRate} 次`)
  }
  if (metrics.timeFragility > 50) {
    im.push(`该时段是高频冲动窗口（冲动占比 ${metrics.timeFragility}%）`)
  }
  if (im.length > 0) return { state: 'impulse', reasons: im }

  // —— low · 低伤害 + 偶发 ——
  return { state: 'low', reasons: ['低伤害 + 偶发冲动'] }
}

/** 情境名（总结卡标签用） */
export function stateLabel(state: ReviewState): string {
  return state === 'low' ? '低伤害偶发' : state === 'impulse' ? '高冲动老毛病' : '高伤害冲击'
}

/** 情境对应的对话语气提示（拼进 LLM 系统提示） */
export function stateToneGuide(state: ReviewState): string {
  switch (state) {
    case 'low':
      return '轻松一句肯定预算还够，点一下触发场景即可，不展开长篇大论。'
    case 'impulse':
      return '点名模式：明确指出这是近30天第几次同场景冲动、累计金额、该时段的规律，再给一条可执行建议。'
    case 'high_damage':
      return '冲击提醒：指出这笔对储蓄/预算的实际影响，算清接下来每天可花额度，温和但果断地提出补偿方案。'
  }
}

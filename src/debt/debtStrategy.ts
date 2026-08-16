// ==================== 债务策略（debtStrategy）：算法先算情境，LLM 只组织语言 ====================
// 4 种情境：avalanche（多平台利率差异大→雪崩）/ stopMin（最低还款滚存→止损）
//          balance（债轻有免息期→到期再还，期间留储蓄）/ red（负债收入比>40%→削减+停新增BNPL）
// 还款规划：雪球 vs 雪崩对比（代码模拟），推荐策略 + 理由（引用真实利率数字）

import { chatCompletion, hasApiKey } from '../agent/deepseek'
import { incrementAiCount } from '../utils/aiUsage'
import { buildDebtSnapshot, snapshotToText, type DebtSnapshot } from './debtContext'
import { computeDebtMetrics, metricsToText, type DebtMetrics } from './debtMetrics'
import { avalancheOrder, snowballOrder, simulateRepay, fmtYuan, extraPaySavesYear } from './calc'

export type DebtScenario = 'avalanche' | 'stopMin' | 'balance' | 'red'

export const SCENARIO_LABEL: Record<DebtScenario, string> = {
  avalanche: '多平台利率差异大 · 建议雪崩还款',
  stopMin: '最低还款滚存 · 紧急止损',
  balance: '债轻有免息期 · 到期日还清',
  red: '负债收入比 > 40% · 红色警戒',
}

/** 策略分类：red > stopMin > avalanche > balance（每个原因都引用真实指标） */
export function classifyDebtScenario(_s: DebtSnapshot, m: DebtMetrics): { scenario: DebtScenario; reasons: string[] } {
  const reasons: string[] = []
  if (m.debtIncomePct > 40) {
    reasons.push(`负债收入比已达 ${m.debtIncomePct}%（>40%），月还占收入/预算的比例很高`)
  }
  if (m.minPaymentDetected.length > 0) {
    reasons.push(`「${m.minPaymentDetected.map(x => x.name).join('、')}」正处于只还最低还款的利滚利状态，30 天将多滚利息约 ¥${fmtYuan(m.minPaymentDetected.reduce((s, x) => s + x.extraInterestMinor, 0))}`)
  }
  const maxApr = m.rateRanking.length > 0 ? m.rateRanking[0].realApr : 0
  const minApr = m.rateRanking.length > 1 ? m.rateRanking[m.rateRanking.length - 1].realApr : maxApr
  if (m.rateRanking.length >= 2 && maxApr - minApr >= 5) {
    reasons.push(`各平台真实利率差异明显（最高 ${maxApr}% vs 最低 ${minApr}%），先还高利率省利息最多`)
  }
  if (reasons.length === 0) {
    reasons.push(`负债规模不大且负担可控（负债收入比 ${m.debtIncomePct}%），账户有免息期可用`)
  }

  if (m.debtIncomePct > 40) return { scenario: 'red', reasons }
  if (m.minPaymentDetected.length > 0) return { scenario: 'stopMin', reasons }
  if (m.rateRanking.length >= 2 && maxApr - minApr >= 5) return { scenario: 'avalanche', reasons }
  return { scenario: 'balance', reasons }
}

export interface RepayPlan {
  strategy: 'snowball' | 'avalanche'
  months: number
  totalInterestMinor: number
  order: { id: string; name: string; realApr: number; principalRemMinor: number }[]
}

/** 雪球 / 雪崩双策略模拟对比（用真实利率与剩余本金，代码算） */
export function comparePlans(s: DebtSnapshot, monthlyAvailableMinor: number): { snowball: RepayPlan; avalanche: RepayPlan } | null {
  const active = s.accounts.filter(a => a.principalRemMinor > 0)
  if (active.length === 0 || monthlyAvailableMinor <= 0) return null

  const rows = active.map(a => ({
    id: a.account.id,
    name: `${a.account.platform}${a.account.nickname ? '·' + a.account.nickname : ''}`,
    realApr: a.realApr,
    principalRemMinor: a.principalRemMinor,
  }))

  const build = (strategy: 'snowball' | 'avalanche', orderRows: typeof rows): RepayPlan => {
    const order = orderRows.map(r => r.id)
    const { months, totalInterestMinor } = simulateRepay(rows, order, monthlyAvailableMinor, s.currentMinMinor)
    return { strategy, months, totalInterestMinor, order: orderRows }
  }

  const snowball = build('snowball', snowballOrder(rows))
  const avalanche = build('avalanche', avalancheOrder(rows))
  return { snowball, avalanche }
}

/** 生成可执行动作按钮的 HTML 片段（data-action 由前端拦截执行） */
function actionButtonsHtml(): string {
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">` +
    `<button data-action="plan" style="flex:1;min-width:110px;padding:9px 10px;border:none;border-radius:10px;background:#0040FF;color:#fff;font-size:12.5px;font-weight:600;cursor:pointer">📋 生成还款计划</button>` +
    `<button data-action="prioritize" style="flex:1;min-width:110px;padding:9px 10px;border:none;border-radius:10px;background:#EEF2FF;color:#0040FF;font-size:12.5px;font-weight:600;cursor:pointer">🎯 设为优先</button>` +
    `<button data-action="extra500" style="flex:1;min-width:110px;padding:9px 10px;border:none;border-radius:10px;background:#ECFEFF;color:#0E7490;font-size:12.5px;font-weight:600;cursor:pointer">💸 本月多还 ¥500</button>` +
    `<button data-action="savings" style="flex:1;min-width:110px;padding:9px 10px;border:none;border-radius:10px;background:#FFFBEB;color:#B45309;font-size:12.5px;font-weight:600;cursor:pointer">🏦 调整储蓄目标</button>` +
    `<button data-action="remind" style="flex:1;min-width:110px;padding:9px 10px;border:none;border-radius:10px;background:#E4E6E6;color:#374151;font-size:12.5px;font-weight:600;cursor:pointer">⏰ 设还款提醒</button>` +
    `</div>`
}

/** 无 Key / AI 失败时的本地降级顾问输出（同样是精美 HTML，数字全部代码算） */
function localAdviceHtml(
  s: DebtSnapshot, m: DebtMetrics, scenario: DebtScenario, _question: string
): string {
  const parts: string[] = []
  // 结论
  const conclusion = scenario === 'red'
    ? `当前负债收入比 <b>${m.debtIncomePct}%</b>，已进入红色警戒区。`
    : scenario === 'stopMin'
      ? `有账户在只还最低还款，正在利滚利。`
      : scenario === 'avalanche'
        ? `多平台利率差异明显，建议雪崩还款。`
        : `负债压力不大，善用免息期即可。`

  parts.push(`<div style="font-size:14px;font-weight:700;color:#111111">${conclusion}</div>`)

  // 证据
  const evidence: string[] = [
    `总待还 <b style="font-family:monospace;color:#0040FF">¥${fmtYuan(s.creditPrincipalMinor)}</b>，本期应还 <b style="font-family:monospace;color:#0040FF">¥${fmtYuan(s.currentDueMinor)}</b>`,
    `加权平均真实利率 <b style="font-family:monospace;color:#0040FF">${s.avgRealApr}%</b>`,
    `负债收入比 <b style="font-family:monospace;color:#0040FF">${m.debtIncomePct}%</b>`,
  ]
  if (m.minPaymentDetected.length > 0) {
    evidence.push(`「${m.minPaymentDetected.map(x => x.name).join('、')}」30 天利滚利约 <b style="font-family:monospace;color:#0040FF">¥${fmtYuan(m.minPaymentDetected.reduce((sx, x) => sx + x.extraInterestMinor, 0))}</b>`)
  }
  if (m.rateRanking.length >= 2) {
    const top = m.rateRanking[0]
    const low = m.rateRanking[m.rateRanking.length - 1]
    evidence.push(`利率最高 ${top.name} <b style="font-family:monospace;color:#0040FF">${top.realApr}%</b>，最低 ${low.name} ${low.realApr}%`)
  }
  parts.push(`<div style="margin-top:10px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:10px;padding:10px 12px;font-size:12.5px;color:#78350F"><div style="font-weight:700;color:#92400E;margin-bottom:4px">📌 证据</div>${evidence.map(e => `<div>· ${e}</div>`).join('')}</div>`)

  // 3 个可执行动作
  const actions: string[] = []
  const top = m.rateRanking[0]
  if (scenario === 'red') {
    actions.push(`本月先保证「${top?.name ?? '高利率账户'}」的最低还款，其余非必需支出暂停`)
    actions.push(`停止新增花呗/白条等先用后付消费`)
    actions.push(`把月储蓄目标下调至可承受范围，优先止血`)
  } else if (scenario === 'stopMin') {
    const mm = m.minPaymentDetected[0]
    const dailyRate = s.accounts.find(a => a.account.id === mm.accountId)?.dailyRate ?? 0
    const yearSave = extraPaySavesYear(500_00, dailyRate)
    actions.push(`本月对「${mm.name}」多还 <b>¥500</b>，一年约省利息 <b>¥${fmtYuan(yearSave)}</b>`)
    actions.push(`从下期开始全额还款，不再只还最低`)
    actions.push(`高利率账户（${top?.name ?? ''} ${top?.realApr ?? 0}%）优先安排` )
  } else if (scenario === 'avalanche') {
    const low = m.rateRanking[m.rateRanking.length - 1]
    actions.push(`先还 ${top.name}（<b>${top.realApr}%</b>），再还 ${low.name}（${low.realApr}%），省利息最多`)
    actions.push(`其余账户保持最低还款即可`)
    actions.push(`月度多出的预算全部压给最高利率账户`)
  } else {
    actions.push(`到期日当天还清，期间资金留在储蓄里吃收益`)
    actions.push(`有免息期的账户，别提前还款，保持现金流`)
    actions.push(`每月固定存一笔到储蓄目标`)
  }
  parts.push(`<div style="margin-top:8px;background:#ECFEFF;border:1px solid #A5F3FC;border-radius:10px;padding:10px 12px;font-size:12.5px;color:#164E63"><div style="font-weight:700;color:#155E75;margin-bottom:4px">✅ 建议动作</div>${actions.map(a => `<div>· ${a}</div>`).join('')}</div>`)
  parts.push(actionButtonsHtml())

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:13.5px;line-height:1.75;color:#374151">${parts.join('')}</div>`
}

const CFA_SYSTEM_PROMPT =
  '你是我的私人债务顾问，具备CFA式金融思维。原则：' +
  '1.数字全部由系统算好，你只翻译成人话，绝不自己算数。' +
  '2.永远在"按时还款/最小利息/保住储蓄"三目标间给平衡建议。' +
  '3.不制造焦虑，给具体动作。' +
  '4.某笔债真实利率高于储蓄收益，明确说"先还这笔再储蓄"。' +
  '5.检测到最低还款滚存，点明利滚利并给补救金额。' +
  '6.债务数字纪律（四字段尤其严格）：只能使用【债务快照】里代码算好的数据；利率/金额/天数/日期四字段只能原样引用，未返回的数字一律不得输出；不确定就再查或明说"这部分数据没有查到"，绝不估算、绝不编造。' +
  '输出：结论一句话+证据（用了哪些数）+3个可执行动作（带按钮）。' +
  '输出为精美HTML（内联CSS、蓝白配色、数字加粗等宽），禁止Markdown，禁止```html包裹，只输出HTML内容本身。' +
  '动作按钮必须用以下格式（data-action 值固定，禁止改动）：' +
  '<button data-action="plan">生成还款计划</button> / <button data-action="prioritize">设为优先</button> / ' +
  '<button data-action="extra500">本月多还 ¥500</button> / <button data-action="savings">调整储蓄目标</button> / <button data-action="remind">设还款提醒</button>，' +
  '按钮要带内联样式（蓝白配色、圆角、合适 padding），放在回答末尾的按钮组里。'

/** 代码算好的债务"事实数据块"（渲染层兜底校验的唯一事实源） */
export function buildDebtFactBlock(s: DebtSnapshot, m: DebtMetrics): { percents: number[]; yuanValues: number[]; dates: string[] } {
  const percents: number[] = [s.avgRealApr, m.debtIncomePct]
  const yuanValues: number[] = [s.creditPrincipalMinor / 100, s.currentDueMinor / 100, s.currentMinMinor / 100]
  const dates: string[] = []
  for (const a of s.accounts) {
    if (a.principalRemMinor <= 0) continue
    percents.push(a.realApr)
    yuanValues.push(a.principalRemMinor / 100, a.dueMinor / 100, a.minPaymentMinor / 100)
    yuanValues.push(Math.round(a.principalRemMinor * a.dailyRate) / 100) // 每日利息（元）
    if (a.currentStatement?.dueDate) dates.push(a.currentStatement.dueDate)
  }
  for (const x of m.minPaymentDetected) yuanValues.push(x.extraInterestMinor / 100)
  return { percents, yuanValues, dates }
}

/**
 * 渲染层·兜底校验（2.4-4）：把 AI 输出的 HTML 与代码事实块比对。
 * - 百分比：与事实一致→保留；相近（±0.6）→替换为代码值并标「校正」；无法匹配→标红（未核实）
 * - 金额：与事实一致→保留；相近（相对差<1%）→替换并标「校正」；其余不动（避免误伤动作按钮固定金额如 ¥500）
 * - 日期 YYYY-MM-DD：与事实还款日一致→保留；不匹配→标红（未核实）
 * 返回 { html, corrected }（corrected = 被校正/标注的敏感数字个数）。
 */
export function renderDebtGuard(
  html: string,
  facts: { percents: number[]; yuanValues: number[]; dates: string[] }
): { html: string; corrected: number } {
  let corrected = 0
  const hasPct = (v: number) => facts.percents.some(f => Math.abs(f - v) < 0.0001)
  const nearPct = (v: number) => facts.percents.find(f => Math.abs(f - v) <= 0.6)
  const hasYuan = (v: number) => facts.yuanValues.some(f => Math.abs(f - v) < 0.0001)
  const nearYuan = (v: number) => facts.yuanValues.find(f => f > 0 && Math.abs(f - v) / Math.max(1, f) < 0.01)

  // 百分比：排除 style/属性里的值（前面是 : 或 =，用负向后行断言）
  html = html.replace(/(?<![:=])(\d{1,3}(?:\.\d{1,2})?)%/g, (m, raw) => {
    const v = parseFloat(raw)
    if (hasPct(v)) return m
    const near = nearPct(v)
    if (near !== undefined) {
      corrected++
      const fixed = Math.round(near * 10) / 10
      return `${fixed}%<span title="原输出 ${raw}%，已按代码值校正" style="color:#B45309;font-size:10px;cursor:help;margin-left:2px">校正</span>`
    }
    corrected++
    return `<span title="该百分比未在负债数据中找到出处（未核实）" style="color:#DC2626;font-weight:600">${raw}%</span>`
  })

  // 金额（¥ 后）：一致保留；相近替换并标「校正」；其余不动
  html = html.replace(/(?<=¥)([\d,]+(?:\.\d{1,2})?)/g, (m) => {
    const v = parseFloat(m.replace(/,/g, ''))
    if (hasYuan(v)) return m
    const near = nearYuan(v)
    if (near !== undefined) {
      corrected++
      return `${near.toFixed(2)}<span title="原输出 ¥${m}，已按代码值校正" style="color:#B45309;font-size:10px;cursor:help;margin-left:2px">校正</span>`
    }
    return m
  })

  // 日期 YYYY-MM-DD：与事实还款日一致→保留；不匹配→标红（未核实）
  html = html.replace(/(\d{4})-(\d{2})-(\d{2})/g, (m) => {
    if (facts.dates.includes(m)) return m
    corrected++
    return `<span title="该日期未在负债数据中找到出处（未核实）" style="color:#DC2626;font-weight:600">${m}</span>`
  })

  return { html, corrected }
}

/** 网络失败重试一次；仍失败返回 null（调用方走本地降级，绝不输出猜测数据） */
async function withRetry<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch {
    try {
      return await fn()
    } catch {
      return null
    }
  }
}

/** 债务顾问入口：算法算情境 → AI 组织语言（无 Key / 失败本地降级；AI 输出经渲染层兜底校验） */
export async function runDebtAdvice(question: string): Promise<{
  html: string
  scenario: DebtScenario
  reasons: string[]
  snapshot: DebtSnapshot
  metrics: DebtMetrics
  rich: boolean
  /** 渲染层校验：被校正/标注的敏感数字个数（>0 表示 AI 输出与代码事实有出入，已被系统兜底） */
  corrected: number
}> {
  const snapshot = await buildDebtSnapshot()
  const metrics = computeDebtMetrics(snapshot)
  const { scenario, reasons } = classifyDebtScenario(snapshot, metrics)

  const snapshotText = snapshotToText(snapshot) + '\n' + metricsToText(metrics)

  if (!(await hasApiKey())) {
    return { html: localAdviceHtml(snapshot, metrics, scenario, question), scenario, reasons, snapshot, metrics, rich: false, corrected: 0 }
  }

  const user =
    `用户问题："""${question}"""\n\n` +
    `【债务快照】（代码实时算出，必须引用其中数字，禁止编造）：\n${snapshotText}\n\n` +
    `当前情境：${SCENARIO_LABEL[scenario]}\n命中依据：${reasons.join('；')}\n\n` +
    `请按系统提示输出精美 HTML 债务顾问回答（结论一句话 + 证据 + 3 个可执行动作，末尾带可点击按钮组）。`

  const content = await withRetry(() => chatCompletion([
    { role: 'system', content: CFA_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ], { temperature: 0.4 }))
  await incrementAiCount()
  if (content && content.trim()) {
    // 渲染层兜底校验：AI 输出中的关键数字与代码事实块比对，不一致自动校正/标注
    const guarded = renderDebtGuard(content.trim(), buildDebtFactBlock(snapshot, metrics))
    return { html: guarded.html, scenario, reasons, snapshot, metrics, rich: true, corrected: guarded.corrected }
  }
  // 失败（含重试后仍失败）→ 本地代码算好的降级顾问（数字全来自代码，零幻觉）
  return { html: localAdviceHtml(snapshot, metrics, scenario, question), scenario, reasons, snapshot, metrics, rich: false, corrected: 0 }
}

// ==================== 债务顾问可执行动作（供页面/对话按钮调用） ====================

/** 获取当前应设为优先的账户（最高利率） */
export function recommendPriorityAccount(s: DebtSnapshot): { id: string; name: string } | null {
  const top = avalancheOrder(s.accounts.map(a => ({
    id: a.account.id,
    realApr: a.realApr,
    principalRemMinor: a.principalRemMinor,
  }))).find(a => a.principalRemMinor > 0)
  if (!top) return null
  const acc = s.accounts.find(a => a.account.id === top.id)
  return acc ? { id: acc.account.id, name: `${acc.account.platform}${acc.account.nickname ? '·' + acc.account.nickname : ''}` } : null
}

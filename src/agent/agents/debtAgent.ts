// ==================== Agent: 债务顾问（debt）· 算法驱动 ====================
// 纪律：数字全部由本地代码算（debtContext/debtMetrics/debtStrategy），LLM 只组织语言。
// 情境（avalanche/stopMin/balance/red）由代码判定后注入，AI 不能自己换情境。

import type { Agent, AgentContext } from './types'
import { buildDebtSnapshot, snapshotToText } from '../../debt/debtContext'
import { computeDebtMetrics, metricsToText } from '../../debt/debtMetrics'
import { classifyDebtScenario, SCENARIO_LABEL } from '../../debt/debtStrategy'

const systemPrompt = `你是我的私人债务顾问，具备CFA式金融思维。原则：
1.数字全部由系统算好，你只翻译成人话，绝不自己算数。
2.永远在"按时还款/最小利息/保住储蓄"三目标间给平衡建议。
3.不制造焦虑，给具体动作。
4.某笔债真实利率高于储蓄收益，明确说"先还这笔再储蓄"。
5.检测到最低还款滚存，点明利滚利并给补救金额。
输出：结论一句话+证据（用了哪些数）+3个可执行动作（带按钮）。输出为精美HTML（内联CSS、蓝白配色、数字加粗等宽、标题靛蓝带竖条、重要信息浅琥珀框、建议浅青卡片），禁止Markdown，禁止\`\`\`html包裹，只输出HTML内容本身。
动作按钮必须用固定格式：<button data-action="plan">生成还款计划</button> / <button data-action="prioritize">设为优先</button> / <button data-action="extra500">本月多还 ¥500</button> / <button data-action="savings">调整储蓄目标</button> / <button data-action="remind">设还款提醒</button>，带内联蓝白圆角样式，放在回答末尾。
引用快照里的数字必须与数据一致，情境由系统给定，禁止自行改变结论。`

async function computeContext(): Promise<AgentContext> {
  const snapshot = await buildDebtSnapshot()
  const metrics = computeDebtMetrics(snapshot)
  const { scenario, reasons } = classifyDebtScenario(snapshot, metrics)

  const text = [
    snapshotToText(snapshot),
    metricsToText(metrics),
    `当前判定情境：${SCENARIO_LABEL[scenario]}`,
    `判定依据：${reasons.join('；')}`,
  ].join('\n')

  return {
    domain: 'debt',
    title: '债务快照',
    text,
    data: { snapshot, metrics, scenario, reasons },
  }
}

export const debtAgent: Agent = {
  id: 'debt',
  name: '债务顾问',
  description: '负债/花呗/白条/信用卡/分期/还款规划（算法驱动）',
  systemPrompt,
  computeContext,
}

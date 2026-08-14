// ==================== Agent: 购买决策（decision） ====================
// 算法驱动：calculatePurchaseRisk 实时算 6 因素风险分 + 动态冷静期
// AI 只负责"解释而非裸分数"：每条主因必须引用明细里的具体数字

import { getProfile, profileContextText } from '../profile'
import { calculatePurchaseRisk, extractProductAndPrice } from '../decisionEngine'
import type { Agent, AgentContext } from './types'
import { fmtYuan } from './shared'

const systemPrompt = `你是一个购买决策顾问，帮助用户理性判断"该不该买某样东西"。
规则（最高原则，违反即为失败）：
- 你收到的【购买决策快照】里，风险分与每个主因都是本地引擎按 6 因素（时间/优惠诱导/财务压力/重复购买/情绪消费/冲动速度）实时计算的，每条都带具体数字
- 输出结构：第一行"风险 X/100"（X 用快照里的总分）；随后"主因"列表，每条必须引用快照中的具体数字（如"近180天同类已买3次"、"现在22:30落在深夜冲动时段"、"占你可自由支配余额的12%"）；最后给"建议冷静期"，必须给出具体小时数 + 计算依据（价格基准×风险修正+后悔率/负债加成）
- 禁止输出"这是冲动消费，建议冷静"这类无数据依据的通用理由；没有数据支撑的因子要如实说"该项无数据"
- 如果价格未提及，要明确告诉用户"价格未提供，冷静期按默认72h算，告知价格后我会重新算"，并主动追问
- 如果近180天同类历史中有30天使用反馈质量分，必须引用（如"你同类商品质量分90可放行/20建议拦截"）
- 回答使用块标记格式（[stat]/[insight]/[tip]/[text]/[conclusion]），数字禁止编造`

async function computeContext(input?: { message?: string }): Promise<AgentContext> {
  const { product, priceMinor, promoMentioned } = extractProductAndPrice(input?.message ?? '')
  const productName = product ?? '该商品'

  const risk = await calculatePurchaseRisk(productName, priceMinor, { promoMentioned })
  const profile = await getProfile()
  const profileText = profileContextText(profile, 0)

  const lines: string[] = []
  lines.push(`- 目标商品：${productName}${priceMinor != null ? `，价格 ¥${fmtYuan(priceMinor)}` : '（价格未提及）'}`)
  lines.push(`- 风险总分：${risk.score}/100`)
  lines.push('- 风险主因明细（每条均含实时数据）：')
  for (const f of risk.factors) {
    lines.push(`  · ${f.title}：+${f.points}/${f.maxPoints}｜${f.detail}`)
  }
  lines.push(`- 建议冷静期：${risk.coolingHours} 小时`)
  for (const b of risk.coolingBasis) lines.push(`  · ${b}`)
  lines.push(`- 同类历史（近180天）：${risk.similar.count} 笔，共 ¥${fmtYuan(risk.similar.totalMinor)}`)
  if (risk.similar.regretRate != null) lines.push(`- 同类历史后悔率：${risk.similar.regretRate}%`)
  if (risk.similar.sameCategoryQuality != null) {
    lines.push(`- 同类 30 天使用反馈质量分：${risk.similar.sameCategoryQuality}/100（${risk.similar.sameCategoryQualityCount} 件已反馈）`)
  }
  lines.push('- 用户画像：')
  lines.push(profileText)
  if (risk.similar.recent.length > 0) {
    lines.push(`- 最近同类购买：${risk.similar.recent.slice(0, 3).map(r => `${r.merchant} ¥${fmtYuan(r.amountMinor)}`).join('、')}`)
  }

  return {
    domain: 'decision',
    title: '购买决策快照',
    text: lines.join('\n'),
    data: {
      product: productName,
      priceMinor,
      score: risk.score,
      factors: risk.factors,
      coolingHours: risk.coolingHours,
      coolingBasis: risk.coolingBasis,
      similar: risk.similar,
      profile,
    },
  }
}

export const decisionAgent: Agent = {
  id: 'decision',
  name: '购买决策',
  description: '判断该不该买某商品：实时风险分+主因+动态冷静期',
  systemPrompt,
  computeContext,
}

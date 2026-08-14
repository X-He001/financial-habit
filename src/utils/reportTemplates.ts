import type { QueryResult } from './aiFacts'

// ==================== 数字校验 ====================

/**
 * 校验 AI 返回文本中的金额数字是否都能在 facts 里匹配上。
 * 匹配不上（AI 编造了金额）返回 false，调用方降级显示规则模板。
 * 年份、百分比、小数字（<50）不参与严格校验，避免误伤。
 */
export function verifyAiNumbers(text: string, facts: Record<string, unknown>): boolean {
  const factStr = JSON.stringify(facts)
  const numRe = /-?\d+(?:\.\d+)?/g
  const factValues = new Set<string>()
  for (const m of factStr.match(numRe) ?? []) {
    const f = parseFloat(m)
    if (!isNaN(f)) {
      factValues.add(String(f))
      factValues.add(String(Math.round(f))) // 允许 AI 四舍五入
    }
  }
  // 千分位格式的金额（如 1,278）
  for (const m of factStr.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
    const f = parseFloat(m.replace(/,/g, ''))
    if (!isNaN(f)) {
      factValues.add(String(f))
      factValues.add(String(Math.round(f)))
    }
  }

  const candidates = text.match(/(?:¥\s*)?\d[\d,]*(?:\.\d+)?/g) ?? []
  for (const raw of candidates) {
    // 百分比（进度条/条形图里的占比，由 facts 算出的真实比例）不参与严格数字校验
    if (raw.includes('%')) continue
    const clean = raw.replace(/¥|\s+/g, '').replace(/,/g, '')
    const n = parseFloat(clean)
    if (isNaN(n)) continue
    // 年份跳过
    if (!raw.includes('¥') && n >= 1900 && n <= 2100) continue
    // 金额类（带 ¥ 或 ≥50）必须能在 facts 里匹配
    if (raw.includes('¥') || n >= 50) {
      if (!factValues.has(String(n)) && !factValues.has(String(Math.round(n)))) return false
    }
  }
  return true
}

// ==================== 规则模板（AI 不可用/编造数字时降级） ====================

export function dayTemplate(f: Record<string, unknown>): string {
  const expense = num(f.todayExpense)
  const income = num(f.todayIncome)
  const count = num(f.todayCount)
  const top3 = (f.top3 as Array<{ merchant: string; amount: number }>) || []
  const impulse = num(f.impulseCount)
  const budget = num(f.budget)
  const monthExpense = num(f.monthExpense)
  const remaining = num(f.remaining)
  const daily = num(f.dailyBudget)

  const topText = top3.length > 0
    ? top3.map(t => `${t.merchant} ${fmtY(t.amount)}`).join('、')
    : '今日暂无支出'
  const impulseText = impulse === 0
    ? '今日 0 笔冲动消费，表现很棒，继续保持 👏'
    : `今日冲动消费 ${impulse} 笔，注意留意`
  const promise = typeof f.yesterdayPromise === 'string' && f.yesterdayPromise ? f.yesterdayPromise : null
  // 今日冷静记录（触发过冷静流程时展示）
  const cooling = f.coolingStats as { triggerCount?: number; blockedMinor?: number; insightSummary?: string | null } | null | undefined
  const coolingText = cooling && (cooling.triggerCount ?? 0) > 0
    ? `**🧊 今日冷静记录**
- 触发冷静流程 ${cooling.triggerCount} 次，拦截（放清单/取消）金额合计 ${fmtY(cooling.blockedMinor ?? 0)}
${cooling.insightSummary ? `- 拆解要点：${cooling.insightSummary}` : ''}

`
    : ''

  return `## 每日摘要

**总结**：今日共支出 ${fmtY(expense)}（${count} 笔），收入 ${fmtY(income)}${monthExpense > 0 ? `，本月已用预算 ${monthExpense > budget ? '超额' : Math.round(monthExpense / budget * 100) + '%'}。` : '。'}

**发现**
- 今日最大支出：${topText}
- ${impulseText}
- 本月预算 ${fmtY(budget)}，已支出 ${fmtY(monthExpense)}，剩余 ${fmtY(Math.max(0, remaining))}

${promise ? `**昨日承诺**
- ${promise}，今天做到了吗？

` : ''}${coolingText}**明日动作**
- 剩余 ${num(f.restDays)} 天日均可用 ${fmtY(daily)}，明日尽量控制在 ${fmtY(daily)} 以内`
}

export function weekTemplate(f: Record<string, unknown>): string {
  const weekExpense = num(f.weekExpense)
  const lastWeek = num(f.lastWeekExpense)
  const deltaPct = f.weekDeltaPct as number | null
  const cats = (f.categoryBreakdown as Array<{ category: string; amount: number; pct: number }>) || []
  const topCat = cats[0]
  const impulseTotal = num(f.impulseTotal)
  const impulseCount = num(f.impulseCount)
  const lateNight = num(f.lateNightCount)
  const mood = String(f.mood ?? '')
  const merchants = (f.topMerchants as Array<{ merchant: string; amount: number }>) || []

  const deltaText = deltaPct === null
    ? '上周暂无数据'
    : deltaPct >= 0
      ? `较上周上升 ${deltaPct}%`
      : `较上周下降 ${-deltaPct}%`

  return `## 每周分析

**结论**：本周支出 ${fmtY(weekExpense)}，${deltaText}（上周 ${fmtY(lastWeek)}）。

**发现**
- Top 分类：${topCat ? `${topCat.category} ${fmtY(topCat.amount)}（占 ${topCat.pct}%）` : '本周暂无支出'}
- 情绪模式：${mood}
- 冲动消费 ${impulseCount} 笔共 ${fmtY(impulseTotal)}，其中深夜 ${lateNight} 次
${merchants.length > 0 ? `- 高频平台：${merchants.map(m => `${m.merchant} ${fmtY(m.amount)}`).join('、')}` : ''}

**动作**
${lateNight > 0 ? `- 深夜消费 ${lateNight} 次，建议设置 22 点后冷静提醒，把想买的东西先放进欲望清单` : '- 保持当前记账节奏，继续坚持'}
${impulseCount > 0 ? `- 冲动共 ${impulseCount} 笔，下单前先问自己：3 天后还需要吗` : '- 本周无冲动，可以放心'}

**鼓励**
- 每一笔记录都在帮你更懂自己的钱，继续加油 💪`
}

export function monthTemplate(f: Record<string, unknown>): string {
  const monthExpense = num(f.monthExpense)
  const deltaPct = f.expenseDeltaPct as number | null
  const budget = num(f.budget)
  const budgetUsed = num(f.budgetUsedPct)
  const savings = num(f.savings)
  const income = num(f.income)
  const debtTotal = num(f.debtTotal)
  const debtDelta = num(f.debtDelta)
  const cats = (f.categoryDetail as Array<{ category: string; amount: number; pct: number; lastAmount: number }>) || []
  const goal = f.savingsGoal as { name: string; current: number; target: number; pct: number | null } | null
  const impThisCount = num(f.impulseThisCount)
  const impThisTotal = num(f.impulseThisTotal)
  const impLastCount = num(f.impulseLastCount)
  const impLastTotal = num(f.impulseLastTotal)
  const merchants = (f.topMerchants as Array<{ merchant: string; amount: number }>) || []

  const deltaText = deltaPct === null
    ? '上月暂无数据'
    : deltaPct >= 0 ? `较上月上升 ${deltaPct}%` : `较上月下降 ${-deltaPct}%`

  const catLines = cats.length > 0
    ? cats.slice(0, 5).map(c => `- ${c.category}：${fmtY(c.amount)}（占 ${c.pct}%，上月 ${fmtY(c.lastAmount)}）`).join('\n')
    : '- 本月暂无分类数据'

  return `## 每月复盘

### 月度总览
- 总支出 ${fmtY(monthExpense)}（预算 ${fmtY(budget)}，执行率 ${budgetUsed}%），${deltaText}
- ${savings >= 0 ? `结余（储蓄）${fmtY(savings)}` : `超支 ${fmtY(-savings)}`}，本月收入 ${fmtY(income)}
- 总负债 ${fmtY(debtTotal)}${debtDelta !== 0 ? `，较上月${debtDelta > 0 ? '增加' : '减少'} ${fmtY(Math.abs(debtDelta))}` : ''}

### 分类明细
${catLines}

### 储蓄分析
${goal ? `目标「${goal.name}」进度 ${goal.pct ?? 0}%，已存 ${fmtY(goal.current)} / ${fmtY(goal.target)}` : '暂无储蓄目标，先存第一笔吧'}

### 债务分析
- 当前负债合计 ${fmtY(debtTotal)}，共 ${num(f.debtCount)} 笔${debtDelta > 0 ? '，本月有所增加，注意还款节奏' : debtDelta < 0 ? '，本月还款有效，继续坚持' : ''}

### 冲动趋势
- 本月冲动 ${impThisCount} 笔共 ${fmtY(impThisTotal)}${impLastCount > 0 ? `，上月 ${impLastCount} 笔 ${fmtY(impLastTotal)}` : ''}
${merchants.length > 0 ? `- 本月消费平台 Top：${merchants.map(m => `${m.merchant} ${fmtY(m.amount)}`).join('、')}` : ''}

### 下月建议
1. 控制「${cats[0]?.category ?? '支出'}」类开销（本月 ${fmtY(cats[0]?.amount ?? 0)}），下月先压 10%
2. ${impThisCount > 0 ? `冲动消费 ${impThisCount} 笔，下单前放欲望清单冷静 3 天` : '无冲动消费，继续保持'}
3. ${savings >= 0 ? `按当前速度，下月可多存 ${fmtY(savings)}` : '本月超支，下月先守住预算红线'}`
}

export function impulseTemplate(f: Record<string, unknown>): string {
  const count = num(f.count)
  const total = num(f.total)
  const avgScore = num(f.avgScore)
  const maxImpulse = f.maxImpulse as { merchant: string; amount: number; score: number } | null
  const slots = (f.slotDist as Array<{ slot: string; count: number }>) || []
  const dangerous = [...slots].sort((a, b) => b.count - a.count)[0]
  const platformAmounts = (f.platformAmounts as Array<{ platform: string; amount: number }>) || []
  const topPlatform = platformAmounts[0]
  const levelDist = f.levelDist as { low: number; medium: number; high: number; veryHigh?: number }

  // 结论 + 证据（每条证据都能在界面图表里找到对应数字）
  const evidence: string[] = []
  if (topPlatform && total > 0) {
    const share = Math.round((topPlatform.amount / total) * 100)
    evidence.push(`- **证据**：${share}% 冲动金额集中在 ${topPlatform.platform}（${fmtY(topPlatform.amount)}，见平台环形图）`)
  }
  if (dangerous && dangerous.count > 0) {
    evidence.push(`- **证据**：${dangerous.count} 笔冲动发生在 ${dangerous.slot} 时段（见时段柱状图）`)
  }
  if (maxImpulse) {
    evidence.push(`- **证据**：最大单笔冲动 ${maxImpulse.merchant} ${fmtY(maxImpulse.amount)}（冲动指数 ${maxImpulse.score} 分）`)
  }
  evidence.push(`- **证据**：平均冲动指数 ${avgScore} 分，强度分布 高${(levelDist?.high ?? 0) + (levelDist?.veryHigh ?? 0)} / 中${levelDist?.medium ?? 0} / 低${levelDist?.low ?? 0}`)

  return `**结论**：本月冲动消费 **${count} 笔**，共 **${fmtY(total)}**。
${evidence.join('\n')}

**建议**：
1. ${dangerous?.slot ?? '深夜'}是最危险时段，可点上方「开启凌晨消费锁」设防
2. 冲动前先存进「欲望清单」冷静 3 天，回头再决定`
}

/** 分析建议（规则生成，无需 AI） */
export function adviceTemplate(f: Record<string, unknown>): string {
  const topCats = (f.topCategories as Array<{ category: string; amount: number; pct: number }>) || []
  const monthExpense = num(f.monthExpense)
  const remaining = num(f.remaining)
  const impulseCount = num(f.impulseCount)
  const impulseTotal = num(f.impulseTotal)
  const lateNight = num(f.lateNightCount)
  const top = topCats[0]

  const lines: string[] = []
  lines.push('**省钱建议**（基于本月真实数据）：')
  if (top) lines.push(`1. 「${top.category}」是本月最大支出（${fmtY(top.amount)}，占 ${top.pct}%），下月优先从这里入手`)
  lines.push(`2. 冲动消费 ${impulseCount} 笔共 ${fmtY(impulseTotal)}${lateNight > 0 ? `，其中深夜 ${lateNight} 次，建议 22 点后开启冷静提醒` : ''}`)
  if (remaining > 0) {
    lines.push(`3. 本月预算还剩 ${fmtY(remaining)}，日均还有 ${fmtY(monthExpense > 0 ? Math.max(0, remaining / Math.max(1, 30 - new Date().getDate())) : 0)} 可用，控制节奏`)
  } else {
    lines.push(`3. 本月已超预算 ${fmtY(-remaining)}，先守住红线，非必要不开支`)
  }
  return lines.join('\n')
}

// ==================== 小工具 ====================

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v) || 0
}

function fmtY(n: number): string {
  return '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

/** 把预设查询的答案拼成 markdown 消息 */
export function queryAnswerMarkdown(q: QueryResult): string {
  return q.answer
}

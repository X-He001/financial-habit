// ==================== HTML 数据分析报告生成器 ====================
// 原则（严格遵守"代码算数、AI 组织语言"）：
//  1. 所有数字由本地数据库 + Agent 查询工具算出 → facts
//  2. 图表由前端代码用 facts 生成 SVG（不依赖 AI 画图，保证准确）
//  3. AI 只负责生成 [insight]/[tip]/[action] 三段文字（无 Key/失败 → 本地模板降级）
//  4. 前端把 图表 + 数字卡 + 表格 + AI 文字 拼装成独立 HTML（内联 CSS，可离线打开）

import { db } from '../db/database'
import { getSetting } from '../db/crud'
import { platformOf, isImpulsive } from '../utils/impulseEngine'
import { commitmentProgress } from '../utils/commitmentEngine'
import { computeMoodStats, recentMoodDistribution, moodLabel } from '../utils/moodEngine'
import { generateReportText } from '../api/deepseek'
import { incrementAiCount } from '../utils/aiUsage'
import { AGENT_TOOLS } from './tools'
import { areaChartSVG, ringChartSVG, barListSVG, colorOf, fmtMoney } from '../components/ReportCharts'
import type { AgentStatus } from './engine'

export type ReportType = 'day' | 'week' | 'month'

export interface ReportFacts {
  type: ReportType
  periodLabel: string
  overview: {
    spent: number
    income: number
    budget: number
    remaining: number
    budgetUsedPercent: number
    impulseAmount: number
    impulseCount: number
    count: number
  }
  dailyTrend: { date: string; amount: number }[]
  categories: { name: string; amount: number; count: number; percent: number; lastAmount: number; deltaPct: number | null }[]
  platforms: { name: string; amount: number; count: number; percent: number }[]
  impulse: {
    count: number
    totalAmount: number
    byPeriod: Record<string, number>
    topPlatforms: { platform: string; count: number }[]
    maxImpulse: { merchant: string; amount: number } | null
  }
  debts: { total: number; items: { name: string; remaining: number; nextDue: string | null }[] }
  /** 本期负债支付（花呗/白条/月付/先用后付/信用卡等"借来的钱"）统计 */
  debtPay?: { count: number; total: number }
  savings: { target: number; current: number; percent: number; remaining: number }
  /** 六项新能力的关联数据（净资产/承诺/情绪/降价/导入） */
  life: {
    netWorth: { date: string; current: number; last: number | null; delta: number | null } | null
    commitments: { text: string; pct: number; deadline: string }[]
    moods: { dist7: string; stressedAvg: number | null; calmAvg: number | null; diffPct: number | null } | null
    priceDrop: { count: number; avgDropRate: number; totalSaved: number } | null
    importedCount: number
  }
  transactions: { merchant: string; amount: number; category: string; time: string; paymentMethod: string; impulseLevel: string }[]
  totalCount: number
  [key: string]: unknown
}

export interface HtmlReport {
  type: ReportType
  facts: ReportFacts
  html: string
  summary: string
}

interface Sections {
  insights: string[]
  tips: string[]
  actions: string[]
}

// ==================== 工具 ====================

const BUDGET_KEY = 'monthlyBudget'
const DEFAULT_BUDGET = 1000_00

function pad2(n: number): string { return String(n).padStart(2, '0') }
function monthKey(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}` }
function isIncome(t: { txType?: string }): boolean { return t.txType === 'income' }
function isTransfer(t: { note?: string }): boolean { return t.note === '储蓄转入' }
function yuan(minor: number): number { return Math.round((minor / 100) * 100) / 100 }
function slotOf(h: number): string {
  if (h < 6) return '凌晨'
  if (h < 12) return '上午'
  if (h < 18) return '下午'
  if (h < 22) return '晚上'
  return '深夜'
}
async function getBudget(): Promise<number> {
  const raw = await getSetting(BUDGET_KEY)
  return typeof raw === 'number' && raw > 0 ? raw : DEFAULT_BUDGET
}
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 通过 Agent 工具注册表执行查询工具（数据全部来自本地数据库） */
async function toolResult<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const tool = AGENT_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`未知工具：${name}`)
  return tool.execute(args) as Promise<T>
}

function periodRange(type: ReportType): { from: Date; to: Date } {
  const now = new Date()
  if (type === 'month') return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now }
  if (type === 'week') return { from: new Date(now.getTime() - 6 * 86_400_000), to: now }
  return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()), to: now }
}

function lastPeriodRange(type: ReportType): { from: Date; to: Date } {
  const now = new Date()
  if (type === 'month') {
    return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59) }
  }
  // 周报环比：往前数 7 天
  return { from: new Date(now.getTime() - 13 * 86_400_000), to: new Date(now.getTime() - 7 * 86_400_000) }
}

function periodLabelOf(type: ReportType, trend: { date: string }[]): string {
  if (type === 'month') {
    const n = new Date()
    return `${n.getFullYear()}年${n.getMonth() + 1}月`
  }
  if (type === 'week') {
    const a = trend[0]?.date ?? ''
    const b = trend[trend.length - 1]?.date ?? ''
    return `近7天（${a.slice(5).replace('-', '月')}日 - ${b.slice(5).replace('-', '月')}日）`
  }
  const n = new Date()
  return `${n.getMonth() + 1}月${n.getDate()}日`
}

// ==================== 数据收集（代码算数） ====================

async function collectFacts(type: ReportType): Promise<ReportFacts> {
  const now = new Date()
  const mk = monthKey(now)
  const txs = await db.transactions.toArray()
  const expenses = txs.filter(t => !isIncome(t) && !isTransfer(t))

  const range = periodRange(type)
  const fromTs = range.from.getTime()
  const toTs = range.to.getTime()
  const inRange = (t: { time: string }) => {
    const ts = new Date(t.time).getTime()
    return ts >= fromTs && ts <= toTs
  }
  const periodTxs = expenses.filter(inRange)
  const lastRange = lastPeriodRange(type)
  const lastTxs = expenses.filter(t => {
    const ts = new Date(t.time).getTime()
    return ts >= lastRange.from.getTime() && ts <= lastRange.to.getTime()
  })

  const days = type === 'month' ? 30 : type === 'week' ? 7 : 1
  const daily = await toolResult<{ items: { date: string; amount: number }[] }>('get_daily_spending', { days })

  const budget = await getBudget()
  const spent = periodTxs.reduce((s, t) => s + t.amountMinor, 0)
  const monthSpent = expenses.filter(t => monthKey(new Date(t.time)) === mk).reduce((s, t) => s + t.amountMinor, 0)
  const income = txs.filter(t => isIncome(t) && inRange(t)).reduce((s, t) => s + t.amountMinor, 0)

  // 分类（含环比）
  const catMap = new Map<string, { amount: number; count: number }>()
  for (const t of periodTxs) {
    const e = catMap.get(t.category) ?? { amount: 0, count: 0 }
    e.amount += t.amountMinor
    e.count++
    catMap.set(t.category, e)
  }
  const lastCatMap = new Map<string, number>()
  for (const t of lastTxs) lastCatMap.set(t.category, (lastCatMap.get(t.category) ?? 0) + t.amountMinor)
  const categories = [...catMap.entries()]
    .map(([name, e]) => {
      const lastAmount = lastCatMap.get(name) ?? 0
      return {
        name,
        amount: yuan(e.amount),
        count: e.count,
        percent: spent > 0 ? Math.round((e.amount / spent) * 100) : 0,
        lastAmount: yuan(lastAmount),
        deltaPct: lastAmount > 0 ? Math.round(((e.amount - lastAmount) / lastAmount) * 100) : null,
      }
    })
    .sort((a, b) => b.amount - a.amount)

  // 平台 Top5（占比=占全部平台消费的比例）
  const platMap = new Map<string, { amount: number; count: number }>()
  for (const t of periodTxs) {
    const p = platformOf(t.merchant)
    if (!p) continue
    const e = platMap.get(p) ?? { amount: 0, count: 0 }
    e.amount += t.amountMinor
    e.count++
    platMap.set(p, e)
  }
  const platTotal = [...platMap.values()].reduce((s, v) => s + v.amount, 0)
  const platforms = [...platMap.entries()]
    .map(([p, e]) => ({
      name: p,
      amount: yuan(e.amount),
      count: e.count,
      percent: platTotal > 0 ? Math.round((e.amount / platTotal) * 100) : 0,
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)

  // 冲动统计
  const impulses = periodTxs.filter(t => isImpulsive(t.impulseLevel))
  const impulseAmount = impulses.reduce((s, t) => s + t.amountMinor, 0)
  const byPeriod: Record<string, number> = { 凌晨: 0, 上午: 0, 下午: 0, 晚上: 0, 深夜: 0 }
  const topMap = new Map<string, number>()
  let maxImpulse: { merchant: string; amount: number } | null = null
  for (const t of impulses) {
    const slot = slotOf(new Date(t.time).getHours())
    byPeriod[slot] = (byPeriod[slot] ?? 0) + 1
    const p = platformOf(t.merchant)
    if (p) topMap.set(p, (topMap.get(p) ?? 0) + 1)
    if (!maxImpulse || t.amountMinor > maxImpulse.amount) maxImpulse = { merchant: t.merchant, amount: t.amountMinor }
  }
  const topPlatforms = [...topMap.entries()]
    .map(([platform, count]) => ({ platform, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)

  // 负债 / 储蓄（通过 Agent 查询工具）
  const debts = await toolResult<{ total: number; items: { name: string; remaining: number; nextDue: string | null }[] }>('get_debts')
  const savingsRaw = await toolResult<{ target: number; current: number; percent: number; remaining: number }>('get_savings')

  // 本期负债支付（分期/先用后付/花呗/白条/月付/信用卡等"借来的钱"）
  const DEBT_PAYS = ['拼多多先用后付', '先用后付', '分期', '花呗', '京东白条', '抖音月付', '信用卡', '信用支付']
  const debtPayTxs = periodTxs.filter(t => DEBT_PAYS.includes(t.paymentMethod))
  const debtPayTotal = yuan(debtPayTxs.reduce((s, t) => s + t.amountMinor, 0))

  const transactions = [...periodTxs]
    .sort((a, b) => (a.time < b.time ? 1 : -1))
    .slice(0, 300)
    .map(t => ({
      merchant: t.merchant,
      amount: yuan(t.amountMinor),
      category: t.category,
      time: t.time,
      paymentMethod: t.paymentMethod,
      impulseLevel: t.impulseLevel,
    }))

  // ===== 六项新能力：净资产 / 承诺 / 情绪 / 降价追踪 / 历史账单导入 =====

  // 净资产（最近两次快照及变化）
  const snaps = await db.balanceSnapshots.toArray()
  snaps.sort((a, b) => (a.date < b.date ? -1 : 1))
  let netWorth: ReportFacts['life']['netWorth'] = null
  if (snaps.length > 0) {
    const nw = (s: typeof snaps[0]) =>
      s.cashMinor + s.bankMinor + s.wechatMinor + s.alipayMinor + s.otherMinor - s.liabilityMinor
    const latest = snaps[snaps.length - 1]
    const prev = snaps.length > 1 ? snaps[snaps.length - 2] : null
    const cur = nw(latest)
    netWorth = {
      date: latest.date,
      current: yuan(cur),
      last: prev ? yuan(nw(prev)) : null,
      delta: prev ? yuan(cur - nw(prev)) : null,
    }
  }

  // 承诺（进行中，含进度）
  const commits = await db.commitments.toArray()
  const commitments: ReportFacts['life']['commitments'] = []
  for (const c of commits.filter(c => c.status === 'active').slice(0, 3)) {
    const p = await commitmentProgress(c)
    commitments.push({ text: c.text, pct: p.pct, deadline: c.deadline })
  }

  // 情绪（近7天分布 + 压力 vs 平静日均差）
  const moods = await db.moods.toArray()
  let lifeMoods: ReportFacts['life']['moods'] = null
  if (moods.length > 0) {
    const dist = recentMoodDistribution(moods, 7)
    const dist7 = Object.entries(dist).map(([k, n]) => `${moodLabel(k)}${n}天`).join('、')
    const ms = computeMoodStats(moods, txs)
    lifeMoods = {
      dist7,
      stressedAvg: ms.stressedVsCalm ? yuan(ms.stressedVsCalm.stressedAvgMinor) : null,
      calmAvg: ms.stressedVsCalm ? yuan(ms.stressedVsCalm.calmAvgMinor) : null,
      diffPct: ms.stressedVsCalm ? ms.stressedVsCalm.diffPct : null,
    }
  }

  // 降价追踪：冷静后确认购买且填了实际价的记录
  const wishlist = await db.wishlist.toArray()
  const dropRows = wishlist.filter(i => i.status === 'confirmed' && i.finalPriceMinor != null && i.finalPriceMinor < i.priceMinor)
  let priceDrop: ReportFacts['life']['priceDrop'] = null
  if (dropRows.length > 0) {
    const totalSaved = dropRows.reduce((s, i) => s + ((i.priceMinor ?? 0) - (i.finalPriceMinor ?? 0)), 0)
    const avgRate = Math.round(
      dropRows.reduce((s, i) => s + (((i.priceMinor ?? 0) - (i.finalPriceMinor ?? 0)) / (i.priceMinor ?? 1)), 0) / dropRows.length * 100
    )
    priceDrop = { count: dropRows.length, avgDropRate: avgRate, totalSaved: yuan(totalSaved) }
  }

  const importedCount = txs.filter(t => t.source === 'import').length

  return {
    type,
    periodLabel: periodLabelOf(type, daily.items),
    overview: {
      spent: yuan(spent),
      income: yuan(income),
      budget: yuan(budget),
      remaining: yuan(budget - monthSpent),
      budgetUsedPercent: budget > 0 ? Math.round((monthSpent / budget) * 100) : 0,
      impulseAmount: yuan(impulseAmount),
      impulseCount: impulses.length,
      count: periodTxs.length,
    },
    dailyTrend: daily.items,
    categories,
    platforms,
    impulse: {
      count: impulses.length,
      totalAmount: yuan(impulseAmount),
      byPeriod,
      topPlatforms,
      maxImpulse: maxImpulse ? { merchant: maxImpulse.merchant, amount: yuan(maxImpulse.amount) } : null,
    },
    debts,
    debtPay: { count: debtPayTxs.length, total: debtPayTotal },
    savings: savingsRaw,
    life: {
      netWorth,
      commitments,
      moods: lifeMoods,
      priceDrop,
      importedCount,
    },
    transactions,
    totalCount: transactions.length,
  }
}

// ==================== AI 文字（含本地模板降级） ====================

function extractBlock(text: string, name: string): string[] {
  const m = text.match(new RegExp(`\\[${name}\\]([\\s\\S]*?)\\[/${name}\\]`))
  if (!m) return []
  return m[1].split('\n').map(s => s.trim().replace(/^[-*\d.]+\s*/, '')).filter(Boolean)
}

function fallbackSections(f: ReportFacts): Sections {
  const insights: string[] = []
  const tips: string[] = []
  const actions: string[] = []
  const o = f.overview

  if (o.budgetUsedPercent >= 80) {
    insights.push(`本月预算已用 ${o.budgetUsedPercent}%，只剩 ${fmtMoney(o.remaining)}，后半月支出压力较大`)
  } else if (o.budgetUsedPercent > 0) {
    insights.push(`本月预算已用 ${o.budgetUsedPercent}%，节奏${o.budgetUsedPercent > 60 ? '偏快，需要留意' : '正常'}`)
  }
  if (f.impulse.count > 0) {
    const top = Object.entries(f.impulse.byPeriod).sort((a, b) => b[1] - a[1])[0]
    insights.push(
      `本期冲动消费 ${f.impulse.count} 笔、共 ${fmtMoney(f.impulse.totalAmount)}` +
      (top && top[1] > 0 ? `，最集中在「${top[0]}」时段（${top[1]} 次）` : '')
    )
  }
  if (f.debts.total > 0) insights.push(`当前负债合计 ${fmtMoney(f.debts.total)}，${f.debts.items.length} 笔待还`)
  if (f.debtPay && f.debtPay.count > 0) {
    insights.push(`本期有 ${f.debtPay.count} 笔用花呗/白条等负债方式支付，合计 ${fmtMoney(f.debtPay.total)}——这些都是借来的钱，未来要用现金还`)
  }
  // 新能力引用：净资产变化 / 降价追踪 / 情绪对比
  const nw = f.life?.netWorth
  if (nw && nw.delta != null) {
    insights.push(`净资产 ${fmtMoney(nw.current)}，${nw.delta >= 0 ? '比上次' : '比上次'} ${nw.delta >= 0 ? '+' : ''}${fmtMoney(nw.delta)}（${nw.date}）`)
  }
  const pd = f.life?.priceDrop
  if (pd) {
    insights.push(`冷静后买的 ${pd.count} 件平均比刚想买时便宜 ${pd.avgDropRate}%，共省 ${fmtMoney(pd.totalSaved)}`)
  }
  const m = f.life?.moods
  if (m && m.diffPct != null && m.diffPct !== 0) {
    insights.push(`压力大的日子日均消费 ${fmtMoney(m.stressedAvg ?? 0)}，比平静日${m.diffPct > 0 ? '高' : '低'} ${Math.abs(m.diffPct)}%`)
  }
  if (insights.length === 0) insights.push(`本期共支出 ${fmtMoney(o.spent)}，无异常冲动，继续保持`)

  const topCat = f.categories[0]
  if (topCat) tips.push(`「${topCat.name}」占本期支出 ${topCat.percent}%，看看这部分有没有可压缩的空间`)
  if (f.impulse.count > 0) tips.push('冲动集中的时段把购物 App 设为冷静提醒，下单前先过 10 分钟')
  if (o.remaining < 0) tips.push(`本月已超支 ${fmtMoney(-o.remaining)}，先停掉非必要的订阅和囤货`)
  if (f.savings.target > 0) tips.push(`储蓄目标已完成 ${f.savings.percent}%，每次下单前先补一笔再决定`)
  if (tips.length === 0) tips.push('保持现有记账习惯，每周回顾一次消费结构即可')

  actions.push('给购物类支出设一个月度上限')
  actions.push('冲动时段开启冷静提醒')
  actions.push(`再存 ${fmtMoney(Math.max(50, Math.min(f.savings.remaining > 0 ? f.savings.remaining : 100, 200)))} 进储蓄目标`)

  return { insights: insights.slice(0, 2), tips: tips.slice(0, 3), actions: actions.slice(0, 3) }
}

async function generateSections(f: ReportFacts): Promise<Sections> {
  try {
    const text = await generateReportText(f, f.type)
    await incrementAiCount()
    const insights = extractBlock(text, 'insight')
    const tips = extractBlock(text, 'tip')
    const actions = extractBlock(text, 'action')
    if (insights.length > 0 && tips.length > 0 && actions.length > 0) return { insights, tips, actions }
    return fallbackSections(f)
  } catch {
    return fallbackSections(f)
  }
}

// ==================== HTML 组装 ====================

interface Charts { area: string; ring: string; bars: string }

function buildCharts(f: ReportFacts): Charts {
  return {
    area: f.type === 'day' ? '' : areaChartSVG(f.dailyTrend),
    ring: ringChartSVG(f.categories.map(c => ({ name: c.name, value: c.amount, color: colorOf(c.name) }))),
    bars: barListSVG(f.platforms.map(p => ({ name: p.name, value: p.amount, percent: p.percent }))),
  }
}

const IMPULSE_LABEL: Record<string, string> = { low: '', medium: '轻度', high: '中度', veryHigh: '高度' }
const TIP_NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣']

function kpiHTML(f: ReportFacts): string {
  const o = f.overview
  const ok = o.remaining >= 0
  const cards = [
    { label: '本期支出', value: fmtMoney(o.spent), sub: `${o.count} 笔交易`, color: '#111111' },
    { label: '预算', value: fmtMoney(o.budget), sub: `已用 ${o.budgetUsedPercent}%`, color: '#0040FF' },
    { label: '预算剩余', value: fmtMoney(o.remaining), sub: ok ? '预算内' : '已超支', color: ok ? '#10B981' : '#D73333' },
    { label: '冲动总额', value: fmtMoney(o.impulseAmount), sub: `冲动 ${o.impulseCount} 笔`, color: '#0040FF' },
  ]
  return `<div class="kpi">${cards.map(c => `
    <div class="item" style="background:${c.color}0F">
      <div class="lbl">${c.label}</div>
      <div class="val" style="color:${c.color}">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>`).join('')}</div>`
}

function trendBlock(f: ReportFacts, chart: string): string {
  return `<section class="card"><h2><span class="icon">📈</span>${f.type === 'week' ? '近7天' : '近30天'}支出趋势</h2>${chart}</section>`
}

function distBlock(ring: string, bars: string): string {
  return `<section class="card"><h2><span class="icon">🍩</span>消费分布</h2>
<div class="dist">
  <div><div class="sub-title">按分类</div>${ring}</div>
  <div><div class="sub-title">按平台 Top5</div>${bars}</div>
</div></section>`
}

function catTableBlock(f: ReportFacts): string {
  const rows = f.categories.map(c => {
    const delta = c.deltaPct === null || c.lastAmount <= 0
      ? '<span class="dim">—</span>'
      : c.deltaPct >= 0
        ? `<span class="up">▲ ${c.deltaPct}%</span>`
        : `<span class="down">▼ ${Math.abs(c.deltaPct)}%</span>`
    return `<tr>
      <td><span class="dot" style="background:${colorOf(c.name)}"></span>${esc(c.name)}</td>
      <td class="num">${fmtMoney(c.amount)}</td>
      <td class="num">${c.count} 笔</td>
      <td class="num">${c.percent}%</td>
      <td>${delta}</td>
    </tr>`
  }).join('')
  return `<section class="card"><h2><span class="icon">📋</span>分类明细</h2>
<div class="table-wrap"><table>
  <thead><tr><th>分类</th><th>金额</th><th>笔数</th><th>占比</th><th>环比${f.type === 'week' ? '上周' : '上月'}</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div></section>`
}

function txTableHTML(txs: { time: string; merchant: string; category: string; amount: number; paymentMethod: string; impulseLevel: string }[], withTime: boolean): string {
  const rows = txs.map(t => `<tr>
    <td class="num">${esc(withTime ? t.time.slice(5, 16) : t.time.slice(0, 10))}</td>
    <td>${esc(t.merchant)}</td>
    <td>${esc(t.category)}</td>
    <td class="num">${fmtMoney(t.amount)}</td>
    <td>${esc(t.paymentMethod)}</td>
    <td>${IMPULSE_LABEL[t.impulseLevel] ?? ''}</td>
  </tr>`).join('')
  return `<div class="table-wrap"><table>
  <thead><tr><th>${withTime ? '时间' : '日期'}</th><th>商家</th><th>分类</th><th>金额</th><th>支付方式</th><th>冲动</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`
}

function dayDetailBlock(f: ReportFacts): string {
  return `<section class="card"><h2><span class="icon">📝</span>当日明细</h2>${txTableHTML(f.transactions, true)}</section>`
}

function appendixBlock(f: ReportFacts): string {
  return `<section class="card"><h2><span class="icon">🗂</span>数据附录</h2>
<details><summary>近30天全部交易（${f.totalCount} 笔）</summary>
${txTableHTML(f.transactions, false)}
</details></section>`
}

function insightBlock(insights: string[]): string {
  if (insights.length === 0) return ''
  const boxes = insights.map(s => `<div class="insight-box">🔍 ${esc(s)}</div>`).join('')
  return `<section class="card"><h2><span class="icon">💡</span>AI 洞察</h2>${boxes}</section>`
}

/** 六项新能力区块：净资产 / 承诺 / 情绪 / 降价追踪 / 历史账单导入 */
function lifeBlock(f: ReportFacts): string {
  const l = f.life
  const boxes: string[] = []

  const nw = l.netWorth
  if (nw) {
    const delta = nw.delta != null
      ? `<span class="${nw.delta >= 0 ? 'up' : 'down'}">${nw.delta >= 0 ? '▲ +' : '▼ '}${fmtMoney(Math.abs(nw.delta))}</span>`
      : '<span class="dim">—</span>'
    boxes.push(`<div class="life-item"><div class="life-icon">◍</div><div class="life-body"><div class="life-title">净资产（${esc(nw.date)}）</div><div class="life-val">${fmtMoney(nw.current)} <span style="font-size:12px;font-weight:500">${delta}</span></div></div></div>`)
  }

  if (l.commitments.length > 0) {
    const cm = l.commitments.map(c =>
      `<div class="life-line"><span>📜 ${esc(c.text)}</span><span class="num ${c.pct > 100 ? 'up' : 'down'}">${c.pct}%</span></div>`
    ).join('')
    boxes.push(`<div class="life-item"><div class="life-icon">🤝</div><div class="life-body"><div class="life-title">自我承诺（${l.commitments.length} 项进行中）</div>${cm}</div></div>`)
  }

  if (l.moods) {
    const moodLine = l.moods.diffPct != null
      ? `压力大的日子日均 ${fmtMoney(l.moods.stressedAvg ?? 0)}，比平静日${l.moods.diffPct > 0 ? '高' : '低'} <b>${Math.abs(l.moods.diffPct)}%</b>`
      : '情绪记录正在积累'
    boxes.push(`<div class="life-item"><div class="life-icon">😌</div><div class="life-body"><div class="life-title">情绪（近7天：${esc(l.moods.dist7)}）</div><div class="life-val">${moodLine}</div></div></div>`)
  }

  if (l.priceDrop) {
    boxes.push(`<div class="life-item"><div class="life-icon">💸</div><div class="life-body"><div class="life-title">等等更便宜</div><div class="life-val">冷静后买的 <b>${l.priceDrop.count}</b> 件，平均比刚想买时便宜 <b>${l.priceDrop.avgDropRate}%</b>，共省 ${fmtMoney(l.priceDrop.totalSaved)}</div></div></div>`)
  }

  if (l.importedCount > 0) {
    boxes.push(`<div class="life-item"><div class="life-icon">📥</div><div class="life-body"><div class="life-title">历史账单导入</div><div class="life-val">已导入 <b>${l.importedCount}</b> 笔历史账单（按交易单号去重，含冲动指数）</div></div></div>`)
  }

  if (boxes.length === 0) return ''
  return `<section class="card"><h2><span class="icon">🌱</span>生活与净资产</h2><div class="life-grid">${boxes.join('')}</div></section>`
}

function tipsBlock(tips: string[]): string {
  if (tips.length === 0) return ''
  const boxes = tips.map((s, i) => `<div class="tip-box">📌 ${TIP_NUM[i] ?? ''} ${esc(s)}</div>`).join('')
  return `<section class="card"><h2><span class="icon">📌</span>AI 建议</h2>${boxes}</section>`
}

function actionsBlock(actions: string[], title: string): string {
  if (actions.length === 0) return ''
  const items = actions.map(s => `<label class="action-item"><input type="checkbox"/> ${esc(s)}</label>`).join('')
  return `<section class="card"><h2><span class="icon">✅</span>${title}</h2>${items}</section>`
}

const REPORT_CSS = `:root{--p:#0040FF;--ink:#111111;--sub:#888888;--line:#C0C4C4;--bg:#FFFFFF}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;-webkit-font-smoothing:antialiased;line-height:1.6}
.page{max-width:920px;margin:0 auto;padding:24px 16px 48px}
.header{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px;margin-bottom:20px}
.header h1{font-size:22px;margin:0 0 4px;letter-spacing:.3px;color:var(--ink)}
.meta{color:var(--sub);font-size:12.5px}
.toolbar{display:flex;gap:8px}
.btn{border:1px solid var(--line);background:#FFFFFF;color:#374151;border-radius:10px;padding:8px 14px;font-size:13px;cursor:pointer;font-family:inherit}
.btn:hover{border-color:var(--p);color:var(--p)}
.card{background:#FFFFFF;border:1px solid #C0C4C4;border-radius:16px;padding:20px;margin-bottom:16px}
.card h2{font-size:15px;margin:0 0 14px;display:flex;align-items:center;gap:8px;color:var(--ink)}
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kpi .item{border-radius:12px;padding:14px;background:#E4E6E6;border:1px solid #C0C4C4}
.kpi .lbl{font-size:12px;color:var(--sub);margin-bottom:6px}
.kpi .val{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.2}
.kpi .sub{font-size:11px;color:var(--sub);margin-top:4px}
.sub-title{font-size:12.5px;color:var(--sub);margin-bottom:10px}
.dist{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.insight-box{background:#FFFBEB;border-left:4px solid #f59e0b;border-radius:10px;padding:12px 14px;margin-bottom:10px;font-size:13.5px;color:#78350F;line-height:1.7}
.tip-box{background:#ECFEFF;border-left:4px solid #22D3EE;border-radius:10px;padding:12px 14px;margin-bottom:10px;font-size:13.5px;color:#155E75;line-height:1.7}
.life-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.life-item{background:#F8FAFF;border:1px solid #E0E7FF;border-radius:10px;padding:12px 14px;display:flex;gap:10px}
.life-icon{font-size:18px;flex-shrink:0}
.life-title{font-size:12px;color:var(--sub);margin-bottom:4px}
.life-val{font-size:14px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums;line-height:1.7}
.life-line{display:flex;justify-content:space-between;gap:8px;font-size:12.5px;color:#374151;padding:2px 0}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--sub);font-weight:600;padding:8px 10px;border-bottom:1px solid var(--line);font-size:12px;white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid #E4E6E6;white-space:nowrap;color:var(--ink)}
tr:last-child td{border-bottom:none}
.num{font-variant-numeric:tabular-nums}
.up{color:#D97706;font-weight:600}
.down{color:#0891B2;font-weight:600}
.dim{color:#A0A4A4}
.dot{display:inline-block;width:8px;height:8px;border-radius:3px;margin-right:6px;vertical-align:1px}
.action-item{display:flex;gap:10px;align-items:flex-start;padding:10px 4px;border-bottom:1px dashed var(--line);font-size:14px;color:var(--ink)}
.action-item:last-child{border-bottom:none}
.action-item input{width:16px;height:16px;margin-top:2px;accent-color:var(--p);flex-shrink:0}
details summary{cursor:pointer;color:var(--p);font-size:13px;padding:4px 0}
details summary:hover{opacity:.8}
.footer{text-align:center;color:#A0A4A4;font-size:11.5px;margin-top:6px}
@media (max-width:640px){.dist{grid-template-columns:1fr}.header{align-items:flex-start}}
@media print{.no-print{display:none!important}body{background:#fff;color:#111111}.card{background:#fff;border:1px solid #C0C4C4;box-shadow:none;margin-bottom:12px;break-inside:avoid}.page{padding:8px 0}.kpi .item{background:#E4E6E6;border:1px solid #C0C4C4}.life-item{background:#E4E6E6;border:1px solid #C0C4C4}.insight-box,.tip-box{background:#E4E6E6;color:#111111}}`

function buildHtml(f: ReportFacts, sec: Sections, charts: Charts): string {
  const title = `${f.periodLabel} 财务分析报告`
  const nowStr = new Date().toLocaleString('zh-CN', { hour12: false })

  const kpi = kpiHTML(f)
  const trend = f.type === 'day' ? '' : trendBlock(f, charts.area)
  const dist = f.type === 'day' ? '' : distBlock(charts.ring, charts.bars)
  const catTable = f.type === 'day' ? '' : catTableBlock(f)
  const life = f.type === 'day' ? '' : lifeBlock(f)
  const detail = f.type === 'day' ? dayDetailBlock(f) : ''
  const insight = insightBlock(sec.insights)
  const tips = f.type === 'day' ? '' : tipsBlock(sec.tips)
  const actions = actionsBlock(sec.actions, f.type === 'day' ? '明日行动' : '下月行动')
  const appendix = f.type === 'month' ? appendixBlock(f) : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="page">
  <header class="header">
    <div>
      <h1>${esc(title)}</h1>
      <div class="meta">生成时间：${esc(nowStr)} · 数据来自本地账本</div>
    </div>
    <div class="toolbar no-print">
      <button class="btn" onclick="window.print()">🖨 打印</button>
      <button class="btn" onclick="downloadHtml()">⬇ 下载HTML</button>
    </div>
  </header>

  <section class="card"><h2><span class="icon">📊</span>${f.type === 'day' ? '今日概览' : '本期概览'}</h2>${kpi}</section>
  ${trend}
  ${dist}
  ${catTable}
  ${life}
  ${detail}
  ${insight}
  ${tips}
  ${actions}
  ${appendix}

  <div class="footer">本报告由本地数据生成 · AI 仅参与文字撰写 · 图表均由前端代码计算绘制</div>
</div>
<script>
function downloadHtml(){
  var html='<!DOCTYPE html>\\n'+document.documentElement.outerHTML;
  var blob=new Blob([html],{type:'text/html;charset=utf-8'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  a.href=url;a.download='${esc(title)}.html';
  document.body.appendChild(a);a.click();
  document.body.removeChild(a);
  setTimeout(function(){URL.revokeObjectURL(url)},1000);
}
</script>
</body>
</html>`
}

// ==================== 报告生成入口 ====================

export async function generateHtmlReport(
  type: ReportType,
  opts: { onStatus?: (s: AgentStatus) => void } = {}
): Promise<HtmlReport> {
  const emit = (name: string, label: string, state: AgentStatus['state']) =>
    opts.onStatus?.({ id: `r-${name}`, name, label, state })

  emit('report_collect', '🤖 正在收集数据…', 'running')
  const facts = await collectFacts(type)
  emit('report_collect', '数据收集完成', 'done')

  emit('report_charts', '📊 正在生成图表…', 'running')
  const charts = buildCharts(facts)
  emit('report_charts', '图表生成完成', 'done')

  emit('report_ai', '🧠 正在让 AI 写洞察…', 'running')
  const sections = await generateSections(facts)
  emit('report_ai', 'AI 洞察已生成', 'done')

  return {
    type,
    facts,
    html: buildHtml(facts, sections, charts),
    summary: `报告已生成（${facts.periodLabel}），包含总览、趋势、消费分布和 AI 洞察，可全屏查看或下载 📄`,
  }
}

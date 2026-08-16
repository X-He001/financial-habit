import { useState, useEffect, useRef } from 'react'
import RichMessage, { hasRichBlock } from '../components/RichMessage'
import Markdown from '../components/Markdown'
import AiHtml, { isHtmlContent } from '../components/AiHtml'
import ReportCoachChat from '../components/ReportCoachChat'
import { generateReport, hasApiKey, aiErrorMessage } from '../api/deepseek'
import { runLoop } from '../agent/loopEngine'
import { applyCoachEnvAction } from '../agent/coachEngine'
import { getDayFacts, getWeekFacts, getMonthFacts } from '../utils/aiFacts'
import { dayTemplate, weekTemplate, monthTemplate, verifyAiNumbers } from '../utils/reportTemplates'
import { CORRECTED_BY_SYSTEM } from '../utils/factGuard'
import { getAiMonthCount, incrementAiCount } from '../utils/aiUsage'
import { getSetting, setSetting, deleteSchedule, updateSavingsGoal } from '../db/crud'
import { db } from '../db/database'
import MoodAnalysis from '../components/MoodAnalysis'
import {
  KpiRow, SectionTitle, SlotBarChart, CategoryRing, WeekLineChart, CategoryStackChart,
  MonthTrendLine, DebtBurnDown, HealthBars, RingPct,
  TxSheet, ActionBtn, EmptyBox, fmtY,
  type SlotRow, type NamedAmt, type TxItem, type KpiDef,
} from '../components/ReportVisuals'

type Tab = 'day' | 'week' | 'month'
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'day', label: '📅 今日 AI 总结' },
  { key: 'week', label: '📊 每周分析' },
  { key: 'month', label: '📈 每月复盘' },
]
const PERIOD_LABEL: Record<Tab, string> = { day: '每日', week: '每周', month: '每月' }

/** 自主循环生成的 AI 总结（HTML）缓存 */
interface LoopSummary { html: string; date: string; toolCount: number; guardIssues: number }
type LoopCache = Partial<Record<Tab, LoopSummary>>

const LOOP_CACHE_KEY = 'aiLoopSummaryCache'

async function loadLoopCache(): Promise<LoopCache> {
  const raw = await getSetting(LOOP_CACHE_KEY)
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw) as LoopCache
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
async function saveLoopCache(cache: LoopCache) {
  await setSetting(LOOP_CACHE_KEY, JSON.stringify(cache))
}

interface ReportState { text: string; totalCount: number; date: string }
interface Cache { [k: string]: ReportState }

const CACHE_KEY = 'aiReportCache'
const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function loadCache(): Promise<Cache> {
  const raw = await getSetting(CACHE_KEY)
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw) as Cache
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
async function saveCache(cache: Cache) {
  await setSetting(CACHE_KEY, JSON.stringify(cache))
}

function pad2(n: number): string { return String(n).padStart(2, '0') }
function dateKey(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }

// 冲动等级标签（前台只展示等级，不展示 0-100 冲动分）
const IMPULSE_LEVEL_LABEL: Record<string, string> = { low: '低', medium: '中', high: '高', veryHigh: '很高' }
function impulseLabel(level: string): string {
  return IMPULSE_LEVEL_LABEL[level] ?? level
}

// ==================== facts 类型 ====================

interface DayTx { merchant: string; category: string; amount: number; time: string; paymentMethod: string; impulseLevel: string; impulseScore: number }
interface DayFacts {
  todayExpense: number; todayIncome: number; todayCount: number; impulseCount: number
  top3: Array<{ merchant: string; amount: number }>
  budget: number; monthExpense: number; remaining: number; restDays: number; dailyBudget: number
  todaySlotDist: SlotRow[]; todayTxs: DayTx[]; monthCategoryDist: NamedAmt[]
  yesterdayPromise: string | null; totalTxCount: number
}
interface WeekFacts {
  weekExpense: number; weekDeltaPct: number | null; weekSaving: number; savingsRate: number
  impulseTotal: number; impulseCount: number; impulseDeltaPct: number | null; savingDeltaPct: number | null
  weekDailyTrend: Array<{ date: string; amount: number }>; dailyAvgBudget: number
  categoryStack: Array<{ category: string; thisWeek: number; lastWeek: number }>
  topScene: { scene: string; count: number } | null
  catDelta: { category: string; deltaPct: number } | null
  highWeekdays: Array<{ day: string; avg: number }>
  lateNightCount: number; totalTxCount: number
}
interface MonthFacts {
  monthExpense: number; lastMonthExpense: number; expenseDeltaPct: number | null
  budget: number; budgetUsedPct: number; income: number; savings: number; savingsRate?: number
  categoryDetail: Array<{ category: string; amount: number; lastAmount: number; pct: number }>
  savingsGoal: { name: string; current: number; target: number; pct: number | null } | null
  debtTotal: number; debtDelta: number; debtCount: number
  impulseThisTotal: number; impulseThisCount: number; impulseLastTotal: number; impulseLastCount: number
  trend12: Array<{ month: string; expense: number; income: number }>
  recurringDeductions: Array<{ merchant: string; amount: number; months: number; suspicious: boolean }>
  installmentTotal: number; installmentCount: number
  installmentTxs: Array<{ merchant: string; amount: number; time: string; paymentMethod: string }>
  subscriptionMonthly: number
  debtTrend12: Array<{ month: string; debt: number }>
  healthScore: number; healthDims: Array<{ name: string; score: number }>
  totalTxCount: number
}

type AnyFacts = DayFacts | WeekFacts | MonthFacts

function slotOfTime(time: string): string {
  const h = Number(time.slice(0, 2))
  if (h < 6) return '凌晨'
  if (h < 12) return '上午'
  if (h < 18) return '下午'
  if (h < 22) return '晚上'
  return '深夜'
}

function deltaTag(pct: number | null, _goodDown = false): string {
  if (pct === null) return ''
  const up = pct > 0
  const arrow = up ? '↑' : '↓'
  return `较上周 ${up ? '+' : ''}${pct}% ${arrow}`
}

// ==================== 主组件 ====================

export default function Report() {
  const [tab, setTab] = useState<Tab>('day')
  const [reports, setReports] = useState<Cache>({})
  const [factsMap, setFactsMap] = useState<Partial<Record<Tab, AnyFacts>>>({})
  const [loading, setLoading] = useState<Tab | null>(null)
  const [factsLoading, setFactsLoading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [aiCount, setAiCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // 自主循环生成的 AI 总结（今日 AI 总结 / 周 / 月）
  const [loopSum, setLoopSum] = useState<LoopCache>({})
  const [loopLoading, setLoopLoading] = useState<Tab | null>(null)
  // 下钻明细弹层
  const [sheet, setSheet] = useState<{ title: string; txs: TxItem[] } | null>(null)
  // 月报「调整储蓄目标」内联编辑
  const [editingGoal, setEditingGoal] = useState(false)
  const [goalInput, setGoalInput] = useState('')
  // 响应式：<900px 降单栏
  const [isWide, setIsWide] = useState(window.innerWidth >= 900)
  /** 自主循环互斥锁（同一时间只跑一个循环） */
  const loopBusyRef = useRef<Tab | null>(null)

  // —— 显示"已生效"提示（2.5 秒自动消失） ——
  function toastIt(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2600)
  }

  useEffect(() => {
    void (async () => {
      setReports(await loadCache())
      setAiCount(await getAiMonthCount())
    })()
  }, [])

  // 实时同步：云端数据更新（dashboard-refresh 事件）后重新生成报表
  useEffect(() => {
    const h = () => {
      void (async () => {
        setReports(await loadCache())
        setAiCount(await getAiMonthCount())
      })()
    }
    window.addEventListener('dashboard-refresh', h)
    return () => window.removeEventListener('dashboard-refresh', h)
  }, [])

  useEffect(() => {
    void refreshFacts(tab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // 打开页面/切换页签：加载 AI 总结缓存；今天还没生成且已配置 Key → 自动跑一次自主循环
  useEffect(() => {
    void (async () => {
      const cached = await loadLoopCache()
      setLoopSum(cached)
      if (cached[tab]?.date === todayStr()) return
      if (await hasApiKey()) void runLoopAI(tab)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // 响应式：监听窗口宽度
  useEffect(() => {
    const h = () => setIsWide(window.innerWidth >= 900)
    window.addEventListener('resize', h)
    return () => window.removeEventListener('resize', h)
  }, [])

  async function refreshCount() {
    setAiCount(await getAiMonthCount())
  }

  async function refreshFacts(t: Tab) {
    setFactsLoading(true)
    try {
      const f = t === 'day' ? await getDayFacts() : t === 'week' ? await getWeekFacts() : await getMonthFacts()
      setFactsMap(prev => ({ ...prev, [t]: f as unknown as AnyFacts }))
    } finally {
      setFactsLoading(false)
    }
  }

  async function handleGenerate(type: Tab) {
    setError(null)
    const ok = await hasApiKey()
    if (!ok) { setError('请先到设置页配置 API Key，才能生成 AI 报告'); return }

    setLoading(type)
    setNotice(null)
    try {
      const facts = type === 'day' ? await getDayFacts() : type === 'week' ? await getWeekFacts() : await getMonthFacts()
      setFactsMap(prev => ({ ...prev, [type]: facts as unknown as AnyFacts }))
      let text = ''
      try {
        await incrementAiCount()
        text = await generateReport(facts, type)
        await refreshCount()
        if (!verifyAiNumbers(text, facts)) {
          text = type === 'day' ? dayTemplate(facts) : type === 'week' ? weekTemplate(facts) : monthTemplate(facts)
          setNotice(`AI 返回内容与真实数据有出入，${CORRECTED_BY_SYSTEM}（已改用本地计算结果展示）`)
        }
      } catch (e) {
        text = type === 'day' ? dayTemplate(facts) : type === 'week' ? weekTemplate(facts) : monthTemplate(facts)
        setNotice(`AI 生成失败（${aiErrorMessage(e)}），已展示本地计算结果`)
        await refreshCount()
      }
      const state: ReportState = { text, totalCount: Number(facts.totalTxCount) || 0, date: todayStr() }
      setReports(prev => {
        const next = { ...prev, [type]: state }
        void saveCache(next)
        return next
      })
    } finally {
      setLoading(null)
    }
  }

  // ==================== 自主循环 Agent：一键生成 AI 总结（今日/每周/每月） ====================

  const LOOP_GOAL: Record<Tab, string> = {
    day: '生成今日 AI 总结：分析今日消费（支出、预算、冲动等级分布、消费事件），给出关键结论与下一步建议',
    week: '生成每周复盘：分析本周消费模式与变化（支出、储蓄、冲动、高消费日），给出风险点与下周建议',
    month: '生成每月复盘：分析本月收支、预算执行、冲动、负债与储蓄，给出下月计划建议',
  }

  /** AI 输出里的可执行按钮（env: 真实写 settings；ask: 引导去下方继续提问） */
  function handleLoopAction(action: string) {
    if (action.startsWith('env:')) {
      const parts = action.split(':')
      const id = parts[1] ?? ''
      const platform = parts.slice(2).join(':') || undefined
      void applyCoachEnvAction(id, platform).then(r => toastIt(r.ok ? `✅ ${r.message}` : `⚠️ ${r.message}`))
    } else if (action.startsWith('ask:')) {
      toastIt('可以点击下方「与 AI 助手继续复盘」向我提问')
    }
  }

  /**
   * 一键生成：自主循环 Agent（runLoop）完成 规划→查数→自查→输出。
   * - 传入真实数据快照（代码算好的数字）供 AI 引用；AI 同时会自主调用工具补查。
   * - 失败降级到旧文本报告（handleGenerate），保证页面不崩、有内容可看。
   */
  async function runLoopAI(type: Tab) {
    if (loopBusyRef.current) return
    const ok = await hasApiKey()
    if (!ok) { setError('请先到设置页配置 API Key，才能生成 AI 分析'); return }
    loopBusyRef.current = type
    setLoopLoading(type)
    setNotice(null)
    try {
      const facts = type === 'day' ? await getDayFacts() : type === 'week' ? await getWeekFacts() : await getMonthFacts()
      setFactsMap(prev => ({ ...prev, [type]: facts as unknown as AnyFacts }))
      const res = await runLoop(LOOP_GOAL[type], {
        snapshot: reportSnapshotText(type, facts as unknown as AnyFacts),
        onStatus: () => { /* 单行 loading 已覆盖，工具级提示在窗口通道展示 */ },
        onProgress: () => { /* 保持单行 loading，不刷屏 */ },
      })
      const entry: LoopSummary = { html: res.html, date: todayStr(), toolCount: res.toolCount, guardIssues: res.guardIssues.length }
      setLoopSum(prev => ({ ...prev, [type]: entry }))
      const prevCache = await loadLoopCache()
      await saveLoopCache({ ...prevCache, [type]: entry })
      await refreshCount()
    } catch (e) {
      setNotice(`AI 自主分析失败（${aiErrorMessage(e)}），已改用本地计算展示`)
      await handleGenerate(type)
    } finally {
      loopBusyRef.current = null
      setLoopLoading(null)
    }
  }

  const current = reports[tab]
  const dayF = factsMap.day as DayFacts | undefined
  const weekF = factsMap.week as WeekFacts | undefined
  const monthF = factsMap.month as MonthFacts | undefined

  /** 把报告 facts 压成一行行真实数字快照，供 AI 复盘/自主循环引用（数字由代码算好，AI 只组织语言） */
  function reportSnapshotText(t: Tab, f?: AnyFacts): string {
    if (t === 'day') {
      const day = (f ?? factsMap.day) as DayFacts | undefined
      if (day) {
        const budgetPct = day.budget > 0 ? Math.round((day.monthExpense / day.budget) * 100) : 0
        // 冲动等级分布（只报等级与笔数，不报 0-100 分数）
        const distMap = new Map<string, number>()
        for (const tx of day.todayTxs) {
          const lv = impulseLabel(tx.impulseLevel)
          distMap.set(lv, (distMap.get(lv) ?? 0) + 1)
        }
        const distText = distMap.size > 0
          ? [...distMap.entries()].map(([lv, n]) => `${lv} ${n} 笔`).join('、')
          : '无'
        return [
          `今日支出 ${fmtY(day.todayExpense)}（${day.todayCount} 笔），今日收入 ${fmtY(day.todayIncome)}`,
          `本月预算 ${fmtY(day.budget)}，已支出 ${fmtY(day.monthExpense)}（使用率 ${budgetPct}%），剩余 ${fmtY(Math.max(0, day.remaining))}，本月还剩 ${day.restDays} 天，日均可用 ${fmtY(day.dailyBudget)}`,
          `今日冲动等级分布：${distText}`,
          `今日 Top3 支出：${day.top3.length > 0 ? day.top3.map(x => `${x.merchant} ${fmtY(x.amount)}`).join('、') : '无'}`,
        ].join('\n')
      }
    }
    if (t === 'week') {
      const week = (f ?? factsMap.week) as WeekFacts | undefined
      if (week) {
        return [
          `本周支出 ${fmtY(week.weekExpense)}${week.weekDeltaPct === null ? '' : `（较上周 ${week.weekDeltaPct > 0 ? '+' : ''}${week.weekDeltaPct}%）`}`,
          `本周储蓄 ${fmtY(week.weekSaving)}，储蓄率 ${week.savingsRate}%（目标 25%）`,
          `冲动消费 ${week.impulseCount} 笔共 ${fmtY(week.impulseTotal)}（深夜 ${week.lateNightCount} 次）`,
          `最高频场景：${week.topScene ? `${week.topScene.scene}（${week.topScene.count} 次）` : '暂无'}`,
          `最大变化分类：${week.catDelta ? `${week.catDelta.category} ${week.catDelta.deltaPct > 0 ? '+' : ''}${week.catDelta.deltaPct}%` : '暂无'}`,
          week.highWeekdays.length > 0
            ? `历史高消费日：${week.highWeekdays.map(h => `${h.day}（日均 ${fmtY(h.avg)}）`).join('、')}`
            : '暂无历史高消费日规律',
        ].join('\n')
      }
    }
    if (t === 'month') {
      const month = (f ?? factsMap.month) as MonthFacts | undefined
      if (month) {
        const savingsRate = month.income > 0
          ? Math.round((month.savings / month.income) * 100)
          : (month.budget > 0 ? Math.round((month.savings / month.budget) * 100) : 0)
        const topCats = month.categoryDetail.slice(0, 3)
        return [
          `本月总支出 ${fmtY(month.monthExpense)}（较上月 ${month.expenseDeltaPct === null ? '暂无数据' : `${month.expenseDeltaPct > 0 ? '+' : ''}${month.expenseDeltaPct}%`}），收入 ${fmtY(month.income)}，净储蓄 ${fmtY(month.savings)}，储蓄率 ${savingsRate}%`,
          `预算 ${fmtY(month.budget)}，已用 ${month.budgetUsedPct}%，财务健康分 ${month.healthScore}`,
          `分类 Top：${topCats.length > 0 ? topCats.map(c => `${c.category} ${fmtY(c.amount)}（占 ${c.pct}%）`).join('、') : '暂无'}`,
          `冲动本月 ${month.impulseThisCount} 笔共 ${fmtY(month.impulseThisTotal)}（上月 ${month.impulseLastCount} 笔共 ${fmtY(month.impulseLastTotal)}）`,
          `负债合计 ${fmtY(month.debtTotal)}（${month.debtCount} 笔）${month.debtDelta !== 0 ? `，较上月${month.debtDelta < 0 ? '减少' : '增加'} ${fmtY(Math.abs(month.debtDelta))}` : ''}`,
          month.savingsGoal ? `储蓄目标「${month.savingsGoal.name}」进度 ${month.savingsGoal.pct ?? 0}%（已存 ${fmtY(month.savingsGoal.current)} / ${fmtY(month.savingsGoal.target)}）` : '暂无储蓄目标',
          month.recurringDeductions.length > 0
            ? `自动扣费：${month.recurringDeductions.slice(0, 3).map(r => `${r.merchant} ${fmtY(r.amount)}/月`).join('、')}`
            : '近 3 个月无重复自动扣费',
          month.subscriptionMonthly > 0 ? `订阅月成本合计 ${fmtY(month.subscriptionMonthly)}` : '',
        ].filter(Boolean).join('\n')
      }
    }
    return ''
  }

  // ==================== 每日摘要 ====================
  function daySection() {
    if (!dayF) return <LoadingBox text="正在统计今日数据…" />
    const budgetPct = dayF.budget > 0 ? Math.round((dayF.monthExpense / dayF.budget) * 100) : 0
    const kpis: KpiDef[] = [
      { label: '今日总支出', value: fmtY(dayF.todayExpense), sub: `${dayF.todayCount} 笔` },
      { label: '今日收入', value: fmtY(dayF.todayIncome) },
      {
        label: '本月预算已用', value: `${Math.min(999, budgetPct)}%`,
        sub: `剩余 ${fmtY(Math.max(0, dayF.remaining))}`,
        color: budgetPct >= 90 ? '#E11D48' : budgetPct >= 70 ? '#D97706' : '#059669',
      },
    ]
    return (
      <>
        <KpiRow kpis={kpis} />

        {/* ① 今日支出时段分布（可下钻） */}
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <SectionTitle right={<span style={{ fontSize: 11, color: '#A0A4A4' }}>点击柱子查看该时段明细</span>}>
            今日支出时段分布
          </SectionTitle>
          <SlotBarChart data={dayF.todaySlotDist} onPick={(row) => {
            if (row.amount <= 0) return
            const list = dayF.todayTxs.filter(t => slotOfTime(t.time) === row.name)
            setSheet({
              title: `${row.name}支出明细（${list.length} 笔，共 ${fmtY(row.amount)}）`,
              txs: list.map(t => ({
                merchant: t.merchant,
                amount: t.amount,
                sub: `${t.time} · ${t.category} · ${t.paymentMethod}`,
                extra: t.impulseLevel !== 'low' ? `冲动·${impulseLabel(t.impulseLevel)}` : undefined,
              })),
            })
          }} />
        </div>

        {/* ② 本月分类占比环形图（中心 = 今日总支出） */}
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <SectionTitle>本月分类占比</SectionTitle>
          <CategoryRing data={dayF.monthCategoryDist} centerTitle="今日总支出" centerValue={fmtY(dayF.todayExpense)} />
        </div>

        {/* 💡 发现区 */}
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <SectionTitle>💡 今日发现</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {dayF.top3.length === 0 ? (
                <span style={{ fontSize: 13, color: '#A0A4A4' }}>今日暂无支出</span>
              ) : dayF.top3.map(t => (
                <span key={t.merchant} style={{ padding: '6px 12px', borderRadius: 999, background: '#EEF2FF', fontSize: 12.5, fontWeight: 600, color: '#0040FF' }}>
                  {t.merchant} {fmtY(t.amount)}
                </span>
              ))}
            </div>
            <div style={{ fontSize: 13, color: '#374151' }}>
              冲动消费 <b style={{ color: dayF.impulseCount > 0 ? '#F43F5E' : '#059669' }}>{dayF.impulseCount} 笔</b>
              {' · '}预算剩余 <b style={{ color: dayF.remaining < 0 ? '#F43F5E' : '#0040FF' }}>{fmtY(Math.max(0, dayF.remaining))}</b>
              {dayF.yesterdayPromise && <span style={{ color: '#888888' }}> · 昨日承诺：{dayF.yesterdayPromise}</span>}
            </div>
          </div>
        </div>

        {/* 🎯 明日动作区 */}
        <div className="card" style={{ padding: 16, marginTop: 12, background: 'linear-gradient(135deg,#EEF2FF,#F0F9FF)' }}>
          <SectionTitle>🎯 明日动作</SectionTitle>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 13, color: '#888888' }}>本月还剩 {dayF.restDays} 天 · 日均可用</span>
            <span style={{ fontSize: 30, fontWeight: 800, color: '#0040FF', fontVariantNumeric: 'tabular-nums' }}>{fmtY(dayF.dailyBudget)}</span>
            <span style={{ fontSize: 13, color: '#888888' }}>/天</span>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            <ActionBtn color="#0040FF" onClick={() => {
              const amountMinor = Math.max(1000, Math.round(dayF.dailyBudget * 100 / 100) * 100)
              const tomorrow = new Date()
              tomorrow.setDate(tomorrow.getDate() + 1)
              void setSetting('dailyLimitOverride', JSON.stringify({ amountMinor, date: dateKey(tomorrow) }))
              toastIt(`已生效：明日额度已下调为 ${fmtY(amountMinor / 100)}`)
            }}>
              📉 一键下调明日额度为 {fmtY(Math.max(10, Math.round(dayF.dailyBudget)))}
            </ActionBtn>
            <ActionBtn color="#06B6D4" onClick={() => {
              setSheet({
                title: `今日全部交易（${dayF.todayTxs.length} 笔，共 ${fmtY(dayF.todayExpense)}）`,
                txs: dayF.todayTxs.map(t => ({
                  merchant: t.merchant, amount: t.amount,
                  sub: `${t.time} · ${t.category} · ${t.paymentMethod}`,
                  extra: t.impulseLevel !== 'low' ? `冲动·${impulseLabel(t.impulseLevel)}` : undefined,
                })),
              })
            }}>
              📋 查看今日明细
            </ActionBtn>
          </div>
        </div>
      </>
    )
  }

  // ==================== 每周分析 ====================
  function weekSection() {
    if (!weekF) return <LoadingBox text="正在统计本周数据…" />
    const kpis: KpiDef[] = [
      {
        label: '本周支出', value: fmtY(weekF.weekExpense),
        sub: deltaTag(weekF.weekDeltaPct), color: (weekF.weekDeltaPct ?? 0) > 0 ? '#F59E0B' : '#111111',
      },
      {
        label: '本周储蓄', value: fmtY(weekF.weekSaving),
        sub: deltaTag(weekF.savingDeltaPct), color: weekF.savingsRate >= 25 ? '#059669' : '#D97706',
      },
      {
        label: '冲动消费总额', value: fmtY(weekF.impulseTotal),
        sub: `${weekF.impulseCount} 笔 · ${deltaTag(weekF.impulseDeltaPct)}`,
        color: weekF.impulseTotal > 0 ? '#F43F5E' : '#059669',
      },
    ]
    return (
      <>
        <KpiRow kpis={kpis} />

        {/* ① 本周每日支出 + 日均预算虚线 */}
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <SectionTitle right={<span style={{ fontSize: 11, color: '#A0A4A4' }}>超过橙色虚线 = 超日均预算</span>}>
            本周每日支出
          </SectionTitle>
          <WeekLineChart data={weekF.weekDailyTrend} budgetLine={weekF.dailyAvgBudget} />
        </div>

        {/* ② 分类堆叠柱 本周 vs 上周 */}
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <SectionTitle>分类支出对比（本周 vs 上周）</SectionTitle>
          <CategoryStackChart stack={weekF.categoryStack} />
        </div>

        {/* 💡 本周模式 */}
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <SectionTitle>💡 本周模式</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: '#374151', lineHeight: 1.7 }}>
            <div>最高频场景：<b style={{ color: '#0040FF' }}>{weekF.topScene ? `${weekF.topScene.scene}（${weekF.topScene.count} 次）` : '—'}</b></div>
            <div>
              最大变化分类：<b style={{ color: (weekF.catDelta?.deltaPct ?? 0) > 0 ? '#D97706' : '#059669' }}>
                {weekF.catDelta ? `${weekF.catDelta.category} ${weekF.catDelta.deltaPct > 0 ? '+' : ''}${weekF.catDelta.deltaPct}%` : '—'}
              </b>
            </div>
            <div>储蓄率：<b style={{ color: weekF.savingsRate >= 25 ? '#059669' : '#D97706' }}>{weekF.savingsRate}%</b>（目标 25%）</div>
            {weekF.impulseCount > 0 && <div>冲动消费：<b style={{ color: '#F43F5E' }}>{weekF.impulseCount} 笔共 {fmtY(weekF.impulseTotal)}</b>（深夜 {weekF.lateNightCount} 次）</div>}
          </div>
        </div>

        {/* 🎯 下周预警 */}
        <div className="card" style={{ padding: 16, marginTop: 12, background: 'linear-gradient(135deg,#EEF2FF,#F0F9FF)' }}>
          <SectionTitle>🎯 下周建议</SectionTitle>
          {weekF.highWeekdays.length > 0 && (
            <div style={{ fontSize: 13, color: '#888888', marginBottom: 12 }}>
              历史高消费日：{weekF.highWeekdays.map(h => `${h.day}（日均 ${fmtY(h.avg)}）`).join('、')} —— 这几天容易超支，提前设防
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <ActionBtn color="#0040FF" onClick={() => {
              void setSetting('nightLock', 'true')
              toastIt('已生效：深夜防护已开启（22:00-06:00 购物记账二次确认）')
            }}>
              🔒 开启深夜防护
            </ActionBtn>
            {(weekF.impulseCount > 0 || weekF.topScene) && (
              <ActionBtn color="#F59E0B" onClick={() => {
                // 取最高频场景里的平台（如"深夜拼多多" → 拼多多），兜底拼多多
                const m = (weekF.topScene?.scene ?? '').match(/(拼多多|京东|淘宝|抖音|美团)/)
                const platform = m ? m[1] : '拼多多'
                void setSetting('platformLock', JSON.stringify({ platform, after: 23 }))
                toastIt(`已生效：${platform} 23 点后记账会先冷静确认`)
              }}>
                🌙 把{((weekF.topScene?.scene ?? '').match(/(拼多多|京东|淘宝|抖音|美团)/)?.[1]) || '拼多多'}加入 23 点后冷静清单
              </ActionBtn>
            )}
          </div>
        </div>
      </>
    )
  }

  // ==================== 每月复盘（5 分区） ====================
  function monthSection() {
    if (!monthF) return <LoadingBox text="正在统计本月数据…" />
    // 下月预算建议（本地算好注入，供按钮真实写入）
    const suggestedBudgetYuan = monthF.monthExpense > 0
      ? Math.max(100, Math.round((monthF.monthExpense * 0.9) / 100) * 100)
      : monthF.budget
    const savingsRate = monthF.income > 0
      ? Math.round((monthF.savings / monthF.income) * 100)
      : (monthF.budget > 0 ? Math.round((monthF.savings / monthF.budget) * 100) : 0)
    const anomaly = monthF.categoryDetail
      .filter(c => c.lastAmount > 0 && c.amount > c.lastAmount)
      .sort((a, b) => (b.amount - b.lastAmount) - (a.amount - a.lastAmount))[0]

    const goalMilestones = monthF.savingsGoal && monthF.savingsGoal.target > 0
      ? monthF.savingsGoal.target * 0.25 < 50 ? [] : [25, 50, 75]
      : []

    return (
      <>
        {/* ===== 第1屏 · 月度总览 ===== */}
        <div className="card" style={{ padding: 16 }}>
          <SectionTitle>① 月度总览</SectionTitle>
          <KpiRow kpis={[
            { label: '总支出', value: fmtY(monthF.monthExpense), sub: (monthF.expenseDeltaPct ?? 0) === 0 ? (monthF.expenseDeltaPct === null ? '较上月 —' : '较上月 持平') : `较上月 ${(monthF.expenseDeltaPct ?? 0) > 0 ? '+' : ''}${monthF.expenseDeltaPct}% ${(monthF.expenseDeltaPct ?? 0) > 0 ? '↑' : '↓'}`, color: (monthF.expenseDeltaPct ?? 0) > 0 ? '#F59E0B' : '#111111' },
            { label: '总收入', value: fmtY(monthF.income) },
            { label: '净储蓄', value: fmtY(monthF.savings), color: monthF.savings < 0 ? '#F43F5E' : '#0040FF' },
            { label: '储蓄率', value: `${savingsRate}%`, sub: `预算 ${fmtY(monthF.budget)} · 已用 ${monthF.budgetUsedPct}%`, color: savingsRate >= 25 ? '#059669' : '#D97706' },
          ]} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginTop: 16, flexWrap: 'wrap' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 44, fontWeight: 800, color: monthF.healthScore >= 70 ? '#059669' : monthF.healthScore >= 45 ? '#D97706' : '#E11D48', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{monthF.healthScore}</div>
              <div style={{ fontSize: 11, color: '#A0A4A4', marginTop: 4 }}>财务健康分</div>
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <HealthBars dims={monthF.healthDims} />
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, color: '#888888', marginBottom: 6 }}>支出 vs 收入（近 12 个月）</div>
            <MonthTrendLine data={monthF.trend12} />
          </div>
        </div>

        {/* ===== 第2屏 · 支出去哪了 ===== */}
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <SectionTitle>② 支出去哪了</SectionTitle>
          <CategoryRing data={monthF.categoryDetail.map(c => ({ name: c.category, amount: c.amount }))} centerTitle="本月总支出" centerValue={fmtY(monthF.monthExpense)} height={205} />
          <div style={{ marginTop: 14 }}>
            <CategoryStackChart stack={monthF.categoryDetail.map(c => ({ category: c.category, thisWeek: c.amount, lastWeek: c.lastAmount }))} />
          </div>
          {anomaly && (
            <div style={{ marginTop: 12, padding: '10px 14px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 10, fontSize: 13, color: '#92400E' }}>
              ⚠️ 异常项高亮：「{anomaly.category}」本月比上月多花 {fmtY(anomaly.amount - anomaly.lastAmount)}（+{Math.round(((anomaly.amount - anomaly.lastAmount) / anomaly.lastAmount) * 100)}%），是增幅最大的分类
            </div>
          )}
        </div>

        {/* ===== 第3屏 · 储蓄与负债 ===== */}
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <SectionTitle>③ 储蓄与负债</SectionTitle>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
            {monthF.savingsGoal ? (
              <>
                <RingPct pct={monthF.savingsGoal.pct ?? 0} label="目标进度" milestones={goalMilestones} />
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111111' }}>{monthF.savingsGoal.name}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#0040FF', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtY(monthF.savingsGoal.current)} <span style={{ fontSize: 12, color: '#A0A4A4', fontWeight: 400 }}>/ {fmtY(monthF.savingsGoal.target)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#A0A4A4', marginTop: 6 }}>
                    本月储蓄 {fmtY(monthF.savings)} · 储蓄率 {savingsRate}%（目标 25%）{savingsRate >= 25 ? ' ✓' : ' · 还需加油'}
                  </div>
                </div>
              </>
            ) : (
              <EmptyBox text="还没有储蓄目标，先到首页存第一笔吧" />
            )}
          </div>
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, color: '#888888', marginBottom: 6 }}>负债 burn-down（近 12 个月，估算：当前负债 + 回溯月还款）</div>
            <DebtBurnDown data={monthF.debtTrend12} />
            <div style={{ fontSize: 12, color: '#A0A4A4', marginTop: 6 }}>
              当前负债合计 {fmtY(monthF.debtTotal)}（{monthF.debtCount} 笔）{monthF.debtDelta !== 0 && ` · 较上月${monthF.debtDelta < 0 ? '减少' : '增加'} ${fmtY(Math.abs(monthF.debtDelta))}`}
            </div>
          </div>
        </div>

        {/* ===== 第4屏 · 风险体检 ===== */}
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <SectionTitle right={monthF.subscriptionMonthly > 0 ? <span style={{ fontSize: 12, color: '#F59E0B', fontWeight: 600 }}>订阅月成本合计 {fmtY(monthF.subscriptionMonthly)}</span> : undefined}>
            ④ 风险体检
          </SectionTitle>
          {monthF.recurringDeductions.length === 0 && monthF.installmentCount === 0 && monthF.subscriptionMonthly <= 0 ? (
            <EmptyBox text="体检通过：近 3 个月未发现重复扣费 / 分期 / 订阅，财务状况干净 ✨" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* 自动扣费清单 */}
              {monthF.recurringDeductions.length > 0 && (
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: '#888888', marginBottom: 8 }}>自动扣费清单（近 3 个月重复扣款）</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {monthF.recurringDeductions.slice(0, 6).map(r => (
                      <div key={r.merchant + r.amount} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', background: '#E4E6E6', borderRadius: 10 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#111111' }}>{r.merchant}</div>
                          <div style={{ fontSize: 11, color: '#A0A4A4', marginTop: 1 }}>
                            {fmtY(r.amount)}/月 · 持续 {r.months} 个月
                            {r.suspicious && <span style={{ color: '#D97706', fontWeight: 600 }}> · 疑似闲置</span>}
                          </div>
                        </div>
                        <ActionBtn color="#E11D48" onClick={() => handleCancelSub(r.merchant, r.amount)}>取消此订阅</ActionBtn>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* 分期 / 先用后付 */}
              {monthF.installmentCount > 0 && (
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: '#888888', marginBottom: 8 }}>
                    分期 / 先用后付本月合计：<b style={{ color: '#E11D48', fontSize: 14 }}>{fmtY(monthF.installmentTotal)}</b>（{monthF.installmentCount} 笔）
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {monthF.installmentTxs.slice(0, 5).map((t, i) => (
                      <div key={i} style={{ fontSize: 12.5, color: '#374151', padding: '7px 12px', background: '#FEF2F2', borderRadius: 8 }}>
                        {t.merchant} · {fmtY(t.amount)} · {t.paymentMethod} · {t.time}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {monthF.subscriptionMonthly <= 0 && monthF.recurringDeductions.length === 0 && monthF.installmentCount === 0 && (
                <EmptyBox text="未检测到自动扣费 / 分期 / 订阅记录" />
              )}
            </div>
          )}
        </div>

        {/* ===== 第5屏 · AI 解读与下月计划 ===== */}
        <div className="card" style={{ padding: 16, marginTop: 12, background: 'linear-gradient(135deg,#EEF2FF,#F0F9FF)' }}>
          <SectionTitle>⑤ AI 解读与下月计划</SectionTitle>
          <div style={{ fontSize: 13, color: '#888888', marginBottom: 12, lineHeight: 1.8 }}>
            <div>本月支出 <b style={{ color: '#111111' }}>{fmtY(monthF.monthExpense)}</b>，预算 <b style={{ color: '#111111' }}>{fmtY(monthF.budget)}</b>，执行率 {monthF.budgetUsedPct}%。</div>
            <div>
              建议下月预算设为 <b style={{ color: '#0040FF', fontSize: 16 }}>{fmtY(suggestedBudgetYuan)}</b>
              {monthF.monthExpense > monthF.budget && '（本月超支，先压 10% 守住红线）'}
              {monthF.monthExpense <= monthF.budget && '（较本月预算下调 10%，向储蓄目标靠拢）'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <ActionBtn color="#0040FF" onClick={() => {
              void setSetting('monthlyBudget', Math.round(suggestedBudgetYuan * 100))
              toastIt(`已生效：下月预算已设为 ${fmtY(suggestedBudgetYuan)}`)
            }}>
              💾 应用下月预算建议
            </ActionBtn>
            {monthF.savingsGoal && (
              editingGoal ? (
                <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                  <input autoFocus value={goalInput} onChange={e => setGoalInput(e.target.value.replace(/[^\d.]/g, ''))}
                    placeholder={`当前目标 ${monthF.savingsGoal.target}`}
                    style={{ width: 110, padding: '8px 10px', borderRadius: 8, border: '1px solid #C7D2FE', fontSize: 13, fontFamily: 'var(--font-stack)' }} />
                  <ActionBtn color="#059669" onClick={() => {
                    const yuanVal = Math.max(0, parseFloat(goalInput) || (monthF.savingsGoal?.target ?? 0))
                    void (async () => {
                      const goals = await db.savingsGoals.toArray()
                      const g = goals.find(x => x.isActive) ?? goals[0]
                      if (g) await updateSavingsGoal(g.id, { targetMinor: Math.round(yuanVal * 100) })
                      await refreshFacts('month')
                    })()
                    setEditingGoal(false)
                    toastIt(`已生效：储蓄目标已调整为 ${fmtY(yuanVal)}`)
                  }}>保存</ActionBtn>
                  <ActionBtn color="#A0A4A4" onClick={() => setEditingGoal(false)}>取消</ActionBtn>
                </span>
              ) : (
                <ActionBtn color="#06B6D4" onClick={() => { setEditingGoal(true); setGoalInput(String(monthF.savingsGoal?.target ?? '')) }}>
                  🎯 调整储蓄目标
                </ActionBtn>
              )
            )}
          </div>
        </div>
      </>
    )
  }

  // ==================== 可执行动作 ====================
  async function handleCancelSub(merchant: string, amount: number) {
    const scheds = await db.schedules.toArray()
    const matches = scheds.filter(s =>
      s.type === 'subscription' &&
      (s.name.includes(merchant) || Math.abs(s.amountMinor - Math.round(amount * 100)) < 1))
    if (matches.length > 0) {
      for (const s of matches) await deleteSchedule(s.id)
      await refreshFacts('month')
      toastIt(`已生效：已取消订阅「${matches.map(m => m.name).join('、')}」`)
    } else {
      toastIt(`未找到「${merchant}」对应的订阅日程，可在首页扣费日历手动删除`)
    }
  }

  return (
    <div style={{ maxWidth: 1100, width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 4, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--color-text)', marginBottom: 2 }}>AI 报告</h1>
          <p style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>图表先说 → 数字支撑 → AI 解读 → 给出判断 → 一键行动 · 数据由本地代码从数据库算出</p>
        </div>
      </div>

      {/* 两栏布局：左 2/3 报告 · 右 1/3 概览/用量/快捷操作 */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: isWide ? '2fr 1fr' : '1fr',
        gap: 24,
        alignItems: 'start',
        marginTop: 16,
      }}>
        {/* ========== 左栏：Tab + 生成 + 报告内容 ========== */}
        <div style={{ minWidth: 0 }}>
          {/* Tab */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
            {TABS.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 999, fontSize: 14, fontWeight: 600, cursor: 'pointer',
                  fontFamily: 'var(--font-stack)', transition: 'all 0.15s',
                  background: tab === t.key ? '#0040FF' : '#fff',
                  color: tab === t.key ? '#fff' : 'var(--color-text-secondary)',
                  boxShadow: tab === t.key ? '0 4px 12px rgba(0,64,255,0.3)' : 'none',
                  border: tab === t.key ? 'none' : '1px solid #C0C4C4',
                }}>
                {t.label}
              </button>
            ))}
          </div>

          {error && (
            <div style={{ padding: '12px 16px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, fontSize: 13, color: '#B91C1C', marginBottom: 16 }}>
              ⚠️ {error}
            </div>
          )}

          {/* 生成按钮 + 缓存提示 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            {loopSum[tab]?.date === todayStr() ? (
              <>
                <span style={{
                  padding: '10px 22px', borderRadius: 10, fontSize: 14, fontWeight: 600,
                  background: '#10B98114', color: '#059669',
                }}>✓ 今日已生成</span>
                <button onClick={() => void runLoopAI(tab)} disabled={loopLoading !== null || loading !== null}
                  className="btn-primary" style={{ padding: '10px 22px', opacity: loopLoading ? 0.6 : 1 }}>
                  {loopLoading === tab ? '⏳ AI 自主分析中…' : '🔄 重新生成'}
                </button>
                <span style={{ fontSize: 12, color: '#F59E0B' }}>AI 自主循环生成，可随时重新生成</span>
              </>
            ) : (
              <button onClick={() => void runLoopAI(tab)} disabled={loopLoading !== null || loading !== null}
                className="btn-primary" style={{ padding: '10px 26px', opacity: loopLoading ? 0.6 : 1 }}>
                {loopLoading === tab ? '⏳ AI 正在自主查数据并分析…' : '✨ 生成 AI 总结'}
              </button>
            )}
            {notice && <span style={{ fontSize: 12, color: '#A0A4A4' }}>{notice}</span>}
          </div>

          {/* 图表区（facts 实时计算，先于 AI 文字） */}
          {factsLoading || loading === tab ? (
            <LoadingBox text={loading === tab ? 'AI 正在整理你的财务数据…' : '正在统计数据…'} />
          ) : (
            <>
              {tab === 'day' && daySection()}
              {tab === 'week' && weekSection()}
              {tab === 'month' && monthSection()}
            </>
          )}

          {/* AI 分析总结（自主循环 Agent 生成，HTML；失败降级为旧文本报告） */}
          <div className="card" style={{ padding: 24, marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#111111' }}>
                🤖 AI 分析总结
                {loopSum[tab] && <span style={{ fontSize: 13, color: '#A0A4A4', fontWeight: 400, marginLeft: 8 }}>{loopSum[tab].date}</span>}
              </div>
              {loopLoading === tab && <span style={{ fontSize: 12, color: '#888888' }}>AI 正在自主查数据并分析…（无需操作）</span>}
            </div>
            {loopLoading === tab ? (
              <LoadingBox text="AI 正在自主查数据并分析你的消费…" />
            ) : loopSum[tab]?.html ? (
              <>
                <AiHtml html={loopSum[tab].html} onAction={(a) => handleLoopAction(a)} />
                <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px dashed #C0C4C4', fontSize: 12, color: '#A0A4A4' }}>
                  🤖 自主循环查询了 {loopSum[tab].toolCount} 次真实数据 · 数字均由本地代码计算，AI 只组织语言
                  {(loopSum[tab].guardIssues ?? 0) === 0
                    ? ' · ✅ 事实核查通过（金额/商家/笔数与真实数据一致）'
                    : ` · ⚠️ 事实核查标注 ${loopSum[tab].guardIssues} 处未核实信息（黄色 ⚠ 标记处请以实际记账为准）`}
                </div>
              </>
            ) : current ? (
              <>
                {hasRichBlock(current.text)
                  ? <RichMessage content={current.text} />
                  : isHtmlContent(current.text)
                    ? <AiHtml html={current.text} />
                    : <Markdown md={current.text} />}
                <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px dashed #C0C4C4', fontSize: 12, color: '#A0A4A4' }}>
                  本报告基于你 {current.totalCount} 条真实记录生成 · 数字均由本地计算，AI 只负责组织语言
                </div>
              </>
            ) : (
              <div style={{ textAlign: 'center', padding: '30px 0', color: '#888888', fontSize: 13, lineHeight: 2 }}>
                点击上方「✨ 生成 AI 总结」，AI 将自主查数据、分析并输出总结
                <br />（需先在设置页配置 API Key）
              </div>
            )}
          </div>

          {/* 报告生成后的交互式复盘：AI 基于报告数据继续提问，逐层深入，要点存入画像 */}
          {(loopSum[tab] || current) && !loopLoading && loading !== tab && (
            <ReportCoachChat
              key={`${tab}-${loopSum[tab]?.date ?? current?.date}`}
              label={PERIOD_LABEL[tab]}
              snapshot={reportSnapshotText(tab)}
              onOpenAssistant={() => window.dispatchEvent(new CustomEvent('ai-chat-open'))}
            />
          )}

          {/* 情绪-消费分析（周报/月报附带） */}
          {tab !== 'day' && <MoodAnalysis mode={tab} />}
        </div>

        {/* ========== 右栏：今日快速概览 / AI 用量 / 快捷操作 ========== */}
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* 今日快速概览 */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text)', marginBottom: 12 }}>⚡ 今日快速概览</div>
            {dayF ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <OverviewRow label="今日支出" value={fmtY(dayF.todayExpense)} sub={`${dayF.todayCount} 笔`} />
                <OverviewRow label="预算剩余" value={fmtY(Math.max(0, dayF.remaining))} color={dayF.remaining < 0 ? '#F43F5E' : '#0040FF'} />
                <OverviewRow label="今日冲动笔数" value={`${dayF.impulseCount} 笔`} color={dayF.impulseCount > 0 ? '#F43F5E' : '#059669'} />
              </div>
            ) : (
              <div style={{ textAlign: 'center', color: '#A0A4A4', fontSize: 13, padding: '20px 0' }}>正在统计今日数据…</div>
            )}
          </div>

          {/* AI 使用情况 */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text)', marginBottom: 10 }}>🤖 AI 使用情况</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: 30, fontWeight: 800, color: aiCount > 0 ? '#0040FF' : '#A0A4A4', fontVariantNumeric: 'tabular-nums' }}>{aiCount}</span>
              <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>次 / 本月</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 8, lineHeight: 1.8 }}>
              包含报告生成、AI 问答、截图/语音记账解析，每次调用消耗你配置的模型账户额度
            </div>
          </div>

          {/* 快捷操作 */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text)', marginBottom: 12 }}>🚀 快捷操作</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <ActionBtn color="#0040FF" disabled={loopLoading !== null || loading !== null} onClick={() => { setTab('week'); void runLoopAI('week'); toastIt('周报自主分析中，完成后在「每周分析」查看') }}>
                📊 一键生成周报
              </ActionBtn>
              <ActionBtn color="#06B6D4" disabled={loopLoading !== null || loading !== null} onClick={() => { setTab('month'); void runLoopAI('month'); toastIt('月报自主分析中，完成后在「每月复盘」查看') }}>
                📈 一键生成月报
              </ActionBtn>
            </div>
          </div>
        </div>
      </div>

      {/* 下钻明细弹层 */}
      <TxSheet title={sheet?.title ?? ''} txs={sheet?.txs ?? []} onClose={() => setSheet(null)} />

      {/* 已生效 toast */}
      {toast && (
        <div style={{
          position: 'fixed', left: '50%', bottom: 32, transform: 'translateX(-50%)', zIndex: 1500,
          background: '#0040FF', color: '#fff', padding: '10px 20px', borderRadius: 999,
          fontSize: 13.5, fontWeight: 600, boxShadow: '0 8px 24px rgba(0,64,255,0.35)',
          animation: 'fadeInUp 0.25s ease both',
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}

function LoadingBox({ text }: { text: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '60px 0', color: '#A0A4A4', fontSize: 14 }}>
      <div style={{ fontSize: 30, marginBottom: 12 }}>⏳</div>
      {text}
    </div>
  )
}

/** 右栏概览行 */
function OverviewRow({ label, value, sub, color = '#111111' }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: '#E4E6E6', borderRadius: 10, border: '1px solid #EEF2FF' }}>
      <span style={{ fontSize: 12.5, color: '#888888' }}>{label}</span>
      <span style={{ fontSize: 16, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>
        {value}
        {sub && <span style={{ fontSize: 11, color: '#A0A4A4', fontWeight: 400, marginLeft: 4 }}>{sub}</span>}
      </span>
    </div>
  )
}

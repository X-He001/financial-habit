import { useState, useEffect, useMemo, useId, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LabelList,
} from 'recharts'
import { db } from '../db/database'
import type { Transaction, SavingsGoal, Category, Schedule, ConsumerEvent } from '../types'
import {
  addTransaction, addSavingsGoal, updateSavingsGoal,
  addSchedule, updateSchedule, deleteSchedule, setSetting, getSetting, addWishlistItem,
} from '../db/crud'
import DashboardCard from '../components/cards/DashboardCard'
import Markdown from '../components/Markdown'
import { generateImpulseAnalysis, hasApiKey, aiErrorMessage } from '../api/deepseek'
import { getImpulseFacts } from '../utils/aiFacts'
import { impulseTemplate, verifyAiNumbers } from '../utils/reportTemplates'
import { incrementAiCount } from '../utils/aiUsage'
import { isImpulsive, platformOf } from '../utils/impulseEngine'
import { ForecastBanner } from '../components/ReviewPanel'
import ProactiveBanner from '../components/ProactiveBanner'
import MoodSelector from '../components/MoodSelector'
import { computeFragileWindows, getFragileWindowNow } from '../agent/metrics'
import { submitPurchaseFeedback } from '../agent/profile'
import { getPendingFeedback } from '../agent/decisionEngine'
import { buildDebtSnapshot } from '../debt/debtContext'
import {
  SlotBarChart, CategoryRing, HBarList, StrengthBars, Heatmap, TxSheet, ActionBtn,
  type SlotRow, type TxItem, type HeatCell,
} from '../components/ReportVisuals'

// ==================== 常量 ====================

const DEFAULT_BUDGET_MINOR = 1000_00 // 默认本月预算 ¥1,000
const BUDGET_KEY = 'monthlyBudget'
const CHART_PALETTE = ['#0040FF', '#22D3EE', '#F59E0B', '#94AFFF', '#6B90FF', '#34D399', '#888888']
const CATEGORY_COLORS: Record<string, string> = {
  '餐饮': '#0040FF', '购物': '#22D3EE', '日用百货': '#6B90FF',
  '娱乐': '#94AFFF', '交通': '#F59E0B', '虚拟消费': '#10B981',
  '其他': '#888888',
}
const SCHEDULE_TYPE_COLOR: Record<Schedule['type'], string> = {
  subscription: '#F59E0B',
  debt: '#22D3EE',
  other: '#A0A4A4',
}
const SCHEDULE_TYPE_LABEL: Record<Schedule['type'], string> = {
  subscription: '续费',
  debt: '还款',
  other: '其他',
}
// 冲动等级颜色：低琥珀 / 中橙 / 高红 / 很高深红
const IMPULSE_LEVEL_COLOR: Record<Transaction['impulseLevel'], string> = {
  low: '#F59E0B', medium: '#FB923C', high: '#F43F5E', veryHigh: '#E11D48',
}
const IMPULSE_LEVEL_LABEL: Record<Transaction['impulseLevel'], string> = {
  low: '低', medium: '中', high: '高', veryHigh: '很高',
}
const SLOTS = ['凌晨', '上午', '下午', '晚上', '深夜']
const tooltipStyle: React.CSSProperties = {
  background: '#D8DADA', border: '1px solid #C0C4C4', borderRadius: 10, fontSize: 12,
  boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
}

// ==================== 工具函数 ====================

function fmt(minor: number): string {
  return '¥' + (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtS(minor: number): string {
  return '¥' + (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
function pad2(n: number): string { return String(n).padStart(2, '0') }
function dateKey(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
function monthKey(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}` }
function daysInMonth(y: number, m: number): number { return new Date(y, m + 1, 0).getDate() }
function monthKeyOffset(offset: number): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1 + offset)}`
}
function todayStr(): string { return dateKey(new Date()) }
function isIncome(tx: Transaction): boolean { return (tx as { txType?: string }).txType === 'income' }
// 储蓄转入记录（仅作记账展示，不参与消费统计）
function isTransfer(tx: Transaction): boolean { return tx.note === '储蓄转入' }
function remainingDays(): number {
  const now = new Date()
  return daysInMonth(now.getFullYear(), now.getMonth()) - now.getDate()
}
function slotOf(h: number): string {
  if (h < 6) return '凌晨'
  if (h < 12) return '上午'
  if (h < 18) return '下午'
  if (h < 22) return '晚上'
  return '深夜'
}
// 交易 → 下钻弹层条目（冲动指数标记为红字 extra）
function txToItem(tx: Transaction): TxItem {
  return {
    merchant: tx.merchant,
    amount: Math.round(tx.amountMinor / 100),
    sub: `${new Date(tx.time).toTimeString().slice(0, 5)} · ${tx.category} · ${tx.paymentMethod}`,
    extra: `冲动${tx.impulseScore}分`,
  }
}

// ==================== 小部件 ====================

function MiniProgress({ pct, color = '#0040FF', height = 6 }: { pct: number; color?: string; height?: number }) {
  return (
    <div style={{ height, background: '#E4E6E6', borderRadius: height / 2, overflow: 'hidden', width: '100%' }}>
      <div style={{
        height: '100%', width: `${Math.min(100, Math.max(0, pct))}%`, background: color,
        borderRadius: height / 2, transition: 'width 0.6s ease',
      }} />
    </div>
  )
}

function Ring({ pct, size = 80, strokeW = 6, fontSize = 16 }: { pct: number; size?: number; strokeW?: number; fontSize?: number }) {
  const gid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const r = (size - strokeW) / 2
  const circ = 2 * Math.PI * r
  const off = circ - (Math.min(100, Math.max(0, pct)) / 100) * circ
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <defs>
          <linearGradient id={`rg${gid}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#0040FF" /><stop offset="100%" stopColor="#22D3EE" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#C0C4C4" strokeWidth={strokeW} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#rg${gid})`} strokeWidth={strokeW}
          strokeDasharray={circ} strokeDashoffset={off} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 1s ease' }} />
      </svg>
      <span style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize, fontWeight: 700, color: '#111111', fontVariantNumeric: 'tabular-nums',
      }}>
        {Math.round(pct)}%
      </span>
    </div>
  )
}

/** 实时数字时钟（每秒跳动，蓝白规范） */
function LiveClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const p = (n: number) => String(n).padStart(2, '0')
  const text = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, color: '#0040FF', fontVariantNumeric: 'tabular-nums',
      background: '#E4E6E6', border: '1px solid #C0C4C4', borderRadius: 8, padding: '3px 10px',
      whiteSpace: 'nowrap', lineHeight: 1.6,
    }}>
      🕐 {text}
    </span>
  )
}

/** 首页"待反馈"区块：已买满30天、还没反馈的购买（去重 / 可忽略 / 三按钮） */
function FeedbackBlock() {
  const [items, setItems] = useState<ConsumerEvent[]>([])
  const [enabled, setEnabled] = useState(true)

  async function load() {
    const rawFlag = await getSetting('feedbackReminderEnabled')
    const on = rawFlag !== 'false'
    setEnabled(on)
    if (!on) { setItems([]); return }
    const rawIgnored = await getSetting('feedbackIgnored')
    let ignored = new Set<string>()
    if (typeof rawIgnored === 'string' && rawIgnored) {
      try {
        const arr = JSON.parse(rawIgnored)
        if (Array.isArray(arr)) ignored = new Set(arr.filter((x): x is string => typeof x === 'string'))
      } catch { /* 忽略损坏数据 */ }
    }
    const list = await getPendingFeedback(20)
    setItems(list.filter(e => !ignored.has(e.id)))
  }

  useEffect(() => {
    void load()
    const h = () => void load()
    window.addEventListener('dashboard-refresh', h)
    window.addEventListener('impulse-saved', h)
    return () => {
      window.removeEventListener('dashboard-refresh', h)
      window.removeEventListener('impulse-saved', h)
    }
  }, [])

  if (!enabled || items.length === 0) return null

  async function feedback(e: ConsumerEvent, usage: '经常' | '偶尔' | '不用') {
    await submitPurchaseFeedback(e.id, usage)
    void load()
  }

  async function ignore(e: ConsumerEvent) {
    const rawIgnored = await getSetting('feedbackIgnored')
    let arr: string[] = []
    if (typeof rawIgnored === 'string' && rawIgnored) {
      try {
        const parsed = JSON.parse(rawIgnored)
        if (Array.isArray(parsed)) arr = parsed.filter((x): x is string => typeof x === 'string')
      } catch { /* 忽略损坏数据 */ }
    }
    if (!arr.includes(e.id)) arr.push(e.id)
    await setSetting('feedbackIgnored', JSON.stringify(arr))
    void load()
  }

  return (
    <div style={{
      marginBottom: 16, background: '#E4E6E6', border: '1px solid rgba(245,158,11,0.2)',
      borderRadius: 12, padding: '12px 14px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 14 }}>🕐</span>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: '#f59e0b' }}>
          待反馈 · {items.length} 件已买满 30 天，用上了吗？
        </span>
        <span style={{ fontSize: 11, color: '#f59e0b', marginLeft: 'auto' }}>
          反馈后 AI 会记住你的真实感受
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map(e => (
          <div key={e.id} style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            background: '#D8DADA', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 10, padding: '7px 10px',
          }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#111111' }}>{e.product}</span>
              <span style={{ fontSize: 12, color: '#f59e0b', marginLeft: 8, fontVariantNumeric: 'tabular-nums' }}>
                ¥{(e.amountMinor / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}
              </span>
              <span style={{ fontSize: 11, color: '#888888', marginLeft: 8 }}>
                {new Date(e.time).getMonth() + 1}月{new Date(e.time).getDate()}日买
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {([['经常', '✅ 经常用'], ['偶尔', '🕐 偶尔用'], ['不用', '❌ 基本没用']] as const).map(([u, label]) => (
                <button key={u} onClick={() => void feedback(e, u)}
                  style={{
                    padding: '4px 10px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
                    border: '1px solid #C0C4C4', background: '#D8DADA', color: '#111111',
                    fontFamily: 'var(--font-stack)', whiteSpace: 'nowrap',
                  }}>
                  {label}
                </button>
              ))}
              <button onClick={() => void ignore(e)} title="不再提醒这条"
                style={{ background: 'none', border: 'none', color: '#888888', fontSize: 14, cursor: 'pointer', flexShrink: 0, lineHeight: 1 }}>
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ==================== 主组件 ====================

export default function Home() {
  const navigate = useNavigate()

  const [txs, setTxs] = useState<Transaction[]>([])
  const [goal, setGoal] = useState<SavingsGoal | null>(null)
  // 全部负债（旧自定义债务 + 花呗/白条等负债账户）已由 debtSnapshot 统一，供首页负债卡/三维分析联动
  const [creditDebt, setCreditDebt] = useState<{ totalMinor: number; items: { name: string; remainingMinor: number; realApr: number }[] }>({ totalMinor: 0, items: [] })
  const [categories, setCategories] = useState<Category[]>([])
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [monthlyBudget, setMonthlyBudget] = useState(DEFAULT_BUDGET_MINOR)
  // 复盘动作"下调明日额度"写入的明日预算覆盖（dailyLimitOverride = {amountMinor, date}）
  const [tomorrowLimit, setTomorrowLimit] = useState<{ amountMinor: number; date: string } | null>(null)
  // 最近净资产快照（余额卡入口用）
  const [netWorthMinor, setNetWorthMinor] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)

  const [expanded, setExpanded] = useState<string | null>(null)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [showBudgetForm, setShowBudgetForm] = useState(false)
  const [showSaveForm, setShowSaveForm] = useState(false)
  const [showGoalForm, setShowGoalForm] = useState(false)
  const [showReminder, setShowReminder] = useState(true)
  // 备份提醒："该备份了，上次备份在 X 天前"（7 天一次，可关闭）
  const [backupNotice, setBackupNotice] = useState<string | null>(null)
  // 首页高频冲动窗口温和提示（当前处于高频窗口时显示）
  const [fragileNow, setFragileNow] = useState<{ label: string; share: number } | null>(null)
  const [showFragileTip, setShowFragileTip] = useState(true)
  // 冲动 AI 解读
  const [aiImpulse, setAiImpulse] = useState<{ text: string } | null>(null)
  const [aiImpulseLoading, setAiImpulseLoading] = useState(false)
  // 下钻明细弹层 + "已生效"提示
  const [sheet, setSheet] = useState<{ title: string; txs: TxItem[] } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  function toastIt(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2600)
  }

  async function loadData() {
    const [t, g, c, s, budget, dailyOverrideRaw, snaps] = await Promise.all([
      db.transactions.toArray(), db.savingsGoals.toArray(),
      db.categories.toArray(), db.schedules.toArray(), getSetting(BUDGET_KEY),
      getSetting('dailyLimitOverride'), db.balanceSnapshots.toArray(),
    ])
    setTxs(t); setGoal(g.find(x => x.isActive) ?? g[0] ?? null)
    setCategories(c); setSchedules(s)
    if (typeof budget === 'number') setMonthlyBudget(budget)
    let dl: { amountMinor: number; date: string } | null = null
    if (typeof dailyOverrideRaw === 'string') {
      try {
        const p = JSON.parse(dailyOverrideRaw) as { amountMinor?: unknown; date?: unknown }
        if (p && typeof p.amountMinor === 'number' && typeof p.date === 'string') {
          dl = { amountMinor: p.amountMinor, date: p.date }
        }
      } catch { /* 忽略损坏数据 */ }
    }
    setTomorrowLimit(dl)
    // 新负债账户（花呗/白条/月付/先用后付/信用卡）待还，合并进首页负债口径
    const debtSnap = await buildDebtSnapshot()
    setCreditDebt({
      totalMinor: debtSnap.creditPrincipalMinor,
      items: debtSnap.accounts
        .filter(a => a.principalRemMinor > 0)
        .map(a => ({
          name: `${a.account.platform}${a.account.nickname && a.account.nickname !== a.account.platform ? '·' + a.account.nickname : ''}`,
          remainingMinor: a.principalRemMinor,
          realApr: a.realApr,
        })),
    })
    // 最近净资产快照（date 最大、同日取 createdAt 最新的）
    let latest: { date: string; assets: number; liability: number; createdAt: string } | null = null
    for (const s of snaps) {
      const assets = s.cashMinor + s.bankMinor + s.wechatMinor + s.alipayMinor + s.otherMinor
      if (!latest || s.date > latest.date || (s.date === latest.date && s.createdAt > latest.createdAt)) {
        latest = { date: s.date, assets, liability: s.liabilityMinor, createdAt: s.createdAt }
      }
    }
    setNetWorthMinor(latest ? latest.assets - latest.liability : null)
    setLoaded(true)
  }

  useEffect(() => { loadData() }, [])

  // 备份提醒：从未备份 → 提示先导出一份；距上次备份 ≥7 天 → 提示"该备份了"
  useEffect(() => {
    void (async () => {
      const raw = await getSetting('lastBackupAt')
      if (typeof raw === 'number' && raw > 0) {
        const days = Math.floor((Date.now() - raw) / 86_400_000)
        if (days >= 7) setBackupNotice(`该备份数据了，上次备份在 ${days} 天前`)
      } else {
        setBackupNotice('还没有备份过数据，建议先导出一份')
      }
    })()
  }, [])

  useEffect(() => {
    const handler = () => loadData()
    window.addEventListener('dashboard-refresh', handler)
    return () => window.removeEventListener('dashboard-refresh', handler)
  }, [])

  // 首页窗口提示：挂载时更新高频窗口数据，当前处于窗口内且开关开启 → 显示"你的老时间到了"
  useEffect(() => {
    void (async () => {
      await computeFragileWindows()
      const [win, flag] = await Promise.all([getFragileWindowNow(), getSetting('fragileReminder')])
      if (flag === 'false' || !win) return
      setFragileNow({ label: win.label, share: win.share })
    })()
  }, [])

  // ========== 预算模型统计 ==========

  const monthStats = useMemo(() => {
    const keys = [monthKeyOffset(-2), monthKeyOffset(-1), monthKeyOffset(0)]
    const map: Record<string, { expense: number; income: number }> = {}
    for (const k of keys) map[k] = { expense: 0, income: 0 }
    for (const tx of txs) {
      if (isTransfer(tx)) continue
      const k = monthKey(new Date(tx.time))
      if (!map[k]) map[k] = { expense: 0, income: 0 }
      if (isIncome(tx)) map[k].income += tx.amountMinor
      else map[k].expense += tx.amountMinor
    }
    const cur = map[keys[2]]
    const prev = map[keys[1]]
    return { keys, map, cur, prev }
  }, [txs])

  const curMonth = monthStats.keys[2]
  const thisMonthExpense = monthStats.cur.expense
  const prevExpense = monthStats.prev.expense
  const restDays = remainingDays()
  const remaining = monthlyBudget - thisMonthExpense
  const budgetRatio = monthlyBudget > 0 ? thisMonthExpense / monthlyBudget : 0
  const dailyBudget = restDays > 0 ? Math.max(0, remaining / restDays) : 0
  // 明日预算覆盖（复盘动作"下调明日额度"写入，仅对明天的日期生效）
  const tomorrowKey2 = (() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  })()
  const tomorrowOverride = tomorrowLimit && tomorrowLimit.date === tomorrowKey2 ? tomorrowLimit : null

  const thisMonthTxs = useMemo(() =>
    txs.filter(tx => !isIncome(tx) && !isTransfer(tx) && monthKey(new Date(tx.time)) === curMonth), [txs, curMonth])
  const lastMonthTxs = useMemo(() =>
    txs.filter(tx => !isIncome(tx) && !isTransfer(tx) && monthKey(new Date(tx.time)) === monthStats.keys[1]), [txs, monthStats])

  // 近 30 天每日支出
  const daily30Data = useMemo(() => {
    const map: Record<string, number> = {}
    const now = new Date()
    for (let back = 29; back >= 0; back--) {
      const d = new Date(now); d.setDate(d.getDate() - back)
      map[dateKey(d)] = 0
    }
    for (const tx of txs) {
      if (isIncome(tx) || isTransfer(tx)) continue
      const k = dateKey(new Date(tx.time))
      if (k in map) map[k] += tx.amountMinor
    }
    return Object.entries(map).map(([k, v]) => ({
      day: k.slice(5).replace('-', '/'), amount: Math.round(v / 100),
    }))
  }, [txs])

  // 消费分布（本月各分类）
  const pieData = useMemo(() => {
    const m: Record<string, number> = {}
    for (const tx of thisMonthTxs) m[tx.category] = (m[tx.category] || 0) + tx.amountMinor
    return Object.entries(m)
      .map(([name, v]) => ({ name, value: Math.round(v / 100) }))
      .sort((a, b) => b.value - a.value)
  }, [thisMonthTxs])

  // 支出分类对比（本月 vs 上月）
  const categoryCompareData = useMemo(() => {
    const sum = (arr: Transaction[]) => {
      const m: Record<string, number> = {}
      for (const tx of arr) m[tx.category] = (m[tx.category] || 0) + tx.amountMinor
      return m
    }
    const a = sum(thisMonthTxs); const b = sum(lastMonthTxs)
    const all = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]))
    return all.map(name => ({
      name,
      本月: Math.round((a[name] || 0) / 100),
      上月: Math.round((b[name] || 0) / 100),
    })).sort((x, y) => y.本月 - x.本月).slice(0, 6)
  }, [thisMonthTxs, lastMonthTxs])

  // ========== 冲动消费 ==========

  const impulseList = useMemo(() =>
    thisMonthTxs.filter(tx => isImpulsive(tx.impulseLevel)), [thisMonthTxs])
  const impulseTotal = useMemo(() => impulseList.reduce((s, tx) => s + tx.amountMinor, 0), [impulseList])
  const maxImpulse = useMemo(() => impulseList.reduce<Transaction | null>((a, b) => (a && a.amountMinor >= b.amountMinor) ? a : b, null), [impulseList])
  const avgScore = useMemo(() => Math.round(impulseList.reduce((s, tx) => s + tx.impulseScore, 0) / Math.max(1, impulseList.length)), [impulseList])

  // 本月每天冲动笔数（迷你条形图）
  const impulseDailyData = useMemo(() => {
    const now = new Date()
    const y = now.getFullYear(); const m = now.getMonth()
    const days = now.getDate()
    const arr = Array.from({ length: days }, (_, i) => ({ day: i + 1, n: 0 }))
    for (const tx of impulseList) {
      const d = new Date(tx.time)
      if (d.getFullYear() === y && d.getMonth() === m && d.getDate() <= days) arr[d.getDate() - 1].n++
    }
    return arr
  }, [impulseList])

  // ========== 冲动消费图表数据（全部本地计算） ==========

  // 冲动平台金额（横向条形图 + 金额占比环形图）
  const impulsePlatformAmounts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const tx of impulseList) {
      const p = platformOf(tx.merchant) ?? '其他'
      map[p] = (map[p] || 0) + tx.amountMinor
    }
    return Object.entries(map)
      .map(([name, amount]) => ({ name, amount: Math.round(amount / 100) }))
      .sort((a, b) => b.amount - a.amount)
  }, [impulseList])

  // 冲动强度分布（高/中/低三档笔数）
  const impulseStrength = useMemo(() => {
    let high = 0, medium = 0, low = 0
    for (const tx of impulseList) {
      if (tx.impulseLevel === 'veryHigh' || tx.impulseLevel === 'high') high++
      else if (tx.impulseLevel === 'medium') medium++
      else low++
    }
    return { high, medium, low }
  }, [impulseList])

  // 近30天冲动日历热力图（每天金额，颜色深浅=金额）
  const impulseHeat30 = useMemo(() => {
    const now = new Date()
    const arr: HeatCell[] = []
    for (let back = 29; back >= 0; back--) {
      const d = new Date(now); d.setDate(d.getDate() - back)
      arr.push({ date: `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`, amount: 0 })
    }
    const byDate: Record<string, number> = {}
    for (const tx of txs) {
      if (isIncome(tx) || isTransfer(tx) || !isImpulsive(tx.impulseLevel)) continue
      const d = new Date(tx.time)
      const diff = now.getTime() - d.getTime()
      if (diff < 0 || diff >= 30 * 86_400_000) continue
      const k = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
      byDate[k] = (byDate[k] || 0) + tx.amountMinor
    }
    return arr.map(c => ({ ...c, amount: Math.round((byDate[c.date] || 0) / 100) }))
  }, [txs])

  // 时段分布（金额+笔数，柱状图点击下钻）
  const impulseSlotRows = useMemo(() => {
    const base: SlotRow[] = SLOTS.map(name => ({ name, amount: 0, count: 0 }))
    for (const tx of impulseList) {
      const row = base.find(x => x.name === slotOf(new Date(tx.time).getHours()))
      if (row) { row.amount += Math.round(tx.amountMinor / 100); row.count++ }
    }
    return base
  }, [impulseList])

  // 近5次冲动记录（可执行按钮展开）
  const recentImpulseItems = useMemo(() =>
    [...impulseList]
      .sort((a, b) => (a.time < b.time ? 1 : -1))
      .slice(0, 5)
      .map(txToItem), [impulseList])

  // 热力图点击某天 → 当天冲动明细
  function openHeatDay(c: HeatCell) {
    const now = new Date()
    const list = txs.filter(tx => {
      if (isIncome(tx) || isTransfer(tx) || !isImpulsive(tx.impulseLevel)) return false
      const d = new Date(tx.time)
      const diff = now.getTime() - d.getTime()
      if (diff < 0 || diff >= 30 * 86_400_000) return false
      return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` === c.date
    }).map(txToItem)
    setSheet({ title: `${c.date} 冲动明细（${list.length} 笔）`, txs: list })
  }

  // ========== 记账天数 ==========

  const tracking = useMemo(() => {
    const now = new Date(); const y = now.getFullYear(); const m = now.getMonth()
    const todayD = now.getDate()
    const daySet = new Set<number>()
    for (const tx of txs) {
      if (isIncome(tx) || isTransfer(tx)) continue
      const d = new Date(tx.time)
      if (d.getFullYear() === y && d.getMonth() === m && d.getDate() <= 30) daySet.add(d.getDate())
    }
    const cells = Array.from({ length: 30 }, (_, i) => {
      const day = i + 1
      if (day > todayD || !daySet.has(day)) return { day, filled: false, color: '#E4E6E6' }
      let streak = 1
      for (let k = day - 1; k >= 1 && daySet.has(k); k--) streak++
      return { day, filled: true, color: streak === 1 ? '#888888' : streak === 2 ? '#818CF8' : streak === 3 ? '#6366F1' : '#0040FF' }
    })
    return { count: daySet.size, cells }
  }, [txs])

  // ========== 储蓄 ==========

  const savings30 = useMemo(() => {
    const now = new Date()
    let total = 0
    for (const tx of txs) {
      if (!isTransfer(tx)) continue
      const diff = now.getTime() - new Date(tx.time).getTime()
      if (diff >= 0 && diff < 30 * 86_400_000) total += tx.amountMinor
    }
    return total
  }, [txs])
  const avgDailySaving = savings30 / 30
  const estInfo = useMemo(() => {
    if (!goal) return null
    const remain = goal.targetMinor - goal.currentMinor
    if (remain <= 0) return { text: '已达成 🎉' }
    if (avgDailySaving <= 0) return { text: '点「＋存一笔」后估算达成日期' }
    const days = Math.ceil(remain / avgDailySaving)
    const d = new Date()
    d.setDate(d.getDate() + days)
    return { text: `预计 ${d.getFullYear()}年${d.getMonth() + 1}月达成 · 约 ${days} 天` }
  }, [goal, avgDailySaving])

  // ========== 负债 ==========

  const debtTotal = useMemo(() => creditDebt.totalMinor, [creditDebt])
  const payoffInfo = useMemo(() => {
    const now = new Date()
    return creditDebt.items.map(it => {
      const pay = Math.max(100_00, Math.round(it.remainingMinor / 6))
      const months = Math.max(1, Math.ceil(it.remainingMinor / pay))
      const zeroDate = new Date(now.getFullYear(), now.getMonth() + months, 1)
      return { key: 'credit-' + it.name, name: it.name, remainingMinor: it.remainingMinor, apr: it.realApr, pay, months, zeroDate }
    })
  }, [creditDebt])

  // 最近记录
  const recentTxs = useMemo(() =>
    [...txs].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 8), [txs])

  // ========== 扣费日程 ==========

  const todayDue = useMemo(() => {
    const t = new Date()
    return schedules.filter(s => {
      if (s.repeat === 'none') return s.date === todayStr()
      if (s.repeat === 'monthly') return new Date(s.date).getDate() === t.getDate()
      const d = new Date(s.date)
      return d.getMonth() === t.getMonth() && d.getDate() === t.getDate()
    })
  }, [schedules])

  const monthSchedules = useMemo(() => {
    const mk = curMonth
    return schedules.filter(s => {
      if (s.repeat === 'none') return s.date.startsWith(mk)
      if (s.repeat === 'monthly') return true
      return new Date(s.date).getFullYear() === new Date().getFullYear() &&
        (new Date(s.date).getMonth() + 1) === Number(mk.slice(5))
    })
  }, [schedules, curMonth])

  const monthDueTotal = useMemo(() => monthSchedules.reduce((s, x) => s + x.amountMinor, 0), [monthSchedules])
  // 本月还款（日程中 type=debt 的合计）
  const monthRepay = useMemo(() => monthSchedules.filter(s => s.type === 'debt').reduce((s, x) => s + x.amountMinor, 0), [monthSchedules])

  // ========== 三维综合分析（支出 / 储蓄 / 负债） ==========

  // 本月收入（用于负债收入比，无收入时按预算算）
  const thisMonthIncome = useMemo(() =>
    txs.filter(tx => isIncome(tx) && monthKey(new Date(tx.time)) === curMonth).reduce((s, tx) => s + tx.amountMinor, 0),
  [txs, curMonth])

  // 储蓄 = 预算 − 支出；上月储蓄用本月预算作代理（不追踪预算历史）
  const savingsThis = remaining
  const prevSavings = monthlyBudget - prevExpense
  // 上月负债 = 本月负债 + 本月已还（估计上月末的欠款更高）
  const prevDebt = debtTotal + monthRepay
  const debtDelta = debtTotal - prevDebt
  const expenseDelta = thisMonthExpense - prevExpense
  const expenseDeltaPct = prevExpense > 0 ? Math.round((expenseDelta / prevExpense) * 100) : null
  const savingsDeltaPct = prevSavings !== 0 ? Math.round(((savingsThis - prevSavings) / Math.abs(prevSavings)) * 100) : null
  const debtDeltaPct = prevDebt > 0 ? Math.round((debtDelta / prevDebt) * 100) : null

  // 本月超上月最多的分类（超支归因）
  const topOverSpend = useMemo(() => {
    const sum = (arr: Transaction[]) => {
      const m: Record<string, number> = {}
      for (const tx of arr) m[tx.category] = (m[tx.category] || 0) + tx.amountMinor
      return m
    }
    const a = sum(thisMonthTxs); const b = sum(lastMonthTxs)
    let best: { name: string; delta: number } | null = null
    for (const [name, v] of Object.entries(a)) {
      const delta = v - (b[name] || 0)
      if (delta > (best?.delta ?? 0)) best = { name, delta }
    }
    return best && best.delta > 0 ? best : null
  }, [thisMonthTxs, lastMonthTxs])

  // 三维对比图数据（元）
  const threeDimData = [
    { name: '支出', 本月: Math.round(thisMonthExpense / 100), 上月: Math.round(prevExpense / 100) },
    { name: '储蓄', 本月: Math.round(savingsThis / 100), 上月: Math.round(prevSavings / 100) },
    { name: '负债', 本月: Math.round(debtTotal / 100), 上月: Math.round(prevDebt / 100) },
  ]

  const hasAnalysisData = thisMonthExpense > 0 || prevExpense > 0 || debtTotal > 0

  // 规则生成的结论（至少 3 条）
  const threeDimConclusions = useMemo(() => {
    const c: string[] = []
    if (savingsThis < 0) c.push(`⚠️ 本月支出超过了预算/结余，超支 ${fmtS(-savingsThis)}，下月注意控制`)
    else c.push(`💰 本月结余 ${fmtS(savingsThis)}，坚持住`)
    if (creditDebt.items.length === 0) c.push('🎉 零负债，保持住')
    else if (debtDelta > 0) c.push(`📈 负债较上月增加 ${fmtS(debtDelta)}，建议优先控制新增消费`)
    else if (debtDelta < 0) c.push(`📉 负债较上月减少 ${fmtS(-debtDelta)}，继续加油`)
    if (expenseDeltaPct === null) c.push('📊 上月暂无支出数据，记满整月后自动生成对比')
    else if (expenseDeltaPct > 0) c.push(`📊 支出较上月上升 ${expenseDeltaPct}%，主要超支分类是 ${topOverSpend?.name ?? '其他'}`)
    else if (expenseDeltaPct < 0) c.push(`📉 支出控制不错，较上月省了 ${fmtS(-expenseDelta)}`)
    else c.push('📊 支出与上月基本持平')
    return c.slice(0, 3)
  }, [savingsThis, creditDebt, debtDelta, expenseDeltaPct, expenseDelta, topOverSpend])

  const savingsRate = monthlyBudget > 0 ? Math.round((savingsThis / monthlyBudget) * 100) : 0
  const debtIncomeBase = thisMonthIncome > 0 ? thisMonthIncome : monthlyBudget
  const debtIncomeRatio = debtIncomeBase > 0 ? Math.round((debtTotal / debtIncomeBase) * 100) : 0

  // 日历圆点映射
  const dotMap = useMemo(() => {
    const now = new Date()
    const y = now.getFullYear(); const m = now.getMonth()
    const map: Record<string, Schedule['type'][]> = {}
    for (const s of schedules) {
      if (s.repeat === 'none') {
        const d = new Date(s.date + 'T00:00:00')
        if (d.getFullYear() === y && d.getMonth() === m) {
          (map[s.date] = map[s.date] || []).push(s.type)
        }
      } else if (s.repeat === 'monthly') {
        const day = new Date(s.date).getDate()
        const k = dateKey(new Date(y, m, day))
        if (new Date(y, m, day).getMonth() === m) (map[k] = map[k] || []).push(s.type)
      } else {
        const sd = new Date(s.date)
        if (sd.getMonth() === m) {
          const k = dateKey(new Date(y, m, sd.getDate()))
          ;(map[k] = map[k] || []).push(s.type)
        }
      }
    }
    return map
  }, [schedules])

  const selectedDaySchedules = useMemo(() => {
    if (!selectedDay) return []
    const sd = new Date(selectedDay + 'T00:00:00')
    return schedules.filter(s => {
      if (s.repeat === 'none') return s.date === selectedDay
      const d = new Date(s.date)
      if (s.repeat === 'monthly') return d.getDate() === sd.getDate()
      return d.getMonth() === sd.getMonth() && d.getDate() === sd.getDate()
    })
  }, [selectedDay, schedules])

  // ========== 操作 ==========

  // 冲动消费 AI 解读（代码算数 → AI 组织语言 → 校验降级）
  async function handleAiImpulse() {
    if (aiImpulseLoading) return
    const ok = await hasApiKey()
    if (!ok) {
      setAiImpulse({ text: '⚠️ 请先到设置页配置 API Key，才能使用 AI 解读' })
      return
    }
    setAiImpulseLoading(true)
    setAiImpulse(null)
    try {
      const facts = await getImpulseFacts()
      let text = ''
      // 发起 AI 请求即计一次调用
      await incrementAiCount()
      try {
        text = await generateImpulseAnalysis(facts)
        if (!verifyAiNumbers(text, facts)) text = impulseTemplate(facts)
      } catch (e) {
        text = impulseTemplate(facts)
        text += `\n\n（AI 解读失败：${aiErrorMessage(e)}，已展示本地计算结果）`
      }
      setAiImpulse({ text })
    } finally {
      setAiImpulseLoading(false)
    }
  }
  async function handleSetBudget(minor: number) {
    await setSetting(BUDGET_KEY, minor)
    setMonthlyBudget(minor)
    setShowBudgetForm(false)
  }
  async function handleSaveMoney(minor: number) {
    if (minor <= 0) return
    if (goal) {
      await updateSavingsGoal(goal.id, { currentMinor: goal.currentMinor + minor })
    } else {
      await addSavingsGoal({
        name: '我的储蓄目标', reason: '', image: null,
        targetMinor: 1000_00, currentMinor: minor,
        milestones: [100_00, 300_00, 500_00, 1000_00],
        deadline: null, isActive: true, revokedContributionsMinor: 0,
      })
    }
    await addTransaction({
      txType: 'expense', amountMinor: minor, category: '储蓄', merchant: '储蓄转入',
      time: new Date().toISOString(), paymentMethod: '银行卡', source: 'manual',
      impulseScore: 0, impulseLevel: 'low', isRevoked: false, revokedAt: null,
      regretValue: null, regretAt: null, importId: null, note: '储蓄转入', screenshot: null,
    })
    window.dispatchEvent(new CustomEvent('dashboard-refresh'))
    await loadData()
    setShowSaveForm(false)
  }
  async function handleAddSavingsGoal(data: { name: string; targetMinor: number; deadline: string | null; reason: string }) {
    // 里程碑 = 目标金额的 25%/50%/75%/100% 分档
    const milestones = [25, 50, 75, 100]
      .map(p => Math.round(data.targetMinor * p / 100))
      .filter((m, i, arr) => m > 0 && arr.indexOf(m) === i)
    await addSavingsGoal({
      name: data.name, reason: data.reason, image: null,
      targetMinor: data.targetMinor, currentMinor: 0,
      milestones, deadline: data.deadline, isActive: true, revokedContributionsMinor: 0,
    })
    window.dispatchEvent(new CustomEvent('dashboard-refresh'))
    await loadData()
    setShowGoalForm(false)
    toastIt('储蓄目标已创建，去存第一笔吧')
  }
  async function handleAddSchedule(data: Omit<Schedule, 'id' | 'notified'>) {
    await addSchedule({ ...data, notified: false })
    await loadData()
    setShowAddForm(false)
  }
  async function handleCompleteSchedule(id: string) {
    await updateSchedule(id, { notified: true })
    await loadData()
  }
  async function handleDeleteSchedule(id: string) {
    await deleteSchedule(id)
    await loadData()
  }

  // ========== 卡片内容（large=全屏更大） ==========

  function budgetCard(large: boolean) {
    const over = remaining < 0
    return (
      <DashboardCard title="本月预算" onExpand={() => setExpanded('budget')}>
        <div style={{ fontVariantNumeric: 'tabular-nums' }}>
          <div onClick={() => setShowBudgetForm(true)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
            fontSize: 13, fontWeight: 500, color: '#0040FF', marginBottom: 10,
          }}>
            <span>本月预算 {fmtS(monthlyBudget)}</span><span style={{ fontSize: 11 }}>▸</span>
          </div>
          <div style={{ fontSize: large ? 52 : 36, fontWeight: 700, color: over ? '#DC2626' : '#0040FF', lineHeight: 1.2 }}>
            {fmtS(remaining)}
          </div>
          <div style={{ fontSize: 12, color: '#888888', marginTop: 2 }}>本月剩余 = 预算 − 已支出</div>
          <div style={{ display: 'flex', gap: large ? 20 : 12, marginTop: large ? 14 : 10, fontSize: 13, flexWrap: 'wrap' }}>
            <span style={{ color: '#888888' }}>本月已支出 <b style={{ color: '#111111' }}>{fmtS(thisMonthExpense)}</b> −</span>
            <span style={{ color: '#888888' }}>本月待扣费 <b style={{ color: '#F59E0B' }}>{fmtS(monthDueTotal)}</b></span>
          </div>
          <div style={{ marginTop: large ? 12 : 10, fontSize: 13, color: '#888888' }}>
            本月还剩 <b style={{ color: '#111111' }}>{restDays}</b> 天 · 日均可花{' '}
            <b style={{ color: '#0040FF' }}>{fmtS(Math.round(dailyBudget))}</b>
          </div>
          <div style={{ marginTop: 4, fontSize: 13, color: '#888888' }}>
            明日可花{' '}
            {tomorrowOverride ? (
              <>
                <b style={{ color: '#F59E0B' }}>{fmtS(tomorrowOverride.amountMinor)}</b>{' '}
                <span style={{ fontSize: 11, color: '#888888' }}>（复盘时已下调）</span>
              </>
            ) : (
              <b style={{ color: '#0040FF' }}>{fmtS(Math.round(dailyBudget))}</b>
            )}
          </div>
          <div style={{ marginTop: 12, fontSize: 12, color: '#888888', marginBottom: 4 }}>
            预算消耗 {Math.min(100, Math.round(budgetRatio * 100))}%
          </div>
          <div style={{ height: 10, background: '#E4E6E6', borderRadius: 5, overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${Math.min(100, budgetRatio * 100)}%`, borderRadius: 5,
              background: over ? 'linear-gradient(90deg,#F43F5E,#DC2626)' : 'linear-gradient(90deg,#0040FF,#22D3EE)',
              transition: 'width 0.6s ease',
            }} />
          </div>
        </div>
        {/* 净资产入口（本月余额卡下方） */}
        {netWorthMinor !== null && (
          <button onClick={() => navigate('/networth')}
            style={{
              marginTop: 12, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '9px 12px', borderRadius: 10, border: '1px dashed #C0C4C4', background: '#E4E6E6',
              fontSize: 12.5, color: '#0040FF', cursor: 'pointer', fontFamily: 'var(--font-stack)',
            }}>
            <span>净资产 <b style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>{fmtS(netWorthMinor)}</b></span>
            <span style={{ fontSize: 12 }}>▸</span>
          </button>
        )}
      </DashboardCard>
    )
  }

  function impulseMiniCard(large: boolean) {
    const hasImpulse = impulseDailyData.some(d => d.n > 0)
    return (
      <DashboardCard title="冲动消费" onExpand={() => setExpanded('impulseAnalysis')}>
        <div style={{ fontVariantNumeric: 'tabular-nums' }}>
          <div style={{ fontSize: large ? 36 : 26, fontWeight: 700, color: '#0040FF', lineHeight: 1.1 }}>
            {impulseList.length}<span style={{ fontSize: 13, color: '#888888', fontWeight: 400 }}> 笔</span>
          </div>
          <div style={{ fontSize: 12, color: '#888888', marginTop: 2 }}>本月冲动消费（中/高）</div>
          <div style={{ fontSize: 13, marginTop: 8, color: '#888888' }}>冲动总额 <b style={{ color: '#0040FF' }}>{fmtS(impulseTotal)}</b></div>
          {hasImpulse ? (
            <ResponsiveContainer width="100%" height={large ? 140 : 78}>
              <BarChart data={impulseDailyData} margin={{ top: 6, right: 0, left: 0, bottom: 0 }}>
                <XAxis dataKey="day" hide />
                <YAxis hide allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${v} 笔`, '冲动']} />
                <Bar dataKey="n" fill="#FB923C" radius={[2, 2, 0, 0]} maxBarSize={6} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ fontSize: 12, color: '#888888', padding: '14px 0' }}>🎉 本月没有冲动消费</div>
          )}
        </div>
      </DashboardCard>
    )
  }

  function debtMiniCard(large: boolean) {
    return (
      <DashboardCard title="负债余额" onExpand={() => setExpanded('payoff')}>
        {creditDebt.items.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '28px 0', fontSize: 14, color: '#888888' }}>🎉 零负债</div>
        ) : (
          <div style={{ fontVariantNumeric: 'tabular-nums' }}>
            <div style={{ fontSize: large ? 36 : 26, fontWeight: 700, color: '#22D3EE', lineHeight: 1.1 }}>{fmtS(debtTotal)}</div>
            <div style={{ fontSize: 12, color: '#888888', marginTop: 2 }}>总负债</div>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {payoffInfo.map(r => (
                <div key={r.key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#888888' }}>
                  <span>{r.name}</span>
                  <b style={{ color: '#111111' }}>{fmtS(r.remainingMinor)}</b>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: '#888888' }}>
              本月还款 <b style={{ color: '#22D3EE' }}>{fmtS(monthRepay)}</b>
            </div>
          </div>
        )}
      </DashboardCard>
    )
  }

  function trackingCard(large: boolean) {
    return (
      <DashboardCard title="记账天数" onExpand={() => setExpanded('tracking')}>
        <div style={{ fontVariantNumeric: 'tabular-nums' }}>
          <div style={{ fontSize: large ? 36 : 26, fontWeight: 700, color: '#0040FF', lineHeight: 1.1 }}>
            {tracking.count}<span style={{ fontSize: 13, color: '#888888', fontWeight: 400 }}>/30 天</span>
          </div>
          <div style={{ fontSize: 12, color: '#888888', marginTop: 2 }}>本月记账天数</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(15, 1fr)', gap: 3, marginTop: 10 }}>
            {tracking.cells.map(c => (
              <div key={c.day} title={`${c.day}日`}
                style={{ height: large ? 14 : 10, borderRadius: 3, background: c.color }} />
            ))}
          </div>
          <div style={{ fontSize: 11, color: '#888888', marginTop: 6 }}>有记账的格子为靛蓝，连续记账颜色渐深</div>
        </div>
        {/* 今日心情（记录情绪 → 报告页情绪分析 / Agent 关怀） */}
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed #C0C4C4' }}>
          <MoodSelector compact={!large} />
        </div>
      </DashboardCard>
    )
  }

  function dailyExpenseCard(large: boolean) {
    return (
      <DashboardCard title="近30天每日支出" onExpand={() => setExpanded('dailyExpense')}>
        {daily30Data.every(d => d.amount === 0) ? (
          <div style={{ textAlign: 'center', color: '#888888', fontSize: 13, padding: '36px 0' }}>还没有支出记录，去记一笔吧</div>
        ) : (
          <ResponsiveContainer width="100%" height={large ? 380 : 210}>
            <AreaChart data={daily30Data}>
              <defs>
                <linearGradient id="de" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0040FF" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="#0040FF" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#C0C4C4" />
              <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#888888' }} axisLine={false} tickLine={false} interval={4} />
              <YAxis tick={{ fontSize: 11, fill: '#888888' }} axisLine={false} tickLine={false} width={52}
                tickFormatter={(v) => Number(v).toLocaleString()} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => [fmt(Number(v) * 100), '支出']} />
              <Area type="monotone" dataKey="amount" stroke="#0040FF" strokeWidth={2} fill="url(#de)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </DashboardCard>
    )
  }

  function pieCard(large: boolean) {
    const total = pieData.reduce((s, d) => s + d.value, 0)
    const size = large ? 240 : 150
    return (
      <DashboardCard title="消费分布（本月）" onExpand={() => setExpanded('pie')}>
        {pieData.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#888888', fontSize: 13, padding: '36px 0' }}>本月还没有支出，去记一笔吧</div>
        ) : (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
              <ResponsiveContainer width="100%" height={size}>
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={size * 0.4} outerRadius={size * 0.47} paddingAngle={2}>
                    {pieData.map((d, i) => (
                      <Cell key={d.name} fill={CATEGORY_COLORS[d.name] || CHART_PALETTE[i % CHART_PALETTE.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} formatter={(v) => [fmt(Number(v) * 100), '']} />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <span style={{ fontSize: 11, color: '#888888' }}>本月总支出</span>
                <span style={{ fontSize: large ? 20 : 15, fontWeight: 700, color: '#111111', fontVariantNumeric: 'tabular-nums' }}>{fmtS(thisMonthExpense)}</span>
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {pieData.slice(0, 6).map((d, i) => (
                <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 3, background: CATEGORY_COLORS[d.name] || CHART_PALETTE[i % CHART_PALETTE.length], flexShrink: 0 }} />
                  <span style={{ color: '#111111', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                  <span style={{ color: '#111111', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtS(d.value * 100)}</span>
                  <span style={{ color: '#888888', fontVariantNumeric: 'tabular-nums', width: 38, textAlign: 'right' }}>
                    {total > 0 ? Math.round((d.value / total) * 100) : 0}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </DashboardCard>
    )
  }

  function categoryCompareCard(large: boolean) {
    return (
      <DashboardCard title="支出分类对比（本月 vs 上月）" onExpand={() => setExpanded('categoryCompare')}>
        {categoryCompareData.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#888888', fontSize: 13, padding: '36px 0' }}>还没有支出数据，记满整月后自动生成对比</div>
        ) : (
          <ResponsiveContainer width="100%" height={large ? 380 : 210}>
            <BarChart data={categoryCompareData} barGap={4} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#C0C4C4" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#888888' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#888888' }} axisLine={false} tickLine={false} width={48}
                tickFormatter={(v) => Number(v).toLocaleString()} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => ['¥' + Number(v), '']} />
              <Bar dataKey="本月" fill="#0040FF" radius={[5, 5, 0, 0]} maxBarSize={36}>
                <LabelList dataKey="本月" position="top" style={{ fontSize: 10, fill: '#0040FF', fontWeight: 600 }} />
              </Bar>
              <Bar dataKey="上月" fill="#C0C4C4" radius={[5, 5, 0, 0]} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </DashboardCard>
    )
  }

  // 环比文字：上升琥珀 / 下降青
  function deltaText(pct: number | null, extra?: string): React.ReactNode {
    if (pct === null) return <span style={{ color: '#888888' }}>较上月 —</span>
    if (pct >= 0) return <span style={{ color: '#F59E0B' }}>较上月 +{pct}% ↑{extra}</span>
    return <span style={{ color: '#22D3EE' }}>较上月 {pct}% ↓{extra}</span>
  }

  function threeDimCard(large: boolean) {
    return (
      <DashboardCard title="财务三维度综合分析" onExpand={() => setExpanded('threeDim')}>
        {!hasAnalysisData ? (
          <div style={{ textAlign: 'center', color: '#888888', fontSize: 13, padding: '36px 0' }}>
            还没有足够数据，先记几笔支出和存一笔钱吧
          </div>
        ) : (
          <div>
            {/* 内容一：三块并排 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: large ? 20 : 12, marginBottom: large ? 22 : 16 }}>
              {/* 支出 */}
              <div style={{ background: '#E4E6E6', border: '1px solid #E4E6E6', borderRadius: 12, padding: large ? 16 : 12, fontVariantNumeric: 'tabular-nums' }}>
                <div style={{ fontSize: 12, color: '#888888', fontWeight: 500 }}>本月支出</div>
                <div style={{ fontSize: large ? 26 : 19, fontWeight: 700, color: '#111111', marginTop: 4 }}>{fmtS(thisMonthExpense)}</div>
                <div style={{ fontSize: 12, marginTop: 4 }}>{deltaText(expenseDeltaPct)}</div>
                <div style={{ fontSize: 11, color: '#888888', marginTop: 4 }}>占总预算 {Math.min(100, Math.round(budgetRatio * 100))}%</div>
              </div>
              {/* 储蓄 */}
              <div style={{ background: '#E4E6E6', border: '1px solid #E4E6E6', borderRadius: 12, padding: large ? 16 : 12, fontVariantNumeric: 'tabular-nums' }}>
                <div style={{ fontSize: 12, color: '#888888', fontWeight: 500 }}>本月储蓄（结余）</div>
                <div style={{ fontSize: large ? 26 : 19, fontWeight: 700, color: savingsThis < 0 ? '#DC2626' : '#0040FF', marginTop: 4 }}>
                  {savingsThis < 0 ? `超支 ${fmtS(-savingsThis)}` : fmtS(savingsThis)}
                </div>
                <div style={{ fontSize: 12, marginTop: 4 }}>{deltaText(savingsDeltaPct)}</div>
                <div style={{ fontSize: 11, color: '#888888', marginTop: 4 }}>储蓄率 {savingsRate}%（按预算）</div>
              </div>
              {/* 负债 */}
              <div style={{ background: '#E4E6E6', border: '1px solid #E4E6E6', borderRadius: 12, padding: large ? 16 : 12, fontVariantNumeric: 'tabular-nums' }}>
                <div style={{ fontSize: 12, color: '#888888', fontWeight: 500 }}>本月负债</div>
                <div style={{ fontSize: large ? 26 : 19, fontWeight: 700, color: '#22D3EE', marginTop: 4 }}>{fmtS(debtTotal)}</div>
                <div style={{ fontSize: 12, marginTop: 4 }}>{deltaText(debtDeltaPct)}</div>
                <div style={{ fontSize: 11, color: '#888888', marginTop: 4 }}>
                  负债收入比 <b style={{ color: debtIncomeRatio > 40 ? '#DC2626' : '#111111', fontVariantNumeric: 'tabular-nums' }}>{debtIncomeRatio}%</b>
                  {debtIncomeRatio > 40 ? <span style={{ color: '#DC2626' }}> ⚠️ 红色警戒</span> : ''}
                  （按{thisMonthIncome > 0 ? '收入' : '预算'}）
                </div>
              </div>
            </div>

            {/* 内容二：三维对比图 */}
            <div style={{ marginBottom: large ? 18 : 12 }}>
              <div style={{ fontSize: 13, color: '#888888', marginBottom: 8 }}>本月 vs 上月 三维对比</div>
              <ResponsiveContainer width="100%" height={large ? 320 : 200}>
                <BarChart data={threeDimData} barGap={8} margin={{ top: 22, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#C0C4C4" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#888888' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#888888' }} axisLine={false} tickLine={false} width={50}
                    tickFormatter={(v) => Number(v).toLocaleString()} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v) => ['¥' + Number(v), '']} />
                  <Bar dataKey="本月" fill="#0040FF" radius={[5, 5, 0, 0]} maxBarSize={42}>
                    <LabelList dataKey="本月" position="top" style={{ fontSize: 11, fill: '#0040FF', fontWeight: 600 }} />
                  </Bar>
                  <Bar dataKey="上月" fill="#C0C4C4" radius={[5, 5, 0, 0]} maxBarSize={42}>
                    <LabelList dataKey="上月" position="top" style={{ fontSize: 11, fill: '#888888', fontWeight: 600 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* 内容三：规则结论 */}
            <div style={{ display: 'grid', gridTemplateColumns: large ? 'repeat(3, 1fr)' : '1fr', gap: 10 }}>
              {threeDimConclusions.map((t, i) => (
                <div key={i} style={{ background: '#E4E6E6', border: '1px solid #E4E6E6', borderRadius: 10, padding: '10px 12px', fontSize: 12.5, color: '#111111', lineHeight: 1.7 }}>
                  {t}
                </div>
              ))}
            </div>
          </div>
        )}
      </DashboardCard>
    )
  }

  function impulseAnalysisCard(large: boolean) {
    return (
      <DashboardCard title="冲动消费分析" onExpand={() => setExpanded('impulseAnalysis')}>
        {impulseList.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#888888', fontSize: 13, padding: '36px 0' }}>🎉 本月没有冲动消费，继续保持</div>
        ) : (
          <>
            {/* 大数字 */}
            <div style={{ fontVariantNumeric: 'tabular-nums' }}>
              <div style={{ fontSize: large ? 44 : 30, fontWeight: 700, color: '#0040FF', lineHeight: 1.1 }}>{fmtS(impulseTotal)}</div>
              <div style={{ fontSize: 12, color: '#888888', marginTop: 2 }}>本月冲动消费总额（中/高/很高等级）</div>
            </div>
            {/* 指标卡 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 12 }}>
              <MiniStat label="冲动总笔数" value={`${impulseList.length} 笔`} />
              <MiniStat label="最大单笔冲动" value={maxImpulse ? `${maxImpulse.merchant} ${fmtS(maxImpulse.amountMinor)}` : '—'} />
              <MiniStat label="平均冲动指数" value={`${avgScore} 分`} />
            </div>

            {/* ① 冲动平台排行（横向条形图，靛蓝渐变） */}
            {impulsePlatformAmounts.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12, color: '#888888', marginBottom: 6 }}>① 冲动平台排行（按金额）</div>
                <HBarList data={impulsePlatformAmounts.map(p => ({ name: p.name, value: p.amount }))} />
              </div>
            )}

            {/* ② 冲动金额占比（环形图，中心=总冲动金额） */}
            {impulsePlatformAmounts.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12, color: '#888888', marginBottom: 6 }}>② 冲动金额占比（主战场一眼看清）</div>
                <CategoryRing data={impulsePlatformAmounts} centerTitle="本月冲动总额" centerValue={fmtS(impulseTotal)} height={large ? 230 : 165} />
              </div>
            )}

            {/* ③ 冲动强度分布（高/中/低） */}
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: '#888888', marginBottom: 6 }}>③ 冲动强度分布（高/中/低）</div>
              <StrengthBars dist={impulseStrength} />
            </div>

            {/* ④ 近30天冲动日历热力图（点击某天看当天冲动明细） */}
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: '#888888', marginBottom: 6 }}>④ 近30天冲动日历（点击日期查看当天冲动明细）</div>
              <Heatmap data={impulseHeat30} onPick={openHeatDay} />
            </div>

            {/* 时段分布（点击柱下钻） */}
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: '#888888', marginBottom: 6 }}>冲动集中在什么时段？（点击柱子查看该时段冲动明细）</div>
              <SlotBarChart data={impulseSlotRows} onPick={(row) => {
                if (row.count <= 0) return
                const list = impulseList.filter(tx => slotOf(new Date(tx.time).getHours()) === row.name).map(txToItem)
                setSheet({ title: `${row.name}冲动明细（${list.length} 笔，共 ${fmtS(row.amount * 100)}）`, txs: list })
              }} height={large ? 180 : 130} />
            </div>

            {/* 可执行按钮 */}
            <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <ActionBtn color="#E11D48" onClick={() => {
                void (async () => {
                  await setSetting('nightLock', 'true')
                  await setSetting('nightLockWindow', JSON.stringify({ start: 0, end: 2 }))
                })()
                toastIt('已生效：凌晨消费锁已开启（0:00-2:00 购物记账二次确认）')
              }}>🔒 开启凌晨消费锁</ActionBtn>
              <ActionBtn color="#F59E0B" onClick={() => {
                const top = impulsePlatformAmounts[0]
                const name = top ? top.name : '拼多多'
                const now = new Date()
                void (async () => {
                  await addWishlistItem({
                    name,
                    priceMinor: top ? top.amount * 100 : 0,
                    addedAt: now.toISOString(),
                    coolingDays: 1,
                    coolingEndsAt: new Date(now.getTime() + 86_400_000).toISOString(),
                    status: 'cooling',
                    aiAnalysis: null,
                    finalPriceMinor: null,
                    boughtAt: null,
                  })
                })()
                toastIt(`已生效：${name} 已加入欲望清单冷静 1 天（冲动平台防护）`)
              }}>🛒 把{impulsePlatformAmounts[0]?.name ?? '拼多多'}加入欲望清单</ActionBtn>
              <ActionBtn color="#0040FF" onClick={() => {
                setSheet({ title: '最近 5 次冲动记录', txs: recentImpulseItems })
              }}>📋 查看过去5次冲动记录</ActionBtn>
            </div>

            {/* AI 解读（结论+证据） */}
            <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button onClick={() => void handleAiImpulse()} disabled={aiImpulseLoading}
                style={{
                  padding: '8px 16px', borderRadius: 10, border: '1px solid #C0C4C4', background: '#E4E6E6',
                  color: '#0040FF', fontSize: 13, fontWeight: 600, cursor: aiImpulseLoading ? 'wait' : 'pointer',
                  fontFamily: 'var(--font-stack)',
                }}>
                {aiImpulseLoading ? '⏳ AI 分析中…' : '🤖 AI 解读（结论+证据）'}
              </button>
              {aiImpulseLoading && <span style={{ fontSize: 12, color: '#888888' }}>正在统计冲动数据并生成分析…</span>}
            </div>
            {aiImpulse && (
              <div style={{
                marginTop: 12, background: '#E4E6E6', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 12,
                padding: '12px 14px', fontSize: 13, color: '#f59e0b', lineHeight: 1.8,
              }}>
                <Markdown md={aiImpulse.text} />
              </div>
            )}
          </>
        )}
      </DashboardCard>
    )
  }

  function savingsBigCard(large: boolean) {
    const pct = goal && goal.targetMinor > 0 ? (goal.currentMinor / goal.targetMinor) * 100 : 0
    const remainAmt = goal ? Math.max(0, goal.targetMinor - goal.currentMinor) : 0
    const milestones = goal?.milestones || []
    const validMs = goal ? milestones.filter(m => m <= goal.targetMinor) : []
    return (
      <DashboardCard title="储蓄目标" onExpand={() => setExpanded('savingsBig')}
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button onClick={() => setShowGoalForm(true)} title="新建储蓄目标"
              style={{
                padding: '4px 10px', borderRadius: 8, border: '1px solid #C0C4C4', background: '#D8DADA',
                fontSize: 12, color: '#888888', cursor: 'pointer', fontFamily: 'var(--font-stack)', fontWeight: 500, whiteSpace: 'nowrap',
              }}>新建目标</button>
            <SaveBtn onClick={() => setShowSaveForm(true)} />
          </div>
        }>
        {!goal ? (
          <div style={{ textAlign: 'center', padding: '28px 0' }}>
            <div style={{ fontSize: 13, color: '#888888', marginBottom: 14 }}>还没有储蓄目标，先建一个吧</div>
            <button onClick={() => setShowGoalForm(true)} className="btn-primary" style={{ padding: '9px 22px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              ＋ 新建储蓄目标
            </button>
            <div style={{ fontSize: 12, color: '#C0C4C4', marginTop: 12 }}>
              也可以先 <span onClick={() => setShowSaveForm(true)} style={{ color: '#0040FF', cursor: 'pointer', fontWeight: 500 }}>存一笔</span>，系统会帮你建默认目标
            </div>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: large ? 32 : 20 }}>
              <Ring pct={pct} size={large ? 150 : 110} strokeW={large ? 12 : 10} fontSize={large ? 28 : 22} />
              <div style={{ flex: 1, minWidth: 0, fontVariantNumeric: 'tabular-nums' }}>
                <div style={{ fontSize: large ? 22 : 17, fontWeight: 700, color: '#111111' }}>
                  {fmtS(goal.currentMinor)}
                  <span style={{ fontSize: 13, color: '#888888', fontWeight: 400 }}> / {fmtS(goal.targetMinor)}</span>
                </div>
                <div style={{ fontSize: 13, color: '#888888', marginTop: 6 }}>
                  还差 <b style={{ color: '#0040FF' }}>{fmtS(remainAmt)}</b>
                </div>
                <div style={{ fontSize: 12, color: '#888888', marginTop: 4 }}>{estInfo?.text || '设置目标后估算达成日期'}</div>
              </div>
            </div>
            {/* 里程碑刻度条 */}
            <div style={{ marginTop: large ? 22 : 16 }}>
              <div style={{ position: 'relative', height: 8, background: '#E4E6E6', borderRadius: 4, marginBottom: 8 }}>
                <div style={{
                  position: 'absolute', inset: 0, width: `${Math.min(100, pct)}%`, borderRadius: 4,
                  background: 'linear-gradient(90deg,#0040FF,#22D3EE)', transition: 'width 0.6s ease',
                }} />
                {validMs.map(m => (
                  <div key={m} style={{
                    position: 'absolute', top: -3, left: `${(m / goal.targetMinor) * 100}%`,
                    width: 2, height: 14, background: '#C0C4C4', borderRadius: 1,
                  }} />
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#888888' }}>
                {validMs.map(m => (
                  <span key={m} style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtS(m)}</span>
                ))}
              </div>
            </div>
          </div>
        )}
      </DashboardCard>
    )
  }

  function payoffCard(_large: boolean) {
    const latest = payoffInfo.length > 0 ? payoffInfo[0].zeroDate : null
    return (
      <DashboardCard title="还款倒计时" onExpand={() => setExpanded('payoff')}>
        {payoffInfo.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '36px 0', fontSize: 14, color: '#888888' }}>🎉 零负债</div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: '#888888' }}>
              预计{' '}
              <b style={{ color: '#22D3EE', fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>
                {latest ? `${latest.getFullYear()}年${latest.getMonth() + 1}月` : '—'}
              </b>{' '}
              全部清零
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
              {payoffInfo.map(d => (
                <div key={d.key} style={{ padding: '10px 12px', background: '#E4E6E6', borderRadius: 10, border: '1px solid #E4E6E6' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#111111' }}>{d.name}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#22D3EE', fontVariantNumeric: 'tabular-nums' }}>{fmtS(d.remainingMinor)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#888888', marginTop: 4, flexWrap: 'wrap', gap: 4 }}>
                    <span>月还 {fmtS(d.pay)} · 利率 {d.apr}%</span>
                    <span>预计 <b style={{ color: '#111111' }}>{d.zeroDate.getFullYear()}年{d.zeroDate.getMonth() + 1}月</b> 清零（{d.months} 个月）</span>
                  </div>
                  <div style={{ marginTop: 6 }}><MiniProgress pct={(1 / d.months) * 100} color="#22D3EE" height={5} /></div>
                </div>
              ))}
            </div>
          </>
        )}
      </DashboardCard>
    )
  }

  function recordsCard(large: boolean) {
    const list = large
      ? [...txs].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 20)
      : recentTxs
    return (
      <DashboardCard title="最近记录" onExpand={() => setExpanded('records')}>
        {list.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <span style={{ fontSize: 13, color: '#888888' }}>还没有支出，</span>
            <span onClick={() => navigate('/ledger')} style={{ fontSize: 13, color: '#0040FF', cursor: 'pointer', fontWeight: 500 }}>去记一笔吧</span>
          </div>
        ) : (
          <div>
            {list.map((tx, i) => {
              const cat = categories.find(c => c.name === tx.category)
              const transfer = isTransfer(tx)
              const income = isIncome(tx)
              const isImpulse = isImpulsive(tx.impulseLevel)
              const sign = (transfer || income) ? '+' : '-'
              const color = (transfer || income) ? '#22D3EE' : '#111111'
              const tagColor = transfer || income ? '#22D3EE' : (cat?.color || '#888888')
              return (
                <div key={tx.id} style={{
                  display: 'flex', alignItems: 'center', padding: '8px 0',
                  borderBottom: i < list.length - 1 ? '1px solid #E4E6E6' : 'none',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: '#111111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {transfer ? '🏦' : income ? '💰' : (cat?.icon || '📦')} {tx.merchant}
                      {isImpulse && <span style={{ color: IMPULSE_LEVEL_COLOR[tx.impulseLevel], marginLeft: 6, fontWeight: 700 }}>⚡{IMPULSE_LEVEL_LABEL[tx.impulseLevel]}</span>}
                    </div>
                    {tx.note && <div style={{ fontSize: 11, color: '#888888', marginTop: 1 }}>{tx.note}</div>}
                  </div>
                  <span style={{
                    fontSize: 11, padding: '2px 7px', borderRadius: 5, fontWeight: 500,
                    background: tagColor + '18', color: transfer ? '#22D3EE' : (income ? '#22D3EE' : tagColor),
                    marginRight: 8, whiteSpace: 'nowrap',
                  }}>
                    {transfer ? '储蓄' : income ? '收入' : tx.category}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {sign}{fmtS(tx.amountMinor)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </DashboardCard>
    )
  }

  function calendarCard(large: boolean) {
    const now = new Date()
    const y = now.getFullYear(); const m = now.getMonth()
    const dim = daysInMonth(y, m)
    const firstDow = new Date(y, m, 1).getDay()
    const adj = firstDow === 0 ? 6 : firstDow - 1
    const today = now.getDate()
    const cellSize = large ? 46 : 30
    const wh = ['一', '二', '三', '四', '五', '六', '日']

    return (
      <DashboardCard
        title="扣费日程日历"
        onExpand={() => setExpanded('calendar')}
        action={
          <button onClick={() => setShowAddForm(true)}
            style={{ padding: '4px 10px', borderRadius: 8, border: '1px solid #C0C4C4', background: '#E4E6E6', fontSize: 12, color: '#0040FF', cursor: 'pointer', fontFamily: 'var(--font-stack)', fontWeight: 500 }}>
            ＋ 添加日程
          </button>
        }
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#888888' }}>{y}年{m + 1}月</span>
          <LiveClock />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3, textAlign: 'center' }}>
          {wh.map(h => <div key={h} style={{ fontSize: 11, color: '#888888', padding: '3px 0', fontWeight: 500 }}>{h}</div>)}
          {Array.from({ length: adj }, (_, i) => <div key={`b${i}`} />)}
          {Array.from({ length: dim }, (_, i) => {
            const d = i + 1
            const k = dateKey(new Date(y, m, d))
            const dots = dotMap[k] || []
            const dow = (adj + d - 1) % 7
            const isToday = d === today
            const isSelected = selectedDay === k
            return (
              <button key={d} onClick={() => setSelectedDay(isSelected ? null : k)}
                style={{
                  fontSize: 12, fontWeight: isToday ? 700 : 400,
                  color: isToday ? '#FFFFFF' : dow >= 5 ? '#888888' : '#111111',
                  background: isSelected ? '#E4E6E6' : isToday ? '#0040FF' : 'transparent',
                  border: isSelected && !isToday ? '1px solid #C0C4C4' : 'none',
                  borderRadius: 8, height: cellSize, cursor: 'pointer',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  gap: 3, fontFamily: 'var(--font-stack)', padding: 0,
                }}>
                {d}
                {dots.length > 0 && (
                  <span style={{ display: 'flex', gap: 2 }}>
                    {dots.slice(0, 3).map((tp, idx) => (
                      <span key={idx} style={{ width: 5, height: 5, borderRadius: '50%', background: SCHEDULE_TYPE_COLOR[tp] }} />
                    ))}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* 本月待扣费 */}
        <div style={{ marginTop: 12, padding: '10px 12px', background: '#E4E6E6', borderRadius: 10, border: '1px solid #E4E6E6' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#888888' }}>本月待扣费</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: '#F59E0B', fontVariantNumeric: 'tabular-nums' }}>{fmtS(monthDueTotal)}</span>
          </div>
          <div style={{ fontSize: 11, color: '#888888', marginTop: 2 }}>{monthSchedules.length} 笔扣费日程</div>
        </div>

        {/* 图例 */}
        <div style={{ display: 'flex', gap: 12, marginTop: 10, fontSize: 11, color: '#888888' }}>
          {(Object.keys(SCHEDULE_TYPE_COLOR) as Schedule['type'][]).map(t => (
            <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: SCHEDULE_TYPE_COLOR[t] }} />
              {SCHEDULE_TYPE_LABEL[t]}
            </span>
          ))}
        </div>

        {/* 当天日程 */}
        {selectedDay && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#111111' }}>{selectedDay} 的日程</span>
              <button onClick={() => setSelectedDay(null)} style={{ background: 'none', border: 'none', color: '#888888', fontSize: 12, cursor: 'pointer' }}>收起 ✕</button>
            </div>
            {selectedDaySchedules.length === 0 ? (
              <div style={{ fontSize: 12, color: '#888888', padding: '12px 0' }}>这天没有扣费日程</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {selectedDaySchedules.map(s => (
                  <div key={s.id} style={{
                    display: 'flex', alignItems: 'center', padding: '8px 10px', background: '#E4E6E6',
                    borderRadius: 8, border: '1px solid #E4E6E6',
                    opacity: s.notified ? 0.55 : 1,
                  }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: SCHEDULE_TYPE_COLOR[s.type], flexShrink: 0, marginRight: 8 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 500, color: '#111111' }}>
                        {s.name}
                        {s.notified && <span style={{ color: '#22D3EE', fontSize: 11, marginLeft: 6 }}>✓ 已完成</span>}
                      </span>
                      {s.note && <div style={{ fontSize: 11, color: '#888888' }}>{s.note}</div>}
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#F59E0B', fontVariantNumeric: 'tabular-nums', marginRight: 10 }}>{fmtS(s.amountMinor)}</span>
                    {!s.notified && (
                      <button onClick={() => handleCompleteSchedule(s.id)} title="完成"
                        style={{ background: '#22D3EE', border: 'none', color: '#FFFFFF', width: 22, height: 22, borderRadius: 6, cursor: 'pointer', fontSize: 12, lineHeight: 1, marginRight: 6 }}>✓</button>
                    )}
                    <button onClick={() => handleDeleteSchedule(s.id)} title="删除"
                      style={{ background: '#E4E6E6', border: 'none', color: '#0040FF', width: 22, height: 22, borderRadius: 6, cursor: 'pointer', fontSize: 12, lineHeight: 1 }}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </DashboardCard>
    )
  }

  // 全屏放大时重新渲染内容（图表更大）
  function renderExpanded(id: string) {
    switch (id) {
      case 'calendar': return calendarCard(true)
      case 'budget': return budgetCard(true)
      case 'threeDim': return threeDimCard(true)
      case 'savingsBig': return savingsBigCard(true)
      case 'impulseMini': return impulseMiniCard(true)
      case 'impulseAnalysis': return impulseAnalysisCard(true)
      case 'debtMini': return debtMiniCard(true)
      case 'tracking': return trackingCard(true)
      case 'dailyExpense': return dailyExpenseCard(true)
      case 'pie': return pieCard(true)
      case 'categoryCompare': return categoryCompareCard(true)
      case 'payoff': return payoffCard(true)
      case 'records': return recordsCard(true)
      default: return null
    }
  }

  // ========== 渲染 ==========

  if (!loaded) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 0', color: '#888888', fontSize: 14 }}>正在加载数据…</div>
    )
  }

  return (
    <div style={{ position: 'relative' }}>
      {/* AI 主动提醒：连续3晚购物 / 储蓄达标 / 债务下降 / 新洞察 / 30天回访 */}
      <ProactiveBanner />

      {/* 高频冲动窗口温和提示条 */}
      <ForecastBanner />

      {/* 30天购买待反馈区块（已买满30天，去重展示 + 三按钮 + 可忽略；设置页可关） */}
      <FeedbackBlock />

      {/* 首页窗口提示：当前处于高频冲动窗口 */}
      {showFragileTip && fragileNow && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
          background: '#E4E6E6', border: '1px solid #C0C4C4', borderRadius: 12, padding: '10px 16px',
        }}>
          <span style={{ fontSize: 15 }}>🌙</span>
          <span style={{ fontSize: 13, color: '#0040FF', flex: 1, lineHeight: 1.6 }}>
            你的老时间到了（<b>{fragileNow.label}</b>，近30天 {fragileNow.share}% 的冲动发生在这个时段），要不要先看看书、喝杯水？
          </span>
          <button onClick={() => setShowFragileTip(false)}
            style={{ background: 'none', border: 'none', color: '#0040FF', fontSize: 13, cursor: 'pointer', flexShrink: 0 }}>✕</button>
        </div>
      )}

      {/* 今日提醒条 */}
      {showReminder && todayDue.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
          background: '#E4E6E6', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 12, padding: '10px 16px',
        }}>
          <span style={{ fontSize: 15 }}>🔔</span>
          <span style={{ fontSize: 13, color: '#f59e0b', flex: 1 }}>
            今日 {todayDue.length} 笔待扣费：{todayDue.map(s => `${s.name} ${fmtS(s.amountMinor)}`).join('、')}
          </span>
          <button onClick={() => setShowReminder(false)}
            style={{ background: 'none', border: 'none', color: '#f59e0b', fontSize: 13, cursor: 'pointer', flexShrink: 0 }}>✕</button>
        </div>
      )}

      {/* 顶部标题 + 操作 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#111111', marginBottom: 2 }}>首页看板</h1>
          <p style={{ fontSize: 13, color: '#888888', fontVariantNumeric: 'tabular-nums' }}>
            本月预算 {fmtS(monthlyBudget)} · 已支出 {fmtS(thisMonthExpense)} · 剩余 {fmtS(remaining)}
          </p>
        </div>
      </div>

      {/* 数据备份温和提醒（7 天一次，可关闭） */}
      {backupNotice && (
        <div style={{
          marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          background: '#E4E6E6', border: '1px solid rgba(249,115,22,0.2)', borderRadius: 12, padding: '10px 14px',
        }}>
          <span style={{ fontSize: 15 }}>🛡️</span>
          <span style={{ fontSize: 13, color: '#f59e0b', flex: 1, minWidth: 0 }}>{backupNotice} · 手机浏览器可能自动清理数据</span>
          <button onClick={() => navigate('/settings')}
            style={{
              padding: '6px 14px', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#FFFFFF',
              fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-stack)', flexShrink: 0,
            }}>
            去备份
          </button>
          <button onClick={() => setBackupNotice(null)} title="不再提醒"
            style={{ background: 'none', border: 'none', color: '#f59e0b', fontSize: 14, cursor: 'pointer', flexShrink: 0, lineHeight: 1 }}>
            ✕
          </button>
        </div>
      )}

      {/* ===== 监控看板网格 ===== */}

      {/* 第一行：KPI 概览（小数据卡并排） */}
      <div className="stack-on-mobile" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 12 }}>
        {budgetCard(false)}
        {impulseMiniCard(false)}
        {debtMiniCard(false)}
        {trackingCard(false)}
      </div>

      {/* 全宽行：财务三维度综合分析（图表） */}
      <div style={{ marginBottom: 12 }}>
        {threeDimCard(false)}
      </div>

      {/* 图表行：每日支出趋势 + 消费分布 */}
      <div className="stack-on-mobile" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 12, marginBottom: 12 }}>
        {dailyExpenseCard(false)}
        {pieCard(false)}
      </div>

      {/* 图表行：分类对比 + 冲动分析 */}
      <div className="stack-on-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        {categoryCompareCard(false)}
        {impulseAnalysisCard(false)}
      </div>

      {/* 状态行：扣费日历 + 储蓄目标 */}
      <div className="stack-on-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        {calendarCard(false)}
        {savingsBigCard(false)}
      </div>

      {/* 状态行：还款计划 + 最近记录 */}
      <div className="stack-on-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {payoffCard(false)}
        {recordsCard(false)}
      </div>

      {/* 添加日程弹层 */}
      {showAddForm && (
        <Overlay onClose={() => setShowAddForm(false)}>
          <ScheduleForm onSave={handleAddSchedule} onClose={() => setShowAddForm(false)} />
        </Overlay>
      )}

      {/* 设置本月预算弹层 */}
      {showBudgetForm && (
        <Overlay onClose={() => setShowBudgetForm(false)}>
          <BudgetForm current={monthlyBudget} onSave={handleSetBudget} onClose={() => setShowBudgetForm(false)} />
        </Overlay>
      )}

      {/* 存一笔储蓄弹层 */}
      {showSaveForm && (
        <Overlay onClose={() => setShowSaveForm(false)}>
          <SaveMoneyForm onSave={handleSaveMoney} onClose={() => setShowSaveForm(false)} />
        </Overlay>
      )}

      {/* 新建储蓄目标弹层 */}
      {showGoalForm && (
        <Overlay onClose={() => setShowGoalForm(false)}>
          <SavingsGoalForm onSave={handleAddSavingsGoal} onClose={() => setShowGoalForm(false)} />
        </Overlay>
      )}

      {/* 全屏放大 */}
      {expanded && (
        <Overlay onClose={() => setExpanded(null)} wide>
          <div style={{ position: 'relative', height: '100%', width: '100%' }}>
            <button onClick={() => setExpanded(null)} title="关闭"
              style={{
                position: 'absolute', top: 8, right: 8, zIndex: 10,
                width: 34, height: 34, borderRadius: 10,
                background: '#D8DADA', border: '1px solid #C0C4C4', color: '#888888',
                fontSize: 16, cursor: 'pointer', lineHeight: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 2px 8px rgba(0,0,0,0.1)', fontFamily: 'var(--font-stack)',
              }}>✕</button>
            {renderExpanded(expanded)}
          </div>
        </Overlay>
      )}

      {/* 下钻明细弹层（时段/热力图某天/最近5次冲动） */}
      <TxSheet title={sheet?.title ?? ''} txs={sheet?.txs ?? []} onClose={() => setSheet(null)} />

      {/* "已生效"提示 */}
      {toast && (
        <div className="home-toast" style={{
          position: 'fixed', left: '50%', bottom: 32, transform: 'translateX(-50%)', zIndex: 1500,
          background: '#0040FF', color: '#FFFFFF', padding: '10px 20px', borderRadius: 999,
          fontSize: 13.5, fontWeight: 600, boxShadow: '0 8px 24px rgba(0,64,255,0.35)',
          animation: 'fadeInUp 0.25s ease both',
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}

// ==================== 通用辅助组件 ====================

const ghostBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#888888', fontSize: 16, cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
}

function Label({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12, color: '#888888', fontWeight: 500, marginBottom: 6 }}>{children}</div>
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: '#E4E6E6', border: '1px solid #E4E6E6', borderRadius: 10, padding: '8px 10px', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: '#888888', marginBottom: 3 }}>{label}</div>
      <div style={{
        fontSize: 13, fontWeight: 700, color: '#111111', fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{value}</div>
    </div>
  )
}

// 「＋ 存一笔」小按钮
function SaveBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick}
      style={{
        padding: '4px 10px', borderRadius: 8, border: '1px solid #C0C4C4', background: '#E4E6E6',
        fontSize: 12, color: '#0040FF', cursor: 'pointer', fontFamily: 'var(--font-stack)', fontWeight: 500, whiteSpace: 'nowrap',
      }}>＋ 存一笔</button>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 10, border: '1px solid #C0C4C4',
  fontSize: 14, fontFamily: 'var(--font-stack)', outline: 'none', color: '#111111',
  fontVariantNumeric: 'tabular-nums', background: '#E8EAEA',
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1, padding: '8px 0', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'var(--font-stack)', transition: 'all 0.15s',
    border: active ? '1px solid #0040FF' : '1px solid var(--border)',
    background: active ? 'rgba(0,64,255,0.10)' : 'transparent',
    color: active ? '#0040FF' : '#888888',
  }
}

function Overlay({ children, onClose, wide }: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div onClick={e => e.stopPropagation()} style={wide
        ? { width: 'min(1200px, 94vw)', height: '88vh', display: 'flex', flexDirection: 'column' }
        : {}}>
        {children}
      </div>
    </div>
  )
}

// ==================== 添加日程表单 ====================

function ScheduleForm({ onSave, onClose }: {
  onSave: (data: Omit<Schedule, 'id' | 'notified'>) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<Schedule['type']>('subscription')
  const [amountText, setAmountText] = useState('')
  const [date, setDate] = useState(todayStr())
  const [repeat, setRepeat] = useState<Schedule['repeat']>('monthly')
  const [note, setNote] = useState('')

  function handleSubmit() {
    const minor = Math.round(parseFloat(amountText || '0') * 100)
    if (!name.trim() || minor <= 0) return
    onSave({ name: name.trim(), type, amountMinor: minor, date, repeat, note: note.trim() })
  }

  return (
    <div style={{ width: 420, maxWidth: '92vw', background: '#D8DADA', borderRadius: 16, padding: 24, boxShadow: 'var(--shadow-lg)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: '#111111' }}>添加扣费日程</span>
        <button onClick={onClose} style={ghostBtn}>✕</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <Label>日程名称</Label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="如：爱奇艺会员续费" style={inputStyle} />
        </div>
        <div>
          <Label>类型</Label>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['subscription', 'debt', 'other'] as Schedule['type'][]).map(t => (
              <button key={t} onClick={() => setType(t)} style={chipStyle(type === t)}>{SCHEDULE_TYPE_LABEL[t]}</button>
            ))}
          </div>
        </div>
        <div>
          <Label>金额（元）</Label>
          <input value={amountText} onChange={e => setAmountText(e.target.value)} inputMode="decimal" placeholder="0.00" style={inputStyle} />
        </div>
        <div>
          <Label>日期</Label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <Label>重复</Label>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['none', 'monthly', 'yearly'] as Schedule['repeat'][]).map(r => (
              <button key={r} onClick={() => setRepeat(r)} style={chipStyle(repeat === r)}>
                {r === 'none' ? '不重复' : r === 'monthly' ? '每月' : '每年'}
              </button>
            ))}
          </div>
        </div>
        <div>
          <Label>备注</Label>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="可选" style={inputStyle} />
        </div>
        <button onClick={handleSubmit} className="btn-primary" style={{ width: '100%', padding: '10px 0' }}>保存日程</button>
      </div>
    </div>
  )
}

// ==================== 本月预算表单 ====================

function BudgetForm({ current, onSave, onClose }: {
  current: number
  onSave: (minor: number) => void
  onClose: () => void
}) {
  const [text, setText] = useState(current > 0 ? String(current / 100) : '')
  const minor = (() => {
    const n = parseFloat(text)
    if (isNaN(n) || n <= 0) return 0
    return Math.round(n * 100)
  })()

  return (
    <div style={{ width: 360, maxWidth: '92vw', background: '#D8DADA', borderRadius: 16, padding: 24, boxShadow: 'var(--shadow-lg)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: '#111111' }}>设置本月预算</span>
        <button onClick={onClose} style={ghostBtn}>✕</button>
      </div>
      <div style={{ fontSize: 12, color: '#888888', marginBottom: 8 }}>这个月总共有多少生活费可花？</div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 18 }}>
        <span style={{ fontSize: 22, color: '#888888', marginRight: 6 }}>¥</span>
        <input value={text} onChange={e => setText(e.target.value)} inputMode="decimal" placeholder="1000"
          style={{
            flex: 1, fontSize: 26, fontWeight: 700, border: 'none', outline: 'none', background: 'transparent',
            color: '#111111', fontFamily: 'var(--font-stack)', fontVariantNumeric: 'tabular-nums',
          }} />
      </div>
      <div style={{ fontSize: 12, color: '#888888', marginBottom: 16 }}>
        本月剩余 = 预算 − 已支出，随时可以修改
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={() => { if (minor > 0) onSave(minor) }} className="btn-primary" style={{ flex: 1, padding: '10px 0' }}>保存预算</button>
        <button onClick={onClose} style={{ ...ghostBtn, border: '1px solid #C0C4C4', borderRadius: 10, padding: '0 18px', fontSize: 14, color: '#888888' }}>取消</button>
      </div>
    </div>
  )
}

// ==================== 存一笔储蓄表单 ====================

function SaveMoneyForm({ onSave, onClose }: {
  onSave: (minor: number) => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const minor = (() => {
    const n = parseFloat(text)
    if (isNaN(n) || n <= 0) return 0
    return Math.round(n * 100)
  })()

  return (
    <div style={{ width: 360, maxWidth: '92vw', background: '#D8DADA', borderRadius: 16, padding: 24, boxShadow: 'var(--shadow-lg)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: '#111111' }}>存一笔储蓄</span>
        <button onClick={onClose} style={ghostBtn}>✕</button>
      </div>
      <div style={{ fontSize: 13, color: '#888888', marginBottom: 8 }}>这个月存了多少钱？</div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 22, color: '#888888', marginRight: 6 }}>¥</span>
        <input value={text} onChange={e => { const v = e.target.value; if (/^\d*\.?\d{0,2}$/.test(v) || v === '') setText(v) }} inputMode="decimal" placeholder="0.00" autoFocus
          style={{
            flex: 1, fontSize: 26, fontWeight: 700, border: 'none', outline: 'none', background: 'transparent',
            color: '#111111', fontFamily: 'var(--font-stack)', fontVariantNumeric: 'tabular-nums',
          }} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[50, 100, 200, 500].map(n => (
          <button key={n} onClick={() => setText(String(n))}
            style={{ flex: 1, padding: '7px 0', borderRadius: 10, border: '1px solid #C0C4C4', background: '#E4E6E6', fontSize: 13, fontWeight: 600, color: '#111111', cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
            {n}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 12, color: '#888888', marginBottom: 16 }}>存入后累加到储蓄目标，并记一条「储蓄转入」记录</div>
      <button onClick={() => { if (minor > 0) onSave(minor) }} className="btn-primary" style={{ width: '100%', padding: '10px 0' }}>确认存入</button>
    </div>
  )
}

// ==================== 新建储蓄目标表单 ====================

function SavingsGoalForm({ onSave, onClose }: {
  onSave: (data: { name: string; targetMinor: number; deadline: string | null; reason: string }) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [targetText, setTargetText] = useState('')
  const [deadline, setDeadline] = useState('')
  const [reason, setReason] = useState('')

  const targetMinor = (() => {
    const n = parseFloat(targetText)
    if (isNaN(n) || n <= 0) return 0
    return Math.round(n * 100)
  })()

  function handleSubmit() {
    if (!name.trim() || targetMinor <= 0) return
    onSave({ name: name.trim(), targetMinor, deadline: deadline || null, reason: reason.trim() })
  }

  return (
    <div style={{ width: 420, maxWidth: '92vw', background: '#D8DADA', borderRadius: 16, padding: 24, boxShadow: 'var(--shadow-lg)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: '#111111' }}>新建储蓄目标</span>
        <button onClick={onClose} style={ghostBtn}>✕</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <Label>目标名称</Label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="如：年底换新手机 / 去云南旅行" style={inputStyle} autoFocus />
        </div>
        <div>
          <Label>目标金额（元）</Label>
          <input value={targetText} onChange={e => { const v = e.target.value; if (/^\d*\.?\d{0,2}$/.test(v) || v === '') setTargetText(v) }} inputMode="decimal" placeholder="如：5000" style={inputStyle} />
        </div>
        <div>
          <Label>截止日期（可选）</Label>
          <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <Label>为什么存这笔钱（可选）</Label>
          <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="写下你的真实动机，想放弃时回来看一眼"
            rows={2} style={{ ...inputStyle, resize: 'vertical', minHeight: 60, lineHeight: 1.6 }} />
        </div>
        <button onClick={handleSubmit} className="btn-primary" style={{ width: '100%', padding: '10px 0' }}>创建目标</button>
      </div>
    </div>
  )
}

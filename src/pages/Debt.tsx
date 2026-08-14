import { useEffect, useState } from 'react'
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip,
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  BarChart, Bar, Legend, ReferenceLine,
} from 'recharts'
import type { CreditAccount } from '../types'
import type { TooltipValueType } from 'recharts'
import {
  deleteCreditAccount, updateCreditAccount,
} from '../db/crud'
import { buildDebtSnapshot, type DebtSnapshot, type AccountStatus } from '../debt/debtContext'
import { computeDebtMetrics, type DebtMetrics } from '../debt/debtMetrics'
import { classifyDebtScenario, comparePlans, runDebtAdvice, SCENARIO_LABEL, type DebtScenario } from '../debt/debtStrategy'
import { recordRepayment, createCreditAccount, PLATFORM_DEFAULT } from '../debt/operations'
import { fmtYuan, fmtYuanShort, minPaymentInterestWarn, dateKeyOf } from '../debt/calc'
import { execDebtAction } from '../debt/actions'
import AiHtml from '../components/AiHtml'
import AddDebtModal from '../components/AddDebtModal'

// ===== 常量 =====

const PALETTE = ['#0040FF', '#22D3EE', '#F59E0B', '#6B90FF', '#0040FF', '#22D3EE', '#0040FF', '#94AFFF']
const PLATFORMS: CreditAccount['platform'][] = ['花呗', '京东白条', '抖音月付', '拼多多先用后付', '信用卡']
const tooltipStyle: React.CSSProperties = {
  background: '#D8DADA', border: '1px solid #C0C4C4', borderRadius: 10, fontSize: 12,
  boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 10, border: '1px solid #C0C4C4',
  fontSize: 13, color: 'var(--color-text)', outline: 'none', background: '#E8EAEA',
  fontFamily: 'var(--font-stack)', boxSizing: 'border-box',
}
const modalOverlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 200,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
}
const modalCard: React.CSSProperties = {
  width: '100%', maxWidth: 400, padding: 24, maxHeight: '85vh', overflowY: 'auto',
  borderRadius: 16, background: '#D8DADA', boxShadow: 'var(--shadow-lg)',
}

// ===== 工具 =====

// ===== 主组件 =====

export default function Debt() {
  const [snapshot, setSnapshot] = useState<DebtSnapshot | null>(null)
  const [metrics, setMetrics] = useState<DebtMetrics | null>(null)
  const [scenario, setScenario] = useState<DebtScenario>('balance')
  const [adviceHtml, setAdviceHtml] = useState<string | null>(null)
  const [adviceLoading, setAdviceLoading] = useState(false)
  const [adviceQ, setAdviceQ] = useState('')
  const [toast, setToast] = useState<string | null>(null)

  // 记一笔还款
  const [repayFor, setRepayFor] = useState<AccountStatus | null>(null)
  const [repayAmount, setRepayAmount] = useState('')
  const [repayMethod, setRepayMethod] = useState<'bank' | 'cash'>('bank')

  // 编辑账户
  const [editFor, setEditFor] = useState<AccountStatus | null>(null)
  const [editNickname, setEditNickname] = useState('')
  const [editLimitText, setEditLimitText] = useState('')
  const [editStDay, setEditStDay] = useState(1)
  const [editDueDay, setEditDueDay] = useState(9)

  // 创建账户（首次使用引导）
  const [showCreate, setShowCreate] = useState(false)
  const [createPlatform, setCreatePlatform] = useState<CreditAccount['platform']>('花呗')
  const [createNickname, setCreateNickname] = useState('')
  const [createLimitText, setCreateLimitText] = useState('')
  const [createStDay, setCreateStDay] = useState(1)
  const [createDueDay, setCreateDueDay] = useState(9)

  // 直接记一笔新负债
  const [showRecord, setShowRecord] = useState(false)

  // 逾期日历选中日
  const [calPick, setCalPick] = useState<{ key: string; label: string; items: { name: string; amountMinor: number; cashShort: boolean }[] } | null>(null)

  async function load() {
    const s = await buildDebtSnapshot()
    setSnapshot(s)
    const m = computeDebtMetrics(s)
    setMetrics(m)
    setScenario(classifyDebtScenario(s, m).scenario)
  }

  useEffect(() => { void load() }, [])

  useEffect(() => {
    const h = () => void load()
    window.addEventListener('dashboard-refresh', h)
    return () => window.removeEventListener('dashboard-refresh', h)
  }, [])

  function notify(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 4000)
    void load()
  }

  async function askAdvice(q: string) {
    setAdviceLoading(true)
    try {
      const r = await runDebtAdvice(q)
      setAdviceHtml(r.html)
    } catch {
      setAdviceHtml('<p style="color:#888888">⚠️ 顾问暂时不可用，请稍后再试</p>')
    } finally {
      setAdviceLoading(false)
    }
  }

  useEffect(() => { void askAdvice('我现在的债怎么还最划算？') }, [])

  if (!snapshot || !metrics) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#888888', fontSize: 14 }}>加载负债数据…</div>
  }

  const accounts = snapshot.accounts
  const hasDebt = accounts.some(a => a.principalRemMinor > 0)

  // —— KPI ——
  const burnLen = snapshot.burnDown.length
  const lastPrincipal = burnLen > 0 ? snapshot.burnDown[burnLen - 1].principalMinor : 0
  const prevPrincipal = burnLen > 1 ? snapshot.burnDown[burnLen - 2].principalMinor : 0
  const momPct = prevPrincipal > 0 ? Math.round(((lastPrincipal - prevPrincipal) / prevPrincipal) * 100) : 0
  const budgetRepayPct = snapshot.monthlyBudgetMinor > 0 ? Math.round((snapshot.currentDueMinor / snapshot.monthlyBudgetMinor) * 100) : 0
  const dtiColor = metrics.debtIncomePct > 40 ? '#DC2626' : metrics.debtIncomePct > 30 ? '#F59E0B' : '#22D3EE'

  // —— 图1 平台分布 ——
  const pieData = accounts
    .filter(a => a.principalRemMinor > 0)
    .map(a => ({
      name: `${a.account.platform}${a.account.nickname ? '·' + a.account.nickname : ''}`,
      value: Math.round(a.principalRemMinor / 100),
    }))

  // —— 图2 burn-down ——
  const burnData = snapshot.burnDown.map(b => ({ month: b.month.slice(5).replace('-', '/'), value: Math.round(b.principalMinor / 100) }))

  // —— 图3 利率对比 ——
  const rateData = metrics.rateRanking.slice(0, 8).map(r => ({ name: r.name, rate: r.realApr }))

  // —— 图4 未来6月还款堆叠 ——
  const fNames = [...new Set(snapshot.forecastMonthly.flatMap(m => m.byAccount.map(b => b.name)))]
  const stackData = snapshot.forecastMonthly.map(m => {
    const row: Record<string, number | string> = { month: m.month.slice(5).replace('-', '/') }
    for (const n of fNames) row[n] = 0
    for (const b of m.byAccount) row[b.name] = (row[b.name] as number) + Math.round(b.minor / 100)
    return row
  })

  // —— 还款规划对比 ——
  const plans = comparePlans(snapshot, Math.max(0, snapshot.disposableMinor))
  const bestPlan = plans && (plans.avalanche.totalInterestMinor <= plans.snowball.totalInterestMinor ? plans.avalanche : plans.snowball)

  // —— 逾期日历热力（未来30天） ——
  const calDays: { key: string; label: string; items: { name: string; amountMinor: number; cashShort: boolean }[] }[] = []
  for (let i = 0; i < 30; i++) {
    const d = new Date(Date.now() + i * 86_400_000)
    const key = dateKeyOf(d)
    const items = accounts
      .filter(a => a.currentStatement?.dueDate === key && a.dueMinor > 0)
      .map(a => ({
        name: `${a.account.platform}${a.account.nickname ? '·' + a.account.nickname : ''}`,
        amountMinor: a.dueMinor,
        cashShort: snapshot.cashAvailableMinor < a.dueMinor,
      }))
    calDays.push({ key, label: `${d.getMonth() + 1}/${d.getDate()}`, items })
  }

  // —— 还款动作 ——
  async function doRepay() {
    if (!repayFor) return
    const n = parseFloat(repayAmount)
    if (isNaN(n) || n <= 0) return
    const amountMinor = Math.round(n * 100)
    const r = await recordRepayment(repayFor.account, amountMinor, repayMethod)
    setRepayFor(null)
    setRepayAmount('')
    if (r.minOnly && r.extraInterestMinor > 0) {
      notify(`⚠️ 已还款 ¥${n.toFixed(2)}，但只还了最低：剩余本金 30 天仍会滚利约 ¥${fmtYuan(r.extraInterestMinor)}`)
    } else {
      notify(`✅ 已向「${repayFor.account.platform}」还款 ¥${n.toFixed(2)}`)
    }
  }

  async function doCreate() {
    const def = PLATFORM_DEFAULT[createPlatform] ?? { rateType: 'apr' as const, feeRate: 18.0, minPayRatio: 0.1, graceDays: 38 }
    const limitYuan = parseFloat(createLimitText)
    const limitMinor = isNaN(limitYuan) || limitYuan <= 0 ? 0 : Math.round(limitYuan * 100)
    await createCreditAccount({
      platform: createPlatform,
      nickname: createNickname.trim() || createPlatform,
      creditLimitMinor: limitMinor,
      statementDay: Math.min(28, Math.max(1, createStDay)),
      dueDay: Math.min(28, Math.max(1, createDueDay)),
      graceDays: def.graceDays,
      minPayRatio: def.minPayRatio,
      rateType: def.rateType,
      feeRate: def.feeRate,
    })
    setShowCreate(false)
    setCreateNickname('')
    setCreateLimitText('')
    setCreateStDay(1)
    setCreateDueDay(9)
    notify(`✅ 已创建「${createPlatform}」负债账户`)
  }

  async function doEdit() {
    if (!editFor) return
    const limitYuan = parseFloat(editLimitText)
    const limitMinor = isNaN(limitYuan) || limitYuan <= 0 ? 0 : Math.round(limitYuan * 100)
    await updateCreditAccount(editFor.account.id, {
      nickname: editNickname.trim() || editFor.account.platform,
      creditLimitMinor: limitMinor,
      statementDay: Math.min(28, Math.max(1, editStDay)),
      dueDay: Math.min(28, Math.max(1, editDueDay)),
    })
    setEditFor(null)
    notify('✅ 账户信息已更新')
  }

  async function doDelete(acc: AccountStatus) {
    if (!window.confirm(`删除负债账户「${acc.account.platform}${acc.account.nickname ? '·' + acc.account.nickname : ''}」？其待还 ¥${fmtYuan(acc.principalRemMinor)} 将不再纳入统计。`)) return
    await deleteCreditAccount(acc.account.id)
    notify('🗑 账户已删除')
  }

  function openEdit(acc: AccountStatus) {
    setEditFor(acc)
    setEditNickname(acc.account.nickname)
    setEditLimitText(String(Math.round(acc.account.creditLimitMinor / 100)))
    setEditStDay(acc.account.statementDay)
    setEditDueDay(acc.account.dueDay)
  }

  return (
    <div style={{ position: 'relative', maxWidth: 1080 }}>
      {toast && (
        <div style={{
          position: 'fixed', top: 72, left: '50%', transform: 'translateX(-50%)',
          background: '#111111', color: '#FFFFFF', padding: '10px 24px', borderRadius: 12,
          fontSize: 14, fontWeight: 500, zIndex: 300,
          boxShadow: '0 4px 20px rgba(0,0,0,0.15)', maxWidth: '92vw',
        }}>
          {toast}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--color-text)', marginBottom: 4 }}>债务管理</h1>
          <p style={{ fontSize: 14, color: 'var(--color-text-secondary)', marginBottom: 20 }}>
            借来的每一分钱都有成本 · 当前情境：<b style={{ color: '#0040FF' }}>{SCENARIO_LABEL[scenario]}</b>
          </p>
        </div>
        <button onClick={() => setShowRecord(true)} className="btn-primary"
          style={{ padding: '9px 18px', fontSize: 13.5, borderRadius: 10, flexShrink: 0 }}>
          ＋ 记负债
        </button>
      </div>

      {/* 首次使用引导 */}
      {accounts.length === 0 && (
        <div className="card" style={{ padding: 32, textAlign: 'center', marginBottom: 20, background: '#E4E6E6', border: '1.5px dashed #C0C4C4' }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>🛡️</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#111111', marginBottom: 6 }}>还没有负债账户</div>
          <div style={{ fontSize: 13, color: '#888888', marginBottom: 16, lineHeight: 1.8 }}>
            先绑定花呗 / 白条 / 抖音月付 / 先用后付 / 信用卡账户，之后用它们消费会自动记入待还，
            <br />本页与 AI 顾问会帮你算出真实利率、还款顺序与清零计划。
          </div>
          <button onClick={() => setShowCreate(true)} className="btn-primary" style={{ padding: '10px 28px', fontSize: 14, borderRadius: 10 }}>
            ＋ 创建第一个负债账户
          </button>
        </div>
      )}

      {/* ============ KPI 4 卡 ============ */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: '#888888', fontWeight: 500 }}>总负债</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#111111', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
            ¥{fmtYuanShort(snapshot.creditPrincipalMinor)}
          </div>
          <div style={{ fontSize: 11.5, color: momPct >= 0 ? '#F43F5E' : '#22D3EE', marginTop: 4 }}>
            {momPct >= 0 ? '▲' : '▼'} {Math.abs(momPct)}% vs 上月
          </div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: '#888888', fontWeight: 500 }}>月还款</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#111111', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
            ¥{fmtYuanShort(snapshot.currentDueMinor)}
          </div>
          <div style={{ fontSize: 11.5, color: budgetRepayPct > 40 ? '#DC2626' : budgetRepayPct > 25 ? '#F59E0B' : '#888888', marginTop: 4 }}>
            占月预算 {budgetRepayPct}%
          </div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: '#888888', fontWeight: 500 }}>平均真实利率</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#0040FF', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
            {snapshot.avgRealApr}%
          </div>
          <div style={{ fontSize: 11.5, color: '#888888', marginTop: 4 }}>按待还加权</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: '#888888', fontWeight: 500 }}>负债收入比</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: dtiColor, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
            {metrics.debtIncomePct}%
          </div>
          <div style={{ fontSize: 11.5, color: dtiColor, marginTop: 4 }}>
            {metrics.debtIncomePct > 40 ? '⚠️ 红色警戒，优先止血' : metrics.debtIncomePct > 30 ? '偏高，注意控制' : '正常，压力可控'}
          </div>
        </div>
      </div>

      {/* ============ 图区 2×2 ============ */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginBottom: 20 }}>
        {/* 图1 平台分布 */}
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#111111', marginBottom: 8 }}>平台分布</div>
          {pieData.length === 0 ? (
            <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888888', fontSize: 12.5 }}>暂无待还负债</div>
          ) : (
            <div style={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={48} outerRadius={72} paddingAngle={3}>
                    {pieData.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: TooltipValueType | undefined, n) => [`¥${v ?? 0}`, String(n)]} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* 图2 burn-down */}
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#111111', marginBottom: 8 }}>剩余待还趋势（近 12 月）</div>
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={burnData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#C0C4C4" />
                <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#888888' }} />
                <YAxis tick={{ fontSize: 10, fill: '#888888' }} width={36} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: TooltipValueType | undefined) => [`¥${v ?? 0}`, '待还']} />
                <Line type="monotone" dataKey="value" stroke="#0040FF" strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* 图3 真实利率对比 */}
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#111111', marginBottom: 8 }}>真实年化利率对比</div>
          {rateData.length === 0 ? (
            <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888888', fontSize: 12.5 }}>暂无待还负债</div>
          ) : (
            <div style={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rateData} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#C0C4C4" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: '#888888' }} />
                  <YAxis type="category" dataKey="name" width={86} tick={{ fontSize: 10.5, fill: '#888888' }} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: TooltipValueType | undefined) => [`${v ?? 0}%`, '年化']} />
                  <ReferenceLine x={2} stroke="#F59E0B" strokeDasharray="4 4" label={{ value: '储蓄 2%', position: 'top', fontSize: 10, fill: '#f59e0b' }} />
                  <Bar dataKey="rate" radius={[0, 6, 6, 0]}>
                    {rateData.map((_, i) => <Cell key={i} fill={rateData[i].rate > 2 ? '#F43F5E' : '#0040FF'} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* 图4 未来6月还款堆叠 */}
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#111111', marginBottom: 8 }}>未来 6 个月还款</div>
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stackData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#C0C4C4" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#888888' }} />
                <YAxis tick={{ fontSize: 10, fill: '#888888' }} width={36} />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 10.5 }} />
                {fNames.map((n, i) => (
                  <Bar key={n} dataKey={n} stackId="a" fill={PALETTE[i % PALETTE.length]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* ============ 还款规划区 ============ */}
      {hasDebt && (plans && bestPlan ? (
        <div className="card" style={{ padding: 20, marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111111' }}>📊 还款规划</div>
            <div style={{ fontSize: 12.5, color: '#888888' }}>每月可用还款 ¥{fmtYuan(snapshot.disposableMinor)}（真实可支配余额）</div>
          </div>
          <div className="stack-on-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div style={{ background: '#E4E6E6', border: bestPlan.strategy === 'snowball' ? '1.5px solid #0040FF' : '1px solid #C0C4C4', borderRadius: 12, padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0040FF', marginBottom: 6 }}>🥌 雪球法（先还小额）</div>
              <div style={{ fontSize: 13, color: '#111111', lineHeight: 1.8 }}>
                预计 <b style={{ color: '#0040FF', fontVariantNumeric: 'tabular-nums' }}>{plans.snowball.months}</b> 个月清零 · 总利息 <b style={{ color: '#0040FF', fontVariantNumeric: 'tabular-nums' }}>¥{fmtYuan(plans.snowball.totalInterestMinor)}</b>
              </div>
            </div>
            <div style={{ background: '#E4E6E6', border: bestPlan.strategy === 'avalanche' ? '1.5px solid #22D3EE' : '1px solid #C0C4C4', borderRadius: 12, padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#22D3EE', marginBottom: 6 }}>🗻 雪崩法（先还高利率）</div>
              <div style={{ fontSize: 13, color: '#111111', lineHeight: 1.8 }}>
                预计 <b style={{ color: '#22D3EE', fontVariantNumeric: 'tabular-nums' }}>{plans.avalanche.months}</b> 个月清零 · 总利息 <b style={{ color: '#22D3EE', fontVariantNumeric: 'tabular-nums' }}>¥{fmtYuan(plans.avalanche.totalInterestMinor)}</b>
              </div>
            </div>
          </div>
          <div style={{ background: '#E4E6E6', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 10, padding: '10px 14px', fontSize: 12.5, color: '#f59e0b', lineHeight: 1.8 }}>
            <b>推荐：{bestPlan.strategy === 'avalanche' ? '雪崩法' : '雪球法'}</b> —— {bestPlan.strategy === 'avalanche'
              ? `先还高利率能省最多利息（最高 ${metrics.rateRanking[0]?.realApr ?? 0}% vs 最低 ${metrics.rateRanking[metrics.rateRanking.length - 1]?.realApr ?? 0}%）`
              : `先还小额能快速清零拿到正反馈`}
            <div style={{ marginTop: 4 }}>还款顺序：{bestPlan.order.map((o, i) => `${i + 1}. ${o.name}（${o.realApr}%）`).join(' → ')}</div>
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 24, marginBottom: 20, textAlign: 'center' }}>
          <div style={{ fontSize: 13.5, color: '#888888', lineHeight: 1.8 }}>
            每月可支配还款 ¥0，暂时无法规划还款顺序
            <div style={{ fontSize: 12, color: '#888888', marginTop: 6 }}>先记一笔收入，或点击下方「💰 记一笔还款」开始还第一笔。</div>
          </div>
        </div>
      ))}

      {/* ============ 债务明细卡 ============ */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#111111' }}>负债账户</div>
          <button onClick={() => setShowCreate(true)}
            style={{ padding: '7px 14px', borderRadius: 10, border: '1.5px dashed #C0C4C4', background: '#E4E6E6', color: '#0040FF', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
            ＋ 绑定新账户
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {accounts.map(a => {
            const cur = a.currentStatement
            const progress = cur && cur.statementAmtMinor > 0 ? Math.min(100, Math.round((cur.paidAmtMinor / cur.statementAmtMinor) * 100)) : 0
            const warnInterest = a.isMinOnly ? minPaymentInterestWarn(a.principalRemMinor, a.dailyRate, 30) : 0
            const isPriority = localStorage.getItem('debtPriorityAccountId') === a.account.id
            return (
              <div key={a.account.id} className="card" style={{ padding: 18 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: '#111111' }}>{a.account.platform}{a.account.nickname && a.account.nickname !== a.account.platform ? `·${a.account.nickname}` : ''}</span>
                      {isPriority && <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: '#E4E6E6', color: '#0040FF' }}>🎯 优先</span>}
                      {a.isMinOnly && <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: '#FEF2F2', color: '#DC2626' }}>⚠️ 只还最低</span>}
                      {a.realApr > 2 && <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: '#FEF2F2', color: '#DC2626' }}>利率 {a.realApr}% &gt; 储蓄</span>}
                    </div>
                    {a.currentStatement ? (
                      <div style={{ fontSize: 12, color: '#888888', marginTop: 6, lineHeight: 1.8 }}>
                        账单日 {a.account.statementDay} 号 · 还款日 {a.account.dueDay} 号 · 免息 {a.account.graceDays} 天 · 额度 ¥{fmtYuanShort(a.account.creditLimitMinor)}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: '#888888', marginTop: 6 }}>自定义债务 · 按真实年化计入总负债与利率排名</div>
                    )}
                    {cur && (
                      <div style={{ marginTop: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: '#888888', marginBottom: 4 }}>
                          <span>本期已还 ¥{fmtYuan(cur.paidAmtMinor)} / ¥{fmtYuan(cur.statementAmtMinor)}</span>
                          <span>{progress}%</span>
                        </div>
                        <div style={{ height: 6, borderRadius: 3, background: '#E4E6E6', overflow: 'hidden' }}>
                          <div style={{ height: '100%', borderRadius: 3, background: a.isMinOnly ? '#F59E0B' : '#0040FF', width: `${progress}%`, transition: 'width 0.3s' }} />
                        </div>
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: 12, color: '#888888' }}>剩余待还</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: a.principalRemMinor > 0 ? '#111111' : '#22D3EE', fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
                      ¥{fmtYuanShort(a.principalRemMinor)}
                    </div>
                    <div style={{ fontSize: 11.5, color: '#888888', marginTop: 2 }}>真实年化 {a.realApr}%</div>
                  </div>
                </div>
                {a.isMinOnly && warnInterest > 0 && (
                  <div style={{ marginTop: 12, background: '#FEF2F2', border: '1px solid rgba(220,38,38,0.35)', borderRadius: 10, padding: '9px 12px', fontSize: 12, color: '#DC2626', lineHeight: 1.7 }}>
                    ⚠️ 只还最低还款会利滚利：剩余本金 ¥{fmtYuanShort(a.principalRemMinor)} 按日计息，30 天将多产生约 <b>¥{fmtYuan(warnInterest)}</b> 利息。建议尽快全额结清。
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                  {a.currentStatement ? (
                    <>
                      <button onClick={() => setRepayFor(a)} disabled={a.principalRemMinor <= 0}
                        style={{ padding: '8px 16px', borderRadius: 10, border: 'none', background: '#0040FF', color: '#FFFFFF', fontSize: 13, fontWeight: 600, cursor: a.principalRemMinor <= 0 ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-stack)', opacity: a.principalRemMinor <= 0 ? 0.5 : 1 }}>
                        💰 记一笔还款
                      </button>
                      <button onClick={() => openEdit(a)}
                        style={{ padding: '8px 16px', borderRadius: 10, border: '1px solid #C0C4C4', background: '#D8DADA', color: '#111111', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
                        ✏️ 编辑
                      </button>
                      <button onClick={() => void doDelete(a)}
                        style={{ padding: '8px 16px', borderRadius: 10, border: 'none', background: 'transparent', color: '#888888', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
                        删除
                      </button>
                    </>
                  ) : (
                    <span style={{ fontSize: 12, color: '#888888' }}>历史自定义债务：还款请在记账页记一笔「还款」，或删除后重新绑定负债账户</span>
                  )}
                </div>
              </div>
            )
          })}
          {accounts.length === 0 && (
            <div style={{ textAlign: 'center', color: '#888888', fontSize: 13, padding: '24px 0' }}>
              绑定账户后，这里会展示每笔负债的进度与利率
            </div>
          )}
        </div>
      </div>

      {/* ============ 逾期日历热力 ============ */}
      <div className="card" style={{ padding: 20, marginBottom: 20 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#111111', marginBottom: 4 }}>📅 未来 30 天还款日历</div>
        <div style={{ fontSize: 12, color: '#888888', marginBottom: 12, lineHeight: 1.7 }}>
          <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, background: '#22D3EE', marginRight: 4, verticalAlign: 'middle' }} />现金充足
          <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, background: '#DC2626', marginRight: 4, marginLeft: 14, verticalAlign: 'middle' }} />现金不足（可用 ¥{fmtYuanShort(snapshot.cashAvailableMinor)}）
          <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, background: '#E4E6E6', marginRight: 4, marginLeft: 14, verticalAlign: 'middle' }} />无还款
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 5 }}>
          {calDays.map(d => {
            const busy = d.items.length > 0
            const bg = !busy ? '#E4E6E6' : d.items.every(x => !x.cashShort) ? '#22D3EE' : '#DC2626'
            const fg = !busy ? '#888888' : '#FFFFFF'
            return (
              <button key={d.key} onClick={() => setCalPick(d)}
                style={{
                  aspectRatio: '1', borderRadius: 8, border: calPick?.key === d.key ? '2px solid #0040FF' : '1px solid #E4E6E6',
                  background: bg, color: fg, fontSize: 11.5, fontWeight: busy ? 700 : 400, cursor: 'pointer',
                  fontFamily: 'var(--font-stack)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                }}>
                <span>{d.label}</span>
                {busy && <span style={{ fontSize: 9, marginTop: 1 }}>¥{fmtYuanShort(d.items.reduce((s, x) => s + x.amountMinor, 0))}</span>}
              </button>
            )
          })}
        </div>
        {calPick && (
          <div style={{ marginTop: 12, background: '#E4E6E6', border: '1px solid #C0C4C4', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0040FF', marginBottom: 8 }}>{calPick.label} 到期的还款</div>
            {calPick.items.length === 0 ? (
              <div style={{ fontSize: 12.5, color: '#888888' }}>这一天没有账单到期</div>
            ) : (
              calPick.items.map((x, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#111111', padding: '5px 0' }}>
                  <span>{x.name}</span>
                  <span style={{ fontWeight: 600, color: x.cashShort ? '#DC2626' : '#22D3EE' }}>
                    ¥{fmtYuan(x.amountMinor)}{x.cashShort ? '（现金不足）' : ''}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* ============ 债务顾问面板 ============ */}
      <div className="card" style={{ padding: 20, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#111111' }}>🧑‍💼 债务顾问</div>
          <span style={{ fontSize: 11.5, color: '#888888' }}>情境：{SCENARIO_LABEL[scenario]} · 数字全部由代码实时计算</span>
        </div>
        <div style={{ fontSize: 12, color: '#888888', marginBottom: 12 }}>回答里带按钮，点击可直接执行（生成计划 / 设为优先 / 多还500 / 调储蓄 / 设提醒）</div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <input value={adviceQ} onChange={(e) => setAdviceQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && adviceQ.trim()) void askAdvice(adviceQ.trim()) }}
            placeholder="问问债务顾问，如：我的债怎么还？先还哪个？"
            style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
          <button onClick={() => { if (adviceQ.trim()) void askAdvice(adviceQ.trim()) }} disabled={adviceLoading || !adviceQ.trim()}
            style={{ padding: '0 22px', borderRadius: 10, border: 'none', background: '#0040FF', color: '#FFFFFF', fontSize: 13.5, fontWeight: 600, cursor: (adviceLoading || !adviceQ.trim()) ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-stack)', opacity: (adviceLoading || !adviceQ.trim()) ? 0.5 : 1 }}>
            {adviceLoading ? '分析中…' : '问顾问'}
          </button>
        </div>

        {adviceLoading && !adviceHtml && (
          <div style={{ fontSize: 13, color: '#888888', padding: '12px 0' }}>正在结合你的负债快照分析…</div>
        )}
        {adviceHtml && (
          <div style={{ background: '#E4E6E6', border: '1px solid #E4E6E6', borderRadius: 12, padding: 14 }}>
            <AiHtml html={adviceHtml} onAction={(a) => { void execDebtAction(a, { info: notify }) }} />
          </div>
        )}
      </div>

      {/* ============ 记一笔还款 Modal ============ */}
      {repayFor && (
        <div style={modalOverlay} onClick={() => setRepayFor(null)}>
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111111', marginBottom: 4 }}>
              向「{repayFor.account.platform}{repayFor.account.nickname && repayFor.account.nickname !== repayFor.account.platform ? '·' + repayFor.account.nickname : ''}」还款
            </div>
            <div style={{ fontSize: 12.5, color: '#888888', marginBottom: 16 }}>
              剩余待还 ¥{fmtYuan(repayFor.principalRemMinor)} · 本期最低 ¥{fmtYuan(repayFor.minPaymentMinor)}
            </div>
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>还款金额（元）</div>
            <input value={repayAmount} onChange={(e) => setRepayAmount(e.target.value)} inputMode="decimal" autoFocus
              placeholder="如 500"
              style={{ ...inputStyle, fontSize: 18, fontWeight: 600, marginBottom: 14 }} />
            <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
              {['bank', 'cash'].map(m => (
                <button key={m} onClick={() => setRepayMethod(m as 'bank' | 'cash')}
                  style={{
                    flex: 1, padding: '9px 0', borderRadius: 10, cursor: 'pointer', fontFamily: 'var(--font-stack)',
                    border: repayMethod === m ? '1.5px solid #0040FF' : '1px solid #C0C4C4',
                    background: repayMethod === m ? '#E4E6E6' : '#FFFFFF',
                    color: repayMethod === m ? '#0040FF' : 'var(--color-text-secondary)', fontSize: 13, fontWeight: 600,
                  }}>
                  {m === 'bank' ? '💳 银行卡还' : '💵 现金还'}
                </button>
              ))}
            </div>
            {repayFor.minPaymentMinor > 0 && repayFor.principalRemMinor > 0 && (
              <div style={{ fontSize: 12, color: '#f59e0b', background: '#E4E6E6', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 10, padding: '10px 12px', lineHeight: 1.7, marginBottom: 16 }}>
                只还最低（≤ ¥{fmtYuan(repayFor.minPaymentMinor)}）会触发利滚利，系统会提示 30 天多产生的利息。
              </div>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => void doRepay()} disabled={!(parseFloat(repayAmount) > 0)}
                className="btn-primary" style={{ flex: 1, padding: '11px 0', fontSize: 14, borderRadius: 10, opacity: parseFloat(repayAmount) > 0 ? 1 : 0.5 }}>
                ✓ 确认还款
              </button>
              <button onClick={() => setRepayFor(null)}
                style={{ padding: '11px 20px', borderRadius: 10, border: '1px solid #C0C4C4', background: '#D8DADA', color: 'var(--color-text-secondary)', fontSize: 14, cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ 创建账户 Modal ============ */}
      {showCreate && (
        <div style={modalOverlay} onClick={() => setShowCreate(false)}>
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111111', marginBottom: 4 }}>绑定负债账户</div>
            <div style={{ fontSize: 12.5, color: '#888888', marginBottom: 16 }}>用它消费=借来的钱，自动纳入待还与还款规划</div>

            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>平台</div>
            <select value={createPlatform} onChange={(e) => setCreatePlatform(e.target.value as CreditAccount['platform'])}
              style={{ ...inputStyle, background: '#D8DADA', marginBottom: 14 }}>
              {PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>

            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>账户昵称</div>
            <input value={createNickname} onChange={(e) => setCreateNickname(e.target.value)}
              placeholder={`如 ${createPlatform}主卡`}
              style={{ ...inputStyle, marginBottom: 14 }} />

            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>授信额度（元）</div>
            <input value={createLimitText} onChange={(e) => setCreateLimitText(e.target.value)} inputMode="decimal" placeholder="如 5000"
              style={{ ...inputStyle, marginBottom: 14 }} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>账单日</div>
                <input type="number" min={1} max={28} value={createStDay} onChange={(e) => setCreateStDay(Number(e.target.value))} style={inputStyle} />
              </div>
              <div>
                <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>还款日</div>
                <input type="number" min={1} max={28} value={createDueDay} onChange={(e) => setCreateDueDay(Number(e.target.value))} style={inputStyle} />
              </div>
            </div>

            <div style={{ fontSize: 12, color: '#888888', background: '#E4E6E6', border: '1px solid #C0C4C4', borderRadius: 10, padding: '10px 12px', marginBottom: 16, lineHeight: 1.7 }}>
              {(() => {
                const def = PLATFORM_DEFAULT[createPlatform]
                if (!def) return '费率以平台实际为准'
                const rateText = def.rateType === 'day_fee' ? `日费率 ${def.feeRate}（万${def.feeRate * 10000}/日）`
                  : def.rateType === 'installment_fee' ? `每期费率 ${def.feeRate * 100}%`
                  : `年化利率 ${def.feeRate}%`
                return `默认计息：${rateText} · 免息 ${def.graceDays} 天 · 最低还款比例 ${def.minPayRatio * 100}%`
              })()}
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => void doCreate()} className="btn-primary" style={{ flex: 1, padding: '11px 0', fontSize: 14, borderRadius: 10 }}>
                ✓ 创建账户
              </button>
              <button onClick={() => setShowCreate(false)}
                style={{ padding: '11px 20px', borderRadius: 10, border: '1px solid #C0C4C4', background: '#D8DADA', color: 'var(--color-text-secondary)', fontSize: 14, cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ 编辑账户 Modal ============ */}
      {editFor && (
        <div style={modalOverlay} onClick={() => setEditFor(null)}>
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111111', marginBottom: 16 }}>编辑账户</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>账户昵称</div>
            <input value={editNickname} onChange={(e) => setEditNickname(e.target.value)} style={{ ...inputStyle, marginBottom: 14 }} />
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>授信额度（元）</div>
            <input value={editLimitText} onChange={(e) => setEditLimitText(e.target.value)} inputMode="decimal" style={{ ...inputStyle, marginBottom: 14 }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>账单日</div>
                <input type="number" min={1} max={28} value={editStDay} onChange={(e) => setEditStDay(Number(e.target.value))} style={inputStyle} />
              </div>
              <div>
                <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>还款日</div>
                <input type="number" min={1} max={28} value={editDueDay} onChange={(e) => setEditDueDay(Number(e.target.value))} style={inputStyle} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => void doEdit()} className="btn-primary" style={{ flex: 1, padding: '11px 0', fontSize: 14, borderRadius: 10 }}>
                ✓ 保存修改
              </button>
              <button onClick={() => setEditFor(null)}
                style={{ padding: '11px 20px', borderRadius: 10, border: '1px solid #C0C4C4', background: '#D8DADA', color: 'var(--color-text-secondary)', fontSize: 14, cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ 记一笔新负债 Modal（标题栏 + TopBar 双入口共用） ============ */}
      <AddDebtModal
        open={showRecord}
        onClose={() => setShowRecord(false)}
        onSaved={() => setShowRecord(false)}
      />
    </div>
  )
}

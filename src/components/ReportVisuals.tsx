// oxlint-disable react/only-export-components -- 报告可视化组件库（图表组件 + 工具函数同文件，既定设计）
// ==================== AI 报告 / 冲动分析 可视化组件 ====================
// 数据全部由前端代码（数据库）算出，图表只做展示；交互：柱状图点击下钻、热力图点击看当天明细。
// 主色靛蓝 #0040FF / 青 #22D3EE，Light Indigo 规范。
import { useId, type ReactNode } from 'react'
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts'
import { CATEGORY_COLORS, colorOf } from './ReportCharts'

// ==================== 工具 ====================

const TOOLTIP_STYLE = {
  background: '#D8DADA', border: '1px solid #C0C4C4', borderRadius: 10, fontSize: 12,
  boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
}
const PALETTE = ['#0040FF', '#22D3EE', '#F59E0B', '#94AFFF', '#6B90FF', '#6B90FF', '#888888']

export function fmtY(n: number): string {
  return '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

// ==================== 基础组件 ====================

export function EmptyBox({ text }: { text: string }) {
  return <div style={{ textAlign: 'center', color: '#888888', fontSize: 13, padding: '26px 0' }}>{text}</div>
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, color: '#111111' }}>
        <span style={{ width: 4, height: 14, borderRadius: 2, background: '#0040FF' }} />
        {children}
      </div>
      {right}
    </div>
  )
}

export interface KpiDef {
  label: string
  value: string
  sub?: string
  color?: string
}

export function KpiRow({ kpis }: { kpis: KpiDef[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(kpis.length, 4)}, 1fr)`, gap: 10 }}>
      {kpis.map((k, i) => (
        <div key={i} style={{ background: '#E4E6E6', border: '1px solid #E4E6E6', borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ fontSize: 12, color: '#888888', fontWeight: 500, marginBottom: 4 }}>{k.label}</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: k.color || '#111111', fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>
            {k.value}
          </div>
          {k.sub && <div style={{ fontSize: 11, color: '#888888', marginTop: 3 }}>{k.sub}</div>}
        </div>
      ))}
    </div>
  )
}

export function ActionBtn({ children, onClick, color = '#0040FF', disabled }: {
  children: ReactNode; onClick: () => void; color?: string; disabled?: boolean
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: '9px 16px', borderRadius: 10, border: 'none', cursor: disabled ? 'default' : 'pointer',
      fontFamily: 'var(--font-stack)', background: color, color: '#FFFFFF', fontSize: 13, fontWeight: 600,
      boxShadow: `0 3px 10px ${color}44`, opacity: disabled ? 0.6 : 1,
    }}>{children}</button>
  )
}

// ==================== 1. 时段分布柱状图（点击柱下钻） ====================

export interface SlotRow { name: string; amount: number; count: number }

export function SlotBarChart({ data, onPick, height = 165 }: { data: SlotRow[]; onPick?: (row: SlotRow) => void; height?: number }) {
  if (!data.some(d => d.amount > 0)) return <EmptyBox text="该时段暂无支出记录" />
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#C0C4C4" vertical={false} />
        <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#888888' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: '#888888' }} axisLine={false} tickLine={false} width={38}
          tickFormatter={(v) => String(v)} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v, n) => [fmtY(Number(v)), n === 'amount' ? '金额' : '笔数']} />
        <Bar dataKey="amount" name="金额" fill="#0040FF" radius={[5, 5, 0, 0]} maxBarSize={34}
          onClick={(e) => onPick && onPick(e as unknown as SlotRow)} style={{ cursor: onPick ? 'pointer' : 'default' }}>
          {data.map((d, i) => <Cell key={i} fill={d.amount > 0 ? PALETTE[i % PALETTE.length] : '#C0C4C4'} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// ==================== 2. 分类环形图（中心显示合计） ====================

export interface NamedAmt { name: string; amount: number }

export function CategoryRing({ data, centerTitle, centerValue, height = 190 }: {
  data: NamedAmt[]; centerTitle?: string; centerValue?: string; height?: number
}) {
  const rows = data.slice(0, 6)
  const total = rows.reduce((s, d) => s + d.amount, 0)
  if (rows.length === 0 || total <= 0) return <EmptyBox text="暂无支出数据" />
  return (
    <div style={{ position: 'relative', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={rows} dataKey="amount" nameKey="name" innerRadius="64%" outerRadius="86%" paddingAngle={2}>
            {rows.map((d, i) => <Cell key={d.name} fill={CATEGORY_COLORS[d.name] || PALETTE[i % PALETTE.length]} />)}
          </Pie>
          <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v, n) => [fmtY(Number(v)), String(n)]} />
        </PieChart>
      </ResponsiveContainer>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
        {centerTitle && <span style={{ fontSize: 11, color: '#888888' }}>{centerTitle}</span>}
        <span style={{ fontSize: 19, fontWeight: 700, color: '#111111', fontVariantNumeric: 'tabular-nums' }}>{centerValue}</span>
      </div>
    </div>
  )
}

// ==================== 3. 周每日支出折线 + 日均预算参考虚线 ====================

export function WeekLineChart({ data, budgetLine }: { data: Array<{ date: string; amount: number }>; budgetLine: number }) {
  if (!data.some(d => d.amount > 0)) return <EmptyBox text="本周暂无支出记录" />
  return (
    <ResponsiveContainer width="100%" height={185}>
      <LineChart data={data} margin={{ top: 22, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#C0C4C4" vertical={false} />
        <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#888888' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: '#888888' }} axisLine={false} tickLine={false} width={38} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [fmtY(Number(v)), '支出']} />
        <ReferenceLine y={budgetLine} stroke="#F59E0B" strokeDasharray="6 4"
          label={{ value: `日均预算 ${fmtY(budgetLine)}`, position: 'insideTopRight', fontSize: 10, fill: '#F59E0B' }} />
        <Line type="monotone" dataKey="amount" name="支出" stroke="#0040FF" strokeWidth={2.5}
          dot={{ r: 3, fill: '#FFFFFF', stroke: '#0040FF', strokeWidth: 2 }} activeDot={{ r: 5 }} />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ==================== 4. 分类堆叠柱（本周 vs 上周，两组堆叠） ====================

export function CategoryStackChart({ stack }: { stack: Array<{ category: string; thisWeek: number; lastWeek: number }> }) {
  const cats = stack.slice(0, 6).map(s => s.category)
  const rows: Array<Record<string, number | string>> = [
    { name: '本周', ...Object.fromEntries(cats.map(c => ['t_' + c, stack.find(s => s.category === c)?.thisWeek || 0])) },
    { name: '上周', ...Object.fromEntries(cats.map(c => ['l_' + c, stack.find(s => s.category === c)?.lastWeek || 0])) },
  ]
  const anyData = cats.some(c => Number(rows[0]['t_' + c]) > 0 || Number(rows[1]['l_' + c]) > 0)
  if (!anyData) return <EmptyBox text="本周/上周暂无支出" />
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={rows} barGap={12} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#C0C4C4" vertical={false} />
        <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#111111', fontWeight: 600 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: '#888888' }} axisLine={false} tickLine={false} width={38} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v, n) => [fmtY(Number(v)), String(n)]} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {cats.map(c => (
          <Bar key={'t' + c} dataKey={'t_' + c} name={`本周·${c}`} stackId="this" fill={colorOf(c)} maxBarSize={42} />
        ))}
        {cats.map(c => (
          <Bar key={'l' + c} dataKey={'l_' + c} name={`上周·${c}`} stackId="last" fill={colorOf(c)} opacity={0.5} maxBarSize={42} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

// ==================== 5. 近12个月收支趋势折线 ====================

export function MonthTrendLine({ data }: { data: Array<{ month: string; expense: number; income: number }> }) {
  if (!data.some(d => d.expense > 0 || d.income > 0)) return <EmptyBox text="近12个月暂无收支数据" />
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 14, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#C0C4C4" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#888888' }} axisLine={false} tickLine={false} interval={1} />
        <YAxis tick={{ fontSize: 10, fill: '#888888' }} axisLine={false} tickLine={false} width={36} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v, n) => [fmtY(Number(v)), n === 'expense' ? '支出' : '收入']} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Line type="monotone" dataKey="expense" name="支出" stroke="#0040FF" strokeWidth={2.5}
          dot={{ r: 2.5, fill: '#FFFFFF', stroke: '#0040FF', strokeWidth: 2 }} />
        <Line type="monotone" dataKey="income" name="收入" stroke="#22D3EE" strokeWidth={2.5}
          dot={{ r: 2.5, fill: '#FFFFFF', stroke: '#22D3EE', strokeWidth: 2 }} />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ==================== 6. 负债 burn-down 折线（近12个月） ====================

export function DebtBurnDown({ data }: { data: Array<{ month: string; debt: number }> }) {
  if (!data.some(d => d.debt > 0)) return <EmptyBox text="近12个月暂无负债数据" />
  return (
    <ResponsiveContainer width="100%" height={170}>
      <LineChart data={data} margin={{ top: 14, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#C0C4C4" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#888888' }} axisLine={false} tickLine={false} interval={1} />
        <YAxis tick={{ fontSize: 10, fill: '#888888' }} axisLine={false} tickLine={false} width={36} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [fmtY(Number(v)), '负债']} />
        <Line type="monotone" dataKey="debt" name="负债" stroke="#22D3EE" strokeWidth={2.5}
          dot={{ r: 2.5, fill: '#FFFFFF', stroke: '#22D3EE', strokeWidth: 2 }} />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ==================== 7. 五维健康分进度条 ====================

export function HealthBars({ dims }: { dims: Array<{ name: string; score: number }> }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {dims.map(d => (
        <div key={d.name}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#111111', marginBottom: 4 }}>
            <span>{d.name}</span>
            <b style={{ color: d.score >= 70 ? '#22D3EE' : d.score >= 45 ? '#F59E0B' : '#D73333', fontVariantNumeric: 'tabular-nums' }}>{d.score}</b>
          </div>
          <div style={{ height: 7, background: '#E4E6E6', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.max(2, d.score)}%`, background: 'linear-gradient(90deg,#0040FF,#22D3EE)', borderRadius: 4 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ==================== 8. 储蓄进度环（SVG + 里程碑刻度） ====================

export function RingPct({ pct, label, milestones = [] }: { pct: number; label?: string; milestones?: number[] }) {
  const gid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const size = 120, strokeW = 10
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
        {milestones.map(m => {
          const a = (Math.min(100, Math.max(0, m)) / 100) * Math.PI * 2 - Math.PI / 2
          const x = size / 2 + r * Math.cos(a)
          const y = size / 2 + r * Math.sin(a)
          return <circle key={m} cx={x} cy={y} r={3.2} fill="#FFFFFF" stroke="#C0C4C4" strokeWidth={2} />
        })}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: '#111111', fontVariantNumeric: 'tabular-nums' }}>{Math.round(pct)}%</span>
        {label && <span style={{ fontSize: 10, color: '#888888', marginTop: 1 }}>{label}</span>}
      </div>
    </div>
  )
}

// ==================== 9. 横向条形图（平台金额排行，靛蓝渐变） ====================

export function HBarList({ data, gradient = ['#0040FF', '#22D3EE'], amountColor = '#0040FF' }: {
  data: Array<{ name: string; value: number }>; gradient?: [string, string]; amountColor?: string
}) {
  const max = Math.max(1, ...data.map(d => d.value))
  if (data.length === 0) return <EmptyBox text="暂无数据" />
  const gid = useId().replace(/[^a-zA-Z0-9]/g, '')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <defs>
          <linearGradient id={`hb${gid}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={gradient[0]} /><stop offset="100%" stopColor={gradient[1]} />
          </linearGradient>
        </defs>
      </svg>
      {data.map(d => (
        <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 62, fontSize: 12, color: '#111111', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>{d.name}</span>
          <div style={{ flex: 1, height: 16, background: '#E4E6E6', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(d.value / max) * 100}%`, background: `url(#hb${gid})`, borderRadius: 8 }} />
          </div>
          <span style={{ width: 78, fontSize: 12, fontWeight: 700, color: amountColor, fontVariantNumeric: 'tabular-nums', textAlign: 'right', flexShrink: 0 }}>{fmtY(d.value)}</span>
        </div>
      ))}
    </div>
  )
}

// ==================== 10. 冲动强度分布（迷你条形：高/中/低） ====================

export function StrengthBars({ dist }: { dist: { high: number; medium: number; low: number } }) {
  const rows = [
    { label: '高', n: dist.high, color: '#F43F5E' },
    { label: '中', n: dist.medium, color: '#F59E0B' },
    { label: '低', n: dist.low, color: '#F59E0B' },
  ]
  const max = Math.max(1, ...rows.map(r => r.n))
  if (max <= 0) return <EmptyBox text="暂无冲动记录" />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {rows.map(r => (
        <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 22, fontSize: 12, color: '#888888', flexShrink: 0 }}>{r.label}</span>
          <div style={{ flex: 1, height: 13, background: '#E4E6E6', borderRadius: 6.5, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(r.n / max) * 100}%`, background: r.color, borderRadius: 6.5, transition: 'width 0.5s ease' }} />
          </div>
          <span style={{ width: 22, fontSize: 12, fontWeight: 700, color: '#111111', fontVariantNumeric: 'tabular-nums', textAlign: 'right', flexShrink: 0 }}>{r.n}</span>
        </div>
      ))}
    </div>
  )
}

// ==================== 11. 近30天冲动日历热力图（SVG/网格手写） ====================

export interface HeatCell { date: string; amount: number }

function heatColor(amt: number): string {
  if (amt <= 0) return '#E4E6E6'
  if (amt < 30) return 'rgba(244,63,94,0.25)'
  if (amt < 100) return '#F43F5E'
  return '#DC2626'
}

export function Heatmap({ data, onPick }: { data: HeatCell[]; onPick?: (c: HeatCell) => void }) {
  const today = new Date()
  const start = new Date(today)
  start.setDate(start.getDate() - (data.length - 1))
  const cells = data.map((d, i) => {
    const day = new Date(start)
    day.setDate(start.getDate() + i)
    return { ...d, dow: (day.getDay() + 6) % 7 } // 周一=0
  })
  const firstDow = cells[0]?.dow ?? 0
  if (data.length === 0) return <EmptyBox text="暂无数据" />
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
        {['一', '二', '三', '四', '五', '六', '日'].map(w => (
          <div key={w} style={{ textAlign: 'center', fontSize: 10, color: '#888888' }}>{w}</div>
        ))}
        {Array.from({ length: firstDow }).map((_, i) => <div key={'e' + i} />)}
        {cells.map(c => (
          <div key={c.date} onClick={() => onPick && onPick(c)}
            title={`${c.date} · ${c.amount > 0 ? fmtY(c.amount) : '无冲动'}`}
            style={{ cursor: onPick ? 'pointer' : 'default' }}>
            <div style={{
              height: 30, borderRadius: 7, background: heatColor(c.amount),
              border: c.amount > 0 ? '1px solid rgba(220,38,38,0.25)' : '1px solid #E4E6E6',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: c.amount > 0 ? '#FFFFFF' : '#888888' }}>
                {c.date.slice(3)}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginTop: 9, fontSize: 11, color: '#888888' }}>
        <span>无冲动</span>
        {['#E4E6E6', 'rgba(244,63,94,0.25)', '#F43F5E', '#DC2626'].map(c => (
          <span key={c} style={{ width: 12, height: 12, borderRadius: 3, background: c, border: '1px solid rgba(0,0,0,0.06)' }} />
        ))}
        <span>金额越高颜色越深</span>
      </div>
    </div>
  )
}

// ==================== 12. 下钻明细弹层（底部抽屉） ====================

export interface TxItem {
  merchant: string
  amount: number
  sub?: string
  extra?: ReactNode
}

export function TxSheet({ title, txs, onClose }: { title: string; txs: TxItem[]; onClose: () => void }) {
  if (!title) return null
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1400, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.35)' }} />
      <div style={{
        position: 'relative', width: 'min(560px, 100vw)', maxHeight: '70vh', overflow: 'auto',
        background: '#D8DADA', borderRadius: '18px 18px 0 0', padding: '18px 20px 28px',
        animation: 'fadeInUp 0.25s ease both',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#111111' }}>{title}</div>
          <button onClick={onClose}
            style={{ border: 'none', background: '#E4E6E6', borderRadius: '50%', width: 26, height: 26, cursor: 'pointer', fontSize: 12, color: '#888888' }}>
            ✕
          </button>
        </div>
        {txs.length === 0 ? <EmptyBox text="该时段暂无交易明细" /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {txs.map((t, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', background: '#E4E6E6', borderRadius: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.merchant}</div>
                  {t.sub && <div style={{ fontSize: 11, color: '#888888', marginTop: 1 }}>{t.sub}</div>}
                </div>
                {t.extra && <div style={{ fontSize: 11, color: '#0040FF', flexShrink: 0 }}>{t.extra}</div>}
                <div style={{ fontSize: 13.5, fontWeight: 700, color: '#111111', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtY(t.amount)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

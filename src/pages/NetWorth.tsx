import { useState, useEffect } from 'react'
import {
  addBalanceSnapshot, deleteBalanceSnapshot, getAllBalanceSnapshots,
} from '../db/crud'
import type { BalanceSnapshot } from '../types'
import { getTotalDebtMinor } from '../debt/debtContext'

// ==================== 工具 ====================

function pad2(n: number): string { return String(n).padStart(2, '0') }

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function fmt(minor: number): string {
  const sign = minor < 0 ? '-' : ''
  const v = minor < 0 ? -minor : minor
  return sign + '¥' + (v / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

function fmtShort(minor: number): string {
  const v = Math.abs(minor) / 100
  const sign = minor < 0 ? '-' : ''
  if (v >= 10000) return `${sign}¥${(v / 10000).toFixed(1)}万`
  return `${sign}¥${Math.round(v)}`
}

function netWorth(s: BalanceSnapshot): number {
  return s.cashMinor + s.bankMinor + s.wechatMinor + s.alipayMinor + s.otherMinor - s.liabilityMinor
}

function fmtDate(date: string): string {
  const [, m, d] = date.split('-').map(Number)
  return `${m}月${d}日`
}

// ==================== SVG 净资产曲线 ====================

function NetWorthChart({ snaps }: { snaps: BalanceSnapshot[] }) {
  const W = 760
  const H = 250
  const PAD = { top: 16, right: 14, bottom: 28, left: 14 }
  const sorted = [...snaps].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))
  const values = sorted.map(netWorth)
  if (values.length === 0) return null
  const max = Math.max(...values, 0)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const x = (i: number) => PAD.left + (values.length === 1 ? innerW / 2 : (i / (values.length - 1)) * innerW)
  const y = (v: number) => PAD.top + innerH - ((v - min) / range) * innerH
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
  // 面积图
  const area = `M${x(0).toFixed(1)},${y(0).toFixed(1)} ${pts.join(' ')} L${x(values.length - 1).toFixed(1)},${(PAD.top + innerH).toFixed(1)} L${x(0).toFixed(1)},${(PAD.top + innerH).toFixed(1)} Z`
  const gradId = 'nwGrad'

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0040FF" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#0040FF" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* 零轴线 */}
        {min < 0 && max > 0 && (
          <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="#C0C4C4" strokeDasharray="4 4" />
        )}
        <path d={area} fill={`url(#${gradId})`} />
        <polyline
          points={pts.join(' ')}
          fill="none" stroke="#0040FF" strokeWidth={2.5}
          strokeLinecap="round" strokeLinejoin="round"
        />
        {values.map((v, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(v)} r={3.5} fill="#fff" stroke="#0040FF" strokeWidth={2} />
            <text x={x(i)} y={H - 8} textAnchor="middle" fontSize={10} fill="#A0A4A4">
              {fmtDate(sorted[i].date)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}

// ==================== 页面 ====================

const ASSET_FIELDS: Array<{ key: 'cashMinor' | 'bankMinor' | 'wechatMinor' | 'alipayMinor' | 'otherMinor'; label: string; icon: string }> = [
  { key: 'cashMinor', label: '现金', icon: '💵' },
  { key: 'bankMinor', label: '银行卡', icon: '💳' },
  { key: 'wechatMinor', label: '微信', icon: '🟢' },
  { key: 'alipayMinor', label: '支付宝', icon: '🔵' },
  { key: 'otherMinor', label: '其他', icon: '📦' },
]

export default function NetWorth() {
  const [snaps, setSnaps] = useState<BalanceSnapshot[]>([])
  const [loaded, setLoaded] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({
    cashMinor: '', bankMinor: '', wechatMinor: '', alipayMinor: '', otherMinor: '', liabilityMinor: '',
  })
  const [note, setNote] = useState('')
  const [debtTotal, setDebtTotal] = useState(0)
  // 响应式：<900px 降单栏
  const [isWide, setIsWide] = useState(window.innerWidth >= 900)

  async function load() {
    const list = await getAllBalanceSnapshots()
    list.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
    setSnaps(list)
    setLoaded(true)
  }

  useEffect(() => { void load() }, [])

  // 响应式：监听窗口宽度
  useEffect(() => {
    const h = () => setIsWide(window.innerWidth >= 900)
    window.addEventListener('resize', h)
    return () => window.removeEventListener('resize', h)
  }, [])

  // 负债合计（自动预填 liabilityMinor；含负债账户花呗/白条等待还）
  async function openForm() {
    const total = await getTotalDebtMinor()
    setDebtTotal(total)
    setValues({
      cashMinor: '', bankMinor: '', wechatMinor: '', alipayMinor: '', otherMinor: '',
      liabilityMinor: total > 0 ? String(total / 100) : '',
    })
    setNote('')
    setShowForm(true)
  }

  async function handleAdd() {
    const toMinor = (k: string) => {
      const n = parseFloat(values[k] || '0')
      return isNaN(n) || n < 0 ? 0 : Math.round(n * 100)
    }
    const s: Omit<BalanceSnapshot, 'id'> = {
      date: todayStr(),
      cashMinor: toMinor('cashMinor'),
      bankMinor: toMinor('bankMinor'),
      wechatMinor: toMinor('wechatMinor'),
      alipayMinor: toMinor('alipayMinor'),
      otherMinor: toMinor('otherMinor'),
      liabilityMinor: toMinor('liabilityMinor'),
      note: note.trim(),
      createdAt: new Date().toISOString(),
    }
    await addBalanceSnapshot(s)
    setShowForm(false)
    await load()
  }

  async function handleDelete(id: string) {
    if (!window.confirm('删除这条快照？')) return
    await deleteBalanceSnapshot(id)
    await load()
  }

  const last = snaps[0] ?? null
  const prev = snaps[1] ?? null
  const delta = last && prev ? netWorth(last) - netWorth(prev) : null

  // 每周提示：距上次快照超过 7 天
  const staleDays = (() => {
    if (!last) return null
    const d = new Date(last.date + 'T00:00:00')
    return Math.floor((Date.now() - d.getTime()) / 86_400_000)
  })()

  return (
    <div style={{ maxWidth: 1100, width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 4, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--color-text)', marginBottom: 2 }}>净资产追踪</h1>
          <p style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>每周记一次各账户余额，看清真实家底</p>
        </div>
      </div>

      {/* 每周提示 */}
      {loaded && staleDays !== null && staleDays >= 7 && (
        <div style={{
          margin: '16px 0', padding: '12px 16px', background: '#F0FDF4', border: '1px solid #BBF7D0',
          borderRadius: 12, fontSize: 13, color: '#166534',
        }}>
          ⏰ 该填本周快照了（距上次已 {staleDays} 天），点右栏「＋ 添加快照」
        </div>
      )}

      {/* 两栏布局：左 2/3 曲线大图 · 右 1/3 当前净资产 + 历史快照 */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: isWide ? '2fr 1fr' : '1fr',
        gap: 24,
        alignItems: 'start',
      }}>
        {/* ========== 左栏：净资产曲线（大图） ========== */}
        <div style={{ minWidth: 0 }}>
          {loaded && snaps.length > 0 ? (
            <div className="card" style={{ padding: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text)' }}>📈 净资产曲线</span>
                {last && (
                  <span style={{ fontSize: 12, color: '#A0A4A4' }}>最新记录 {last.date}</span>
                )}
              </div>
              <NetWorthChart snaps={snaps} />
              <div style={{ fontSize: 12, color: '#A0A4A4', marginTop: 8 }}>
                每周记一次，曲线会自动连接你的资产变化 · 绿色上方 = 净资产增长
              </div>
            </div>
          ) : (
            <div className="card" style={{ padding: 60, textAlign: 'center' }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>📈</div>
              <div style={{ fontSize: 14, color: '#A0A4A4' }}>还没有快照。点右栏「＋ 添加快照」记录第一笔，曲线就会出现。</div>
            </div>
          )}
        </div>

        {/* ========== 右栏：当前净资产 + 添加快照 + 历史列表 ========== */}
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* 当前净资产卡 */}
          <div className="card" style={{ padding: 24, textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>当前净资产</div>
            <div style={{
              fontSize: 36, fontWeight: 800, color: last && netWorth(last) < 0 ? '#DC2626' : '#111111',
              fontVariantNumeric: 'tabular-nums', margin: '6px 0 2px',
            }}>
              {last ? fmt(netWorth(last)) : '—'}
            </div>
            {last && (
              <div style={{ fontSize: 13, color: delta === null ? '#A0A4A4' : delta >= 0 ? '#059669' : '#DC2626', marginTop: 6 }}>
                {delta === null
                  ? `记录于 ${last.date} · 再记一条可看变化`
                  : `比上次${delta >= 0 ? ' +' : ' '}${fmtShort(delta)} · ${fmtDate(last.date)} 记录`}
              </div>
            )}
            <button onClick={() => void openForm()} className="btn-primary" style={{ marginTop: 16, padding: '9px 20px', width: '100%' }}>
              ＋ 添加快照
            </button>
          </div>

          {/* 历史快照列表 */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text)', marginBottom: 8 }}>🗂️ 历史快照</div>
            {!loaded ? null : snaps.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#A0A4A4', fontSize: 13, padding: '20px 0' }}>
                还没有快照
              </div>
            ) : (
              snaps.map((s, i) => (
                <div key={s.id} style={{
                  display: 'flex', alignItems: 'center', padding: '10px 0',
                  borderBottom: i < snaps.length - 1 ? '1px solid #E4E6E6' : 'none',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: '#111111' }}>{s.date}</div>
                    <div style={{ fontSize: 11.5, color: '#A0A4A4', marginTop: 1 }}>
                      总资产 {fmtShort(s.cashMinor + s.bankMinor + s.wechatMinor + s.alipayMinor + s.otherMinor)}
                      {' · '}负债 {fmtShort(s.liabilityMinor)}
                      {s.note ? ` · ${s.note}` : ''}
                    </div>
                  </div>
                  <span style={{
                    fontSize: 14, fontWeight: 700, color: netWorth(s) < 0 ? '#DC2626' : '#111111',
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {fmt(netWorth(s))}
                  </span>
                  <button onClick={() => void handleDelete(s.id)}
                    style={{ marginLeft: 12, background: 'none', border: 'none', color: '#A0A4A4', cursor: 'pointer', fontSize: 14 }}>
                    🗑
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 添加快照表单（全宽） */}
      {showForm && (
        <div className="card" style={{ padding: 20, marginTop: 24 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text)', marginBottom: 12 }}>📷 记录今日余额</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10, marginBottom: 12 }}>
            {ASSET_FIELDS.map(f => (
              <div key={f.key}>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 4 }}>{f.icon} {f.label}</div>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: '#A0A4A4' }}>¥</span>
                  <input
                    type="text" inputMode="decimal"
                    value={values[f.key]}
                    onChange={e => setValues(prev => ({ ...prev, [f.key]: e.target.value }))}
                    placeholder="0"
                    style={{
                      width: '100%', padding: '9px 8px 9px 26px', borderRadius: 10, border: '1px solid #C0C4C4',
                      fontSize: 14, color: 'var(--color-text)', outline: 'none', fontFamily: 'var(--font-stack)',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
            <div style={{ width: 96 }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 4 }}>📉 负债合计</div>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: '#A0A4A4' }}>¥</span>
                <input
                  type="text" inputMode="decimal"
                  value={values.liabilityMinor}
                  onChange={e => setValues(prev => ({ ...prev, liabilityMinor: e.target.value }))}
                  placeholder="0"
                  style={{
                    width: '100%', padding: '9px 8px 9px 26px', borderRadius: 10, border: '1px solid #C0C4C4',
                    fontSize: 14, color: 'var(--color-text)', outline: 'none', fontFamily: 'var(--font-stack)',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            </div>
            {debtTotal > 0 && (
              <span style={{ fontSize: 12, color: '#A0A4A4' }}>已自动填入债务表合计 {fmt(debtTotal)}（可改）</span>
            )}
          </div>
          <input
            value={note} onChange={e => setNote(e.target.value)} placeholder="备注（可选）"
            style={{
              width: '100%', padding: '9px 12px', borderRadius: 10, border: '1px solid #C0C4C4',
              fontSize: 13.5, color: 'var(--color-text)', outline: 'none', fontFamily: 'var(--font-stack)',
              boxSizing: 'border-box', marginBottom: 14,
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => void handleAdd()} className="btn-primary" style={{ padding: '9px 22px' }}>保存快照</button>
            <button onClick={() => setShowForm(false)}
              style={{ padding: '9px 18px', borderRadius: 10, border: '1px solid #C0C4C4', background: '#D8DADA', color: '#888888', fontSize: 13.5, cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

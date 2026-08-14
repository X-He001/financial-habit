import { useState, useEffect } from 'react'
import {
  addCommitment, getAllCommitments,
} from '../db/crud'
import type { Commitment } from '../types'
import { commitmentProgress, settleCommitments, categoryNameOf } from '../utils/commitmentEngine'
import type { CommitmentProgress } from '../utils/commitmentEngine'

// ==================== 工具 ====================

function pad2(n: number): string { return String(n).padStart(2, '0') }

function fmtShort(minor: number): string {
  return '¥' + Math.round(minor / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

function monthEndDate(): string {
  const now = new Date()
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(last)}`
}

function daysLeftText(c: Commitment): string {
  const diff = new Date(c.deadline + 'T23:59:59').getTime() - Date.now()
  if (diff <= 0) return '已到截止'
  return `${Math.ceil(diff / 86_400_000)}天`
}

const STATUS_LABEL: Record<Commitment['status'], string> = {
  active: '进行中',
  kept: '已达成',
  broken: '违约',
  cancelled: '已取消',
}

const STATUS_COLOR: Record<Commitment['status'], string> = {
  active: '#0040FF',
  kept: '#059669',
  broken: '#DC2626',
  cancelled: '#A0A4A4',
}

// ==================== 结算结果 HTML 卡片（Agent 回放承诺原话） ====================

function settleHtml(kept: Commitment[], broken: Commitment[]): string {
  const parts: string[] = []
  for (const c of kept) {
    parts.push(
      `<div style="margin-bottom:10px"><b style="color:#059669">🏆 达成</b>：${esc(c.text)} —— 说到做到了，表扬！</div>`
    )
  }
  for (const c of broken) {
    parts.push(
      `<div style="margin-bottom:10px"><b style="color:#DC2626">📢 违约回放</b>：你上个月承诺过「${esc(c.text)}」，现在没有守住。按约定罚金 ${fmtShort(c.penaltyMinor)} 已自动转入储蓄。<br/><span style="color:#888888">承诺不是为了束缚你，是帮你看清自己。下个月再来。</span></div>`
    )
  }
  return `<div style="font-size:13px;line-height:1.7;color:#374151">${parts.join('')}</div>`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ==================== 区块 ====================

export default function CommitmentsSection() {
  const [items, setItems] = useState<Commitment[]>([])
  const [loaded, setLoaded] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [text, setText] = useState('')
  const [category, setCategory] = useState('购物')
  const [amountYuan, setAmountYuan] = useState('')
  const [penaltyYuan, setPenaltyYuan] = useState('50')
  const [deadline, setDeadline] = useState(monthEndDate())
  const [progress, setProgress] = useState<Record<string, CommitmentProgress>>({})
  const [notice, setNotice] = useState<string | null>(null) // Agent 确认消息（HTML）

  async function load() {
    const list = await getAllCommitments()
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    setItems(list)
    setLoaded(true)
    const map: Record<string, CommitmentProgress> = {}
    for (const c of list) {
      if (c.status === 'active') map[c.id] = await commitmentProgress(c)
    }
    setProgress(map)
  }

  useEffect(() => {
    void (async () => {
      // 月底自动结算（幂等）：挂载时处理已过期的 active 承诺
      const { kept, broken } = await settleCommitments()
      await load()
      if (kept.length > 0 || broken.length > 0) {
        setNotice(settleHtml(kept, broken))
      }
    })()
  }, [])

  async function handleAdd() {
    const amount = parseFloat(amountYuan)
    const penalty = parseFloat(penaltyYuan)
    if (!text.trim() || isNaN(amount) || amount <= 0 || !deadline) {
      setNotice('<div style="font-size:13px;color:#DC2626">请填写承诺内容、目标金额和截止日期。</div>')
      return
    }
    const cat = category === '全部支出' ? null : category
    await addCommitment({
      text: text.trim(),
      targetCategory: cat,
      targetMinor: Math.round(amount * 100),
      penaltyMinor: isNaN(penalty) || penalty <= 0 ? 0 : Math.round(penalty * 100),
      deadline,
      status: 'active',
      createdAt: new Date().toISOString(),
      fulfilledAt: null,
    })
    setShowForm(false)
    setText(''); setAmountYuan(''); setDeadline(monthEndDate())
    setNotice('<div style="font-size:13px;line-height:1.7;color:#374151">📜 已记下你的承诺。月底我会回来验收 💪 从现在起，它会被计入你的自律记录。</div>')
    await load()
  }

  async function handleCancel(id: string) {
    if (!window.confirm('取消这条承诺？')) return
    await import('../db/crud').then(m => m.updateCommitment(id, { status: 'cancelled' }))
    await load()
  }

  const active = items.filter(c => c.status === 'active')
  const history = items.filter(c => c.status !== 'active')

  return (
    <div className="card" style={{ padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text)' }}>📜 自我承诺</div>
        <button onClick={() => setShowForm(v => !v)}
          style={{
            padding: '7px 14px', borderRadius: 999, border: '1px solid #C7D2FE', background: '#EEF2FF',
            color: '#0040FF', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-stack)',
          }}>
          ＋ 立下承诺
        </button>
      </div>
      <div style={{ fontSize: 12, color: '#A0A4A4', marginBottom: 12 }}>
        立个规矩：月底自动结算，做到了表扬，违约了罚金转储蓄
      </div>

      {/* 立承诺表单 */}
      {showForm && (
        <div style={{ background: '#E4E6E6', border: '1px solid #E4E6E6', borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: '#111111', marginBottom: 10 }}>✍️ 新的承诺</div>
          <input value={text} onChange={e => setText(e.target.value)}
            onBlur={() => { const cat = categoryNameOf(text); if (cat && category === '全部支出') setCategory(cat) }}
            placeholder="如：本月购物不超 ¥200"
            style={{
              width: '100%', padding: '9px 12px', borderRadius: 10, border: '1px solid #C0C4C4', outline: 'none',
              fontSize: 13.5, color: '#111111', fontFamily: 'var(--font-stack)', boxSizing: 'border-box', marginBottom: 10,
            }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(110px,1fr))', gap: 8, marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 12, color: '#A0A4A4', marginBottom: 4 }}>统计范围</div>
              <select value={category} onChange={e => setCategory(e.target.value)}
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid #C0C4C4',
                  fontSize: 13, color: '#111111', fontFamily: 'var(--font-stack)',
                }}>
                <option value="全部支出">全部支出</option>
                {['购物', '娱乐', '餐饮', '交通', '日用百货', '虚拟消费'].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#A0A4A4', marginBottom: 4 }}>目标金额（¥）</div>
              <input value={amountYuan} onChange={e => setAmountYuan(e.target.value)} inputMode="decimal" placeholder="200"
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid #C0C4C4',
                  fontSize: 13, color: '#111111', outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box',
                }} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#A0A4A4', marginBottom: 4 }}>违约罚金（¥）</div>
              <input value={penaltyYuan} onChange={e => setPenaltyYuan(e.target.value)} inputMode="decimal" placeholder="50"
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid #C0C4C4',
                  fontSize: 13, color: '#111111', outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box',
                }} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#A0A4A4', marginBottom: 4 }}>截止日期</div>
              <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid #C0C4C4',
                  fontSize: 13, color: '#111111', outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box',
                }} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => void handleAdd()} className="btn-primary" style={{ padding: '8px 20px' }}>立下承诺</button>
            <button onClick={() => setShowForm(false)}
              style={{ padding: '8px 16px', borderRadius: 10, border: '1px solid #C0C4C4', background: '#D8DADA', color: '#888888', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* Agent 确认/结算消息 */}
      {notice && (
        <div style={{
          marginBottom: 12, padding: '12px 14px', background: '#EEF2FF', border: '1px solid #E0E7FF',
          borderRadius: 12,
        }}>
          <div dangerouslySetInnerHTML={{ __html: notice }} />
        </div>
      )}

      {/* 进行中的承诺 */}
      {loaded && active.length === 0 && !showForm && (
        <div style={{ textAlign: 'center', color: '#A0A4A4', fontSize: 12.5, padding: '14px 0' }}>
          还没有进行中的承诺，点右上角立一个吧
        </div>
      )}
      {active.map(c => {
        const p = progress[c.id]
        const over = p && p.spentMinor > c.targetMinor
        const color = over ? '#F59E0B' : '#0040FF'
        return (
          <div key={c.id} style={{ padding: '10px 0', borderTop: '1px solid #E4E6E6' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: '#111111', lineHeight: 1.5 }}>
                {c.text}
                <span style={{
                  marginLeft: 8, fontSize: 11, padding: '2px 8px', borderRadius: 999,
                  background: over ? '#FEF3C7' : '#EEF2FF', color: over ? '#B45309' : '#0040FF',
                }}>
                  {over ? '超支中' : c.targetCategory ?? '总支出'}
                </span>
              </div>
              <button onClick={() => void handleCancel(c.id)}
                style={{ background: 'none', border: 'none', color: '#A0A4A4', fontSize: 11, cursor: 'pointer', flexShrink: 0 }}>
                取消
              </button>
            </div>
            {p && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#888888', margin: '6px 0 4px' }}>
                  <span>已花 {fmtShort(p.spentMinor)} / {fmtShort(c.targetMinor)}</span>
                  <span>{over ? `超支 ${fmtShort(p.spentMinor - c.targetMinor)}` : `还剩 ${fmtShort(c.targetMinor - p.spentMinor)}`}</span>
                </div>
                <div style={{ height: 6, background: '#E4E6E6', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', width: `${Math.min(100, p.pct)}%`, background: color, borderRadius: 3,
                    transition: 'width 0.5s ease',
                  }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#A0A4A4', marginTop: 5 }}>
                  <span>⏳ 还剩 {daysLeftText(c)} · 违约罚金 {c.penaltyMinor > 0 ? fmtShort(c.penaltyMinor) : '无'}</span>
                  <span style={{ color }}>{p.pct}%</span>
                </div>
              </>
            )}
          </div>
        )
      })}

      {/* 历史承诺 */}
      {history.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed #C0C4C4' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#888888', marginBottom: 6 }}>承诺记录</div>
          {history.map(c => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', fontSize: 12.5 }}>
              <span style={{ color: '#374151' }}>{c.text}</span>
              <span style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 999, flexShrink: 0,
                background: STATUS_COLOR[c.status] + '14', color: STATUS_COLOR[c.status],
              }}>
                {STATUS_LABEL[c.status]}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// oxlint-disable react/only-export-components -- 复盘面板导出多命令式 API（runReview/finishReview）与组件
import { useEffect, useRef, useState } from 'react'
import type { Transaction } from '../types'
import { getSetting, setSetting } from '../db/crud'
import { isImpulsive } from '../utils/impulseEngine'
import { runReview, finishReview, getForecastBanner } from '../agent/engine'
import type { ReviewResult } from '../agent/engine'
import { stateLabel } from '../agent/strategy'
import type { ReviewState } from '../agent/strategy'
import { getActionById } from '../agent/actions'
import type { ReviewAction, ActionId } from '../agent/actions'
import type { ActionOutcome } from '../agent/actions'
import type { DayImpulseOverview, ReviewMetrics } from '../agent/metrics'

// ==================== 本地工具 ====================

function pad2(n: number): string { return String(n).padStart(2, '0') }

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function fmtYuan(minor: number): string {
  return '¥' + (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

function timeOf(iso: string): string {
  const d = new Date(iso)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 文本转义（本地生成的用户动作消息渲染前转义，防 HTML 注入） */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ==================== 类型 ====================

/** 面板消息：AI 消息为 HTML 片段（已 sanitize / 本地模板），用户消息为转义文本 */
interface ChatMsg { role: 'ai' | 'user'; html: string; rich: boolean }

/** 复盘记录（settings key = review_日期，字段与 agent/engine 对齐） */
interface ReviewRecord {
  date: string
  txId: string
  openingHtml: string
  conclusionHtml: string | null
  msgs: ChatMsg[]
  executed: string[]
  actionIds: ActionId[]
  state: ReviewState
  reasons: string[]
  prediction: string | null
  overview: DayImpulseOverview
  metrics: ReviewMetrics
  finished: boolean
  rich: boolean
}

function recordKey(date: string): string { return `review_${date}` }

const STATE_COLOR: Record<ReviewState, string> = {
  high_damage: '#F43F5E',
  impulse: '#F59E0B',
  low: '#10B981',
}

// ==================== 复盘总结卡 ====================

function SummaryCard({ record }: { record: ReviewRecord }) {
  const { overview, state, reasons, conclusionHtml, executed, prediction } = record
  const color = STATE_COLOR[state]
  return (
    <div style={{ marginTop: 14, border: '1px solid #C0C4C4', borderRadius: 16, overflow: 'hidden', background: '#D8DADA' }}>
      {/* 顶部：今日冲动概览 */}
      <div style={{ background: '#E4E6E6', padding: '14px 16px', borderBottom: '1px solid #E4E6E6' }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: '#111111', marginBottom: 10 }}>📋 今日冲动复盘总结</div>
        <div style={{ display: 'flex', gap: 12 }}>
          {[
            { label: '冲动笔数', value: `${overview.count} 笔` },
            { label: '冲动总额', value: fmtYuan(overview.totalMinor) },
            { label: '最大一笔', value: overview.maxTx ? fmtYuan(overview.maxTx.amountMinor) : '—' },
          ].map(c => (
            <div key={c.label} style={{ flex: 1, background: '#D8DADA', borderRadius: 10, padding: '9px 8px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <div style={{ fontSize: 11, color: '#A0A4A4' }}>{c.label}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#111111', fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{c.value}</div>
            </div>
          ))}
        </div>
        {overview.maxTx && (
          <div style={{ fontSize: 12, color: '#A0A4A4', marginTop: 8 }}>
            最大一笔：【{overview.maxTx.merchant}】发生在 {timeOf(overview.maxTx.time)}
          </div>
        )}
      </div>

      {/* 中部：情境标签 + 命中依据 */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #E4E6E6' }}>
        <span style={{
          display: 'inline-block', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700,
          color: '#fff', background: color, marginRight: 8,
        }}>
          {stateLabel(state)}
        </span>
        {reasons.map((r, i) => (
          <span key={i} style={{
            display: 'inline-block', margin: '2px 6px 2px 0', padding: '3px 10px', borderRadius: 999,
            fontSize: 12, background: '#E4E6E6', color: '#4B5563',
          }}>{r}</span>
        ))}
      </div>

      {/* 下部：AI 结论（HTML 直接渲染） */}
      {conclusionHtml && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #E4E6E6' }}>
          <div dangerouslySetInnerHTML={{ __html: conclusionHtml }} />
        </div>
      )}

      {/* 已执行动作 */}
      {executed.length > 0 && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #E4E6E6' }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#111111', marginBottom: 8 }}>✅ 本次已执行</div>
          {executed.map((a, i) => (
            <div key={i} style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.8 }}>· {a}</div>
          ))}
        </div>
      )}

      {/* 底部：前瞻提醒 */}
      {prediction && (
        <div style={{ padding: '12px 16px', background: '#F0FDF4', borderTop: '1px solid #BBF7D0' }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#166534', marginBottom: 6 }}>🧭 前瞻提醒</div>
          <div style={{ fontSize: 13, color: '#14532D', lineHeight: 1.7 }}>{prediction}</div>
        </div>
      )}
    </div>
  )
}

// ==================== 复盘对话面板 ====================

function ReviewPanel({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([])
  const [actions, setActions] = useState<ReviewAction[]>([])
  const [busy, setBusy] = useState(true)
  const [done, setDone] = useState(false)
  const [record, setRecord] = useState<ReviewRecord | null>(null)
  const resultRef = useRef<ReviewResult | null>(null)
  const executedRef = useRef<string[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  // 挂载时初始化一次（init 是异步数据装载，无需响应式重跑）
  useEffect(() => {
    void init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 新消息自动滚到底部
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs.length, busy])

  async function init() {
    const today = todayKey()
    // 已存档（今天）→ 续接：同一笔未完成则继续；同一笔已完成则回看总结；新一笔则重新开始
    let saved: ReviewRecord | null = null
    const raw = await getSetting(recordKey(today))
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as ReviewRecord
        if (parsed && parsed.date === today && parsed.txId === tx.id && parsed.openingHtml) saved = parsed
      } catch { /* 数据损坏则重新开始 */ }
    }

    if (saved) {
      const res: ReviewResult = {
        openingHtml: saved.openingHtml,
        actions: saved.actionIds.map(id => getActionById(id)).filter((a): a is ReviewAction => !!a),
        metrics: saved.metrics,
        state: saved.state,
        reasons: saved.reasons,
        prediction: saved.prediction,
        dayOverview: saved.overview,
        rich: saved.rich,
      }
      resultRef.current = res
      executedRef.current = saved.executed
      setMsgs(saved.msgs)
      setRecord(saved)
      if (saved.finished) {
        setDone(true)
      } else {
        setActions(res.actions.filter(a => !saved.executed.includes(a.label)))
      }
      setBusy(false)
      return
    }

    // 全新复盘：computeMetrics → classify → actions → context → DeepSeek
    let res: ReviewResult
    try {
      res = await runReview(tx)
    } catch {
      setMsgs([{ role: 'ai', html: '这笔冲动我记下了，但暂时算不出复盘数据，晚点再来看看吧。', rich: false }])
      setBusy(false)
      return
    }
    resultRef.current = res
    setMsgs([{ role: 'ai', html: res.openingHtml, rich: res.rich }])
    setActions(res.actions)
    const rec: ReviewRecord = {
      date: today, txId: tx.id, openingHtml: res.openingHtml, conclusionHtml: null,
      msgs: [{ role: 'ai', html: res.openingHtml, rich: res.rich }],
      executed: [], actionIds: res.actions.map(a => a.id),
      state: res.state, reasons: res.reasons, prediction: res.prediction,
      overview: res.dayOverview, metrics: res.metrics, finished: false, rich: res.rich,
    }
    setRecord(rec)
    void setSetting(recordKey(today), JSON.stringify(rec))
    setBusy(false)
  }

  /** 点击动作 → 真实执行（写 settings / 加清单 / 查历史） */
  async function chooseAction(a: ReviewAction) {
    const res = resultRef.current
    if (!res || busy) return
    setBusy(true)

    const userMsg: ChatMsg = { role: 'user', html: esc(a.label), rich: false }
    const nextMsgs = [...msgs, userMsg]
    setMsgs(nextMsgs)

    let outcome: ActionOutcome
    try {
      outcome = await a.execute(tx, res.metrics)
    } catch (e) {
      outcome = { message: `动作执行失败：${e instanceof Error ? e.message : String(e)}` }
    }
    let html = `<div style="font-size:13.5px;line-height:1.7;color:#374151">${esc(outcome.message)}</div>`
    if (outcome.items && outcome.items.length > 0) {
      html += '<div style="margin-top:8px">' + outcome.items.map(it =>
        `<div style="font-size:13px;line-height:1.8;color:#4B5563">· ${esc(it.merchant)} ${fmtYuan(it.amountMinor)} · ${timeOf(it.time)}</div>`
      ).join('') + '</div>'
    }
    const withResult: ChatMsg[] = [...nextMsgs, { role: 'ai', html, rich: false }]
    setMsgs(withResult)

    const executed = [...executedRef.current, a.label]
    executedRef.current = executed
    setActions(actions.filter(x => x.id !== a.id))
    setRecord(prev => prev
      ? { ...prev, msgs: withResult, executed, actionIds: prev.actionIds.filter(id => id !== a.id) }
      : prev)
    setBusy(false)
  }

  /** 收尾：前瞻已在开场算出 → AI 结论 HTML → 总结卡 → 存档 */
  async function finish() {
    const res = resultRef.current
    if (!res || busy) return
    setBusy(true)

    const { conclusionHtml, rich } = await finishReview({
      tx,
      metrics: res.metrics,
      state: res.state,
      reasons: res.reasons,
      executedActions: executedRef.current,
      dayOverview: res.dayOverview,
      prediction: res.prediction,
    })
    const conclusionMsgs: ChatMsg[] = [...msgs, { role: 'ai', html: conclusionHtml, rich }]
    setMsgs(conclusionMsgs)

    const rec: ReviewRecord = {
      date: todayKey(), txId: tx.id, openingHtml: res.openingHtml, conclusionHtml,
      msgs: conclusionMsgs, executed: executedRef.current, actionIds: [],
      state: res.state, reasons: res.reasons, prediction: res.prediction,
      overview: res.dayOverview, metrics: res.metrics, finished: true, rich: res.rich || rich,
    }
    setRecord(rec)
    await setSetting(recordKey(rec.date), JSON.stringify(rec))
    setDone(true)
    setActions([])
    setBusy(false)
  }

  const stateColor = record ? STATE_COLOR[record.state] : '#0040FF'

  return (
    <div style={{
      position: 'fixed', right: 16, bottom: 16, zIndex: 1300, width: 'min(460px, calc(100vw - 32px))',
      maxHeight: 'min(640px, calc(100vh - 80px))', display: 'flex', flexDirection: 'column',
      background: '#D8DADA', borderRadius: 18, boxShadow: '0 20px 50px rgba(0,0,0,0.18)',
      border: '1px solid #C0C4C4', overflow: 'hidden',
    }}>
      {/* 标题栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px',
        background: 'linear-gradient(135deg,#EEF2FF,#E0F2FE)', borderBottom: '1px solid #C0C4C4', flexShrink: 0,
      }}>
        <span style={{ width: 34, height: 34, borderRadius: '50%', background: '#0040FF', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>🧊</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#111111' }}>今日冲动复盘</div>
          <div style={{ fontSize: 11.5, color: '#888888' }}>数据驱动的 AI 助手 · 数字本地计算，AI 只说人话</div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 16, color: '#888888', cursor: 'pointer', padding: 4 }}>✕</button>
      </div>

      {/* 消息流 */}
      <div ref={listRef} style={{
        flex: 1, overflowY: 'auto', padding: '14px 14px 4px', display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        {msgs.map((m, i) => (
          m.role === 'ai' ? (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', maxWidth: '100%' }}>
              <span style={{
                width: 26, height: 26, borderRadius: '50%', background: '#EEF2FF', border: '1px solid #E0E7FF',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, flexShrink: 0,
              }}>🤖</span>
              <div style={{
                background: '#E4E6E6', border: '1px solid #E4E6E6', borderRadius: '4px 12px 12px 12px',
                padding: '10px 13px', fontSize: 13.5, color: '#374151', lineHeight: 1.7, maxWidth: '88%',
                overflowWrap: 'break-word',
              }}>
                <div dangerouslySetInnerHTML={{ __html: m.html }} />
              </div>
            </div>
          ) : (
            <div key={i} style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <div style={{
                background: '#0040FF', color: '#fff', borderRadius: '12px 4px 12px 12px',
                padding: '9px 13px', fontSize: 13.5, lineHeight: 1.6, maxWidth: '82%',
                whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
              }}>
                {m.html}
              </div>
            </div>
          )
        ))}
        {busy && <div style={{ fontSize: 12, color: '#A0A4A4', textAlign: 'center', padding: '6px 0' }}>⏳ AI 正在分析…</div>}
      </div>

      {/* 动作按钮区 / 总结卡 */}
      <div style={{ flexShrink: 0, padding: '12px 14px 14px', borderTop: '1px solid #E4E6E6', maxHeight: '48%', overflowY: 'auto' }}>
        {done && record ? (
          <>
            <SummaryCard record={record} />
            <div style={{ textAlign: 'center', marginTop: 10 }}>
              <button onClick={onClose} style={{
                padding: '8px 24px', borderRadius: 999, border: '1px solid #C0C4C4', background: '#D8DADA',
                color: '#888888', fontSize: 13, cursor: 'pointer',
              }}>关闭</button>
            </div>
          </>
        ) : (
          <>
            {actions.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                {actions.map(a => (
                  <button key={a.id} onClick={() => chooseAction(a)} disabled={busy}
                    style={{
                      padding: '9px 16px', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--font-stack)',
                      fontSize: 13, fontWeight: 600, transition: 'all 0.15s',
                      border: `1px solid ${stateColor}`, background: '#D8DADA', color: stateColor,
                      opacity: busy ? 0.5 : 1,
                    }}>
                    {a.label}
                  </button>
                ))}
              </div>
            )}
            {executedRef.current.length > 0 && (
              <button onClick={() => finish()} disabled={busy}
                style={{
                  marginTop: 10, background: 'none', border: 'none', color: '#A0A4A4', fontSize: 12.5,
                  textDecoration: 'underline', cursor: 'pointer', fontFamily: 'var(--font-stack)',
                }}>
                完成复盘{record ? `（${stateLabel(record.state)}）` : ''}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ==================== 入口卡片 + 全局宿主 ====================

export default function ReviewPanelHost() {
  const [pending, setPending] = useState<{ tx: Transaction } | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [openTx, setOpenTx] = useState<Transaction | null>(null)

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ tx: Transaction }>).detail
      const t = detail?.tx
      if (!t || !isImpulsive(t.impulseLevel)) return
      setPending({ tx: t })
      setDismissed(false)
    }
    window.addEventListener('impulse-saved', handler)
    return () => window.removeEventListener('impulse-saved', handler)
  }, [])

  if (openTx) return <ReviewPanel tx={openTx} onClose={() => setOpenTx(null)} />
  if (!pending || dismissed) return null

  return (
    <div style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 1200, width: 300 }}>
      <div style={{
        background: '#D8DADA', borderRadius: 14, boxShadow: '0 10px 30px rgba(0,0,0,0.14)',
        border: '1px solid #E0E7FF', overflow: 'hidden',
      }}>
        <div style={{ background: '#EEF2FF', padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: '#0040FF' }}>⚡ 今日冲动复盘</span>
          <button onClick={() => setDismissed(true)}
            style={{ background: 'none', border: 'none', color: '#888888', cursor: 'pointer', fontSize: 13 }}>✕</button>
        </div>
        <div style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.7 }}>
            刚保存了一笔冲动消费（{pending.tx.merchant}）。要不要花 1 分钟，让 AI 帮你算笔账、给个下一步？
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button onClick={() => { setOpenTx(pending.tx); setDismissed(true) }}
              style={{
                flex: 1, padding: '9px 0', borderRadius: 10, cursor: 'pointer', fontFamily: 'var(--font-stack)',
                fontSize: 13, fontWeight: 600, border: 'none', background: '#0040FF', color: '#fff',
              }}>开始复盘</button>
            <button onClick={() => setDismissed(true)}
              style={{
                flex: 1, padding: '9px 0', borderRadius: 10, cursor: 'pointer', fontFamily: 'var(--font-stack)',
                fontSize: 13, border: '1px solid #C0C4C4', background: '#D8DADA', color: '#888888',
              }}>暂不</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ==================== 高频冲动窗口温和提示条（首页/欲望清单页） ====================

export function ForecastBanner() {
  const [banner, setBanner] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    let alive = true
    const check = () => {
      void getForecastBanner().then(b => {
        if (alive && b) setBanner(b.text)
      })
    }
    check()
    const timer = setInterval(check, 60_000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  if (!banner || hidden) return null
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
      background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 12, padding: '10px 16px',
    }}>
      <span style={{ fontSize: 15 }}>🧭</span>
      <span style={{ fontSize: 13, color: '#166534', flex: 1, lineHeight: 1.7 }}>{banner}</span>
      <button onClick={() => setHidden(true)}
        style={{ background: 'none', border: 'none', color: '#166534', fontSize: 13, cursor: 'pointer', flexShrink: 0 }}>✕</button>
    </div>
  )
}

// ==================== F5 反馈卡（交互式对话组件，F5 7.5 / 7.6） ====================
// - 同卡多轮、不跳页：开场（opening）→ 用户回答 → AI 分析（引用上一轮原话 + 科普 + 动作按钮）→ …
// - 每张卡最多 4 轮 AI 回复（7.5.2），达到后自动标记 completed
// - 用户回答经由 runFeedbackTurn 内的 save_behavior_notes 实时存档画像
// - 可关闭（dismissed）；AI 的 HTML 经 DOMPurify 白名单清洗后渲染（AiHtml）
// - kind='impulse_window'（7.7）：接受 → 写入 settings（nightLock + nightLockWindow）真实生效；
//   拒绝 → dismissed；修改 → 手动改时段后接受
// - 事实核查：AI 回复若带「⚠ 未核实」标注，卡片顶部显示核查提示

import { useState, useMemo } from 'react'
import type { AgentInboxItem } from '../types'
import type { ChatMessage } from '../api/deepseek'
import { updateAgentInboxItem, setSetting } from '../db/crud'
import { runFeedbackTurn } from '../agent/feedbackEngine'
import AiHtml from './AiHtml'

interface TurnMsg {
  role: 'user' | 'ai'
  content: string
}

const MAX_CARD_ROUNDS = 4 // F5 7.5.2：单卡最多 4 轮
const HOURS = Array.from({ length: 25 }, (_, i) => i) // 0-24（end=24 表示次日 0 点）

export default function FeedbackCard({ item, onDone }: { item: AgentInboxItem; onDone: () => void }) {
  const isWindow = item.kind === 'impulse_window'
  // 窗口卡时段编码在 objectId：`${start}-${end}`（如 "22-24"、"0-2"）
  const windowHours = useMemo(() => {
    const [s, e] = item.objectId.split('-').map(Number)
    return { start: Number.isFinite(s) ? s : 22, end: Number.isFinite(e) ? e : 24 }
  }, [item.objectId])

  const [turns, setTurns] = useState<TurnMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [guardNote, setGuardNote] = useState<string | null>(null)
  const [finished, setFinished] = useState(item.status === 'completed')
  const [windowAccepted, setWindowAccepted] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editStart, setEditStart] = useState(windowHours.start)
  const [editEnd, setEditEnd] = useState(windowHours.end)

  async function close(status: 'dismissed' | 'completed') {
    await updateAgentInboxItem(item.id, { status })
    onDone()
  }

  /** 发送一轮用户回答 → AI 分析（引用上一轮原话 + 科普 + 动作按钮） */
  async function send(text: string) {
    const reply = text.trim()
    if (!reply || busy) return
    setBusy(true)
    setInput('')
    setTurns(prev => [...prev, { role: 'user', content: reply }])
    const round = item.rounds + 1 // 当前第几轮（1 起）
    // 历史 = 开场 + 之前所有轮次（供 AI 引用上一轮原话）；runFeedbackTurn 内部追加本轮回答
    const history: ChatMessage[] = [{ role: 'assistant', content: item.opening }]
    for (const t of turns) history.push({ role: t.role === 'user' ? 'user' : 'assistant', content: t.content })
    try {
      const res = await runFeedbackTurn({ item, history, userReply: reply, round, maxRounds: MAX_CARD_ROUNDS })
      setTurns(prev => [...prev, { role: 'ai', content: res.html }])
      setGuardNote(res.guardIssues.length === 0 ? null : `事实核查：已标注 ${res.guardIssues.length} 处未核实信息`)
      if (round >= MAX_CARD_ROUNDS) {
        setFinished(true)
        await updateAgentInboxItem(item.id, { rounds: round, status: 'completed' })
      } else {
        await updateAgentInboxItem(item.id, { rounds: round })
      }
    } catch {
      setTurns(prev => [...prev, { role: 'ai', content: '抱歉，刚才连接出了问题，请再试一次。' }])
    } finally {
      setBusy(false)
    }
  }

  /** AI 按钮 data-action="ask:…" → 作为快捷回答发送（F5 7.5：快捷选项由数据/上下文生成，不设限） */
  function handleAction(action: string) {
    if (action.startsWith('ask:')) void send(action.slice(4))
  }

  /** 7.7：接受窗口提醒 → 写入 settings 真实生效（深夜/凌晨购物记账二次确认） */
  async function acceptWindow(start: number, end: number) {
    await setSetting('nightLock', 'true')
    await setSetting('nightLockWindow', JSON.stringify({ start, end }))
    setWindowAccepted(true)
    setEditing(false)
    await updateAgentInboxItem(item.id, { status: 'completed' })
  }

  const bubbleBase: React.CSSProperties = {
    padding: '9px 12px', borderRadius: 12, fontSize: 13.5, lineHeight: 1.7,
    maxWidth: '92%', wordBreak: 'break-word',
  }

  return (
    <div style={{
      marginBottom: 16, background: '#E4E6E6', border: '1px solid rgba(0,64,255,0.18)',
      borderRadius: 14, padding: '14px 16px',
    }}>
      {/* 头部 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 14 }}>{isWindow ? '🌙' : '💬'}</span>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: '#0040FF' }}>{item.title}</span>
        <span style={{ fontSize: 11, color: '#888888', marginLeft: 'auto' }}>
          {isWindow ? '高频冲动窗口提醒' : `对话 ${Math.min(item.rounds + turns.length / 2, MAX_CARD_ROUNDS)}/${MAX_CARD_ROUNDS} 轮`}
        </span>
        <button onClick={() => void close('dismissed')} title="关闭这张卡"
          style={{ background: 'none', border: 'none', color: '#888888', fontSize: 14, cursor: 'pointer', lineHeight: 1 }}>
          ✕
        </button>
      </div>

      {/* 事实核查提示 */}
      {guardNote && (
        <div style={{
          marginBottom: 8, fontSize: 11.5, color: '#f59e0b',
          background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)',
          borderRadius: 8, padding: '5px 10px',
        }}>
          {guardNote}
        </div>
      )}

      {/* ===== 窗口卡（7.7）：接受 / 拒绝 / 修改 ===== */}
      {isWindow ? (
        windowAccepted ? (
          <div style={{ ...bubbleBase, background: '#D8DADA', color: '#111111', whiteSpace: 'pre-wrap' }}>
            已开启该时段的冷静确认：之后 <b>{pad(windowHours.start)}:00-{pad(windowHours.end)}:00</b> 的购物类记账会先弹一次确认。你可以随时在设置里关闭。
          </div>
        ) : (
          <>
            <div style={{ ...bubbleBase, background: '#D8DADA', color: '#111111', whiteSpace: 'pre-wrap' }}>{item.opening}</div>
            <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {editing ? (
                <>
                  <select value={editStart} onChange={e => setEditStart(Number(e.target.value))}
                    style={selectStyle}>
                    {HOURS.slice(0, 24).map(h => <option key={h} value={h}>{pad(h)}:00</option>)}
                  </select>
                  <span style={{ fontSize: 12, color: '#888888' }}>至</span>
                  <select value={editEnd} onChange={e => setEditEnd(Number(e.target.value))}
                    style={selectStyle}>
                    {HOURS.map(h => <option key={h} value={h}>{pad(h)}:00</option>)}
                  </select>
                  <button onClick={() => void acceptWindow(editStart, editEnd)}
                    style={btnStyle('#0040FF')}>保存并开启</button>
                  <button onClick={() => setEditing(false)} style={btnStyle('#888888')}>取消</button>
                </>
              ) : (
                <>
                  <button onClick={() => void acceptWindow(windowHours.start, windowHours.end)}
                    style={btnStyle('#0040FF')}>✅ 接受提醒</button>
                  <button onClick={() => setEditing(true)} style={btnStyle('#888888')}>🕐 修改时间</button>
                  <button onClick={() => void close('dismissed')} style={btnStyle('#888888')}>忽略</button>
                </>
              )}
            </div>
          </>
        )
      ) : (
        <>
          {/* ===== 反馈卡对话 ===== */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ ...bubbleBase, background: '#D8DADA', color: '#111111', whiteSpace: 'pre-wrap', alignSelf: 'flex-start' }}>
              {item.opening}
            </div>
            {turns.map((t, i) =>
              t.role === 'user' ? (
                <div key={i} style={{ ...bubbleBase, background: '#0040FF', color: '#fff', alignSelf: 'flex-end' }}>
                  {t.content}
                </div>
              ) : (
                <div key={i} style={{ alignSelf: 'flex-start', maxWidth: '92%' }}>
                  <div style={{ background: '#D8DADA', borderRadius: 12, padding: '2px 6px' }}>
                    <AiHtml html={t.content} onAction={handleAction} style={{ fontSize: 13.5, color: '#111111' }} />
                  </div>
                </div>
              )
            )}
            {busy && (
              <div style={{ ...bubbleBase, background: '#D8DADA', color: '#888888', alignSelf: 'flex-start' }}>
                正在思考…
              </div>
            )}
          </div>

          {/* 输入区 */}
          {finished ? (
            <div style={{ marginTop: 10, fontSize: 12.5, color: '#888888', textAlign: 'center' }}>
              这轮回顾已结束，感谢你的分享。你的回答已存入消费画像，下次复盘会记得。
              <button onClick={() => void close('completed')} style={btnStyle('#888888')}>收下这张卡</button>
            </div>
          ) : (
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void send(input) }}
                placeholder="说说你的真实想法（不想说就打「不知道」也行）"
                style={{
                  flex: 1, padding: '8px 12px', borderRadius: 10, fontSize: 13,
                  border: '1px solid #C0C4C4', background: '#D8DADA', color: '#111111', outline: 'none',
                  fontFamily: 'var(--font-stack)',
                }}
              />
              <button onClick={() => void send(input)} disabled={busy || !input.trim()}
                style={{ ...btnStyle('#0040FF'), opacity: busy || !input.trim() ? 0.5 : 1 }}>
                发送
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

const selectStyle: React.CSSProperties = {
  padding: '6px 8px', borderRadius: 8, fontSize: 13, border: '1px solid #C0C4C4',
  background: '#D8DADA', color: '#111111', fontFamily: 'var(--font-stack)',
}

function btnStyle(color: string): React.CSSProperties {
  return {
    padding: '6px 12px', borderRadius: 8, fontSize: 12.5, cursor: 'pointer',
    border: '1px solid #C0C4C4', background: '#D8DADA', color,
    fontFamily: 'var(--font-stack)', whiteSpace: 'nowrap',
  }
}

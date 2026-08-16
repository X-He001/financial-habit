// ==================== 报告页交互式复盘（AI 助手 · 报告后继续对话） ====================
// 报告（日/周/月）生成后，在报告下方继续与 AI 助手对话：
// - 基于报告数据（代码算好的真实数字）开场：先观察 → 提问 → 用户回答 → 逐层深入
//   （数据→模式→动机/认知→建议）→ 最终给出带出处的"下次怎么做"建议
// - 对话要点经 AI 调用 save_behavior_notes 写入 coachNotes，
//   下次在 AI 助手窗口复盘时会被 get_behavior_profile 带出并引用（越用越懂）
// - AI 输出 HTML 内可含可执行按钮：
//     data-action="env:xxx"  环境改造（真实写 settings，与助手窗口一致）
//     data-action="ask:文本"  把问题作为用户消息发回继续对话
// - 会话持久化到 localStorage（reportCoachHistory_<标签>）

import { useEffect, useRef, useState } from 'react'
import { runCoachTurn, buildReportReviewMessages, applyCoachEnvAction } from '../agent/coachEngine'
import AiHtml from './AiHtml'

interface RM {
  id: string
  role: 'user' | 'ai' | 'system'
  content: string
  analysis?: { steps: string[] }
  streaming?: boolean
}

let rid = 0
const ruid = () => `rc${++rid}-${Date.now()}`
const MAX_HISTORY = 40

function historyKey(label: string): string {
  return `reportCoachHistory_${label}`
}

export default function ReportCoachChat({ label, snapshot, onOpenAssistant }: {
  /** 报告期标签：每日/每周/每月 */
  label: string
  /** 报告数据快照文本（由 Report 页代码从 facts 算好，AI 只组织语言） */
  snapshot: string
  /** "去 AI 助手继续"按钮回调（打开助手窗口） */
  onOpenAssistant?: () => void
}) {
  const [messages, setMessages] = useState<RM[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const aiIdRef = useRef<string | null>(null)
  const startedRef = useRef(false)

  // 挂载时：恢复历史；无历史则基于报告数据自动开场复盘
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    let restored = false
    try {
      const raw = localStorage.getItem(historyKey(label))
      if (raw) {
        const list = JSON.parse(raw) as { role: 'user' | 'ai'; content: string }[]
        if (Array.isArray(list) && list.length > 0) {
          setMessages(list.map(m => ({ id: ruid(), role: m.role, content: m.content })))
          restored = true
        }
      }
    } catch {
      // 历史数据损坏则忽略
    }
    if (!restored) void startOpening()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, snapshot])

  // 新消息自动滚到底
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // 保存最近对话到 localStorage（跨会话记忆）
  useEffect(() => {
    if (messages.length === 0) return
    const plain = messages
      .filter(m => (m.role === 'user' || m.role === 'ai') && !m.streaming && m.content.trim())
      .slice(-MAX_HISTORY)
      .map(m => ({ role: m.role, content: m.content }))
    try {
      localStorage.setItem(historyKey(label), JSON.stringify(plain))
    } catch {
      // localStorage 不可用时忽略
    }
  }, [messages, label])

  /** 当前 AI 回复的工具调用轨迹（折叠「分析过程」区用） */
  const traceRef = useRef<string[]>([])

  function pushTrace(step: string) {
    traceRef.current.push(step)
  }

  function pushSystem(content: string): string {
    const id = ruid()
    setMessages(prev => [...prev, { id, role: 'system', content }])
    return id
  }

  function pushAi(content: string, streaming = false): string {
    const id = ruid()
    traceRef.current = [] // 新一轮 AI 回复开始，清空上一轮轨迹
    aiIdRef.current = id
    setMessages(prev => [...prev, { id, role: 'ai', content, streaming }])
    return id
  }

  function appendAi(delta: string) {
    const id = aiIdRef.current
    if (!id) return
    setMessages(prev => prev.map(m => m.id === id ? { ...m, content: m.content + delta } : m))
  }

  function finishAi() {
    const id = aiIdRef.current
    if (!id) return
    const trace = traceRef.current.slice()
    traceRef.current = []
    setMessages(prev => prev.map(m => m.id === id
      ? { ...m, streaming: false, ...(trace.length > 0 ? { analysis: { steps: trace } } : {}) }
      : m))
    aiIdRef.current = null
  }

  function failAi(id: string | null, err: unknown) {
    const text = `⚠️ ${err instanceof Error ? err.message : String(err)}`
    if (id) setMessages(prev => prev.map(m => m.id === id ? { ...m, content: text, streaming: false } : m))
    else pushSystem(text)
    aiIdRef.current = null
  }

  /** 自动开场：基于报告数据开始复盘（先观察再提问） */
  async function startOpening() {
    setBusy(true)
    pushAi('', true)
    const aiId = aiIdRef.current
    try {
      const { messages: msgs } = await buildReportReviewMessages({ reportLabel: label, reportSnapshot: snapshot })
      const reply = await runCoachTurn(msgs, { onStatus: handleStatus })
      appendAi(reply)
      finishAi()
    } catch (e) {
      failAi(aiId, e)
    } finally {
      setBusy(false)
    }
  }

  /** 工具状态：running 插入系统消息，完成时更新为 ✅ */
  const statusMsgIds = useRef<Map<string, string>>(new Map())
  function handleStatus(s: { id: string; label: string; state: 'running' | 'done' | 'error' }) {
    if (s.state === 'running') {
      const mid = pushSystem(/^\p{Extended_Pictographic}/u.test(s.label) ? s.label : `🤖 ${s.label}`)
      statusMsgIds.current.set(s.id, mid)
    } else {
      const mid = statusMsgIds.current.get(s.id)
      if (mid) {
        setMessages(prev => prev.map(m => m.id === mid ? { ...m, content: `✅ ${s.label}` } : m))
      }
      pushTrace(s.state === 'error' ? `⚠️ ${s.label}` : `✅ ${s.label}`)
    }
  }

  /** 发送一条用户消息（输入框 或 点击 AI 的 ask: 按钮） */
  async function sendText(text: string) {
    if (!text || busy) return
    setMessages(prev => [...prev, { id: ruid(), role: 'user', content: text }])
    setBusy(true)
    const aiId = pushAi('', true)
    try {
      const history = messages
        .filter((m): m is RM & { role: 'user' | 'ai' } =>
          (m.role === 'user' || m.role === 'ai') && !m.streaming && m.content.trim().length > 0)
        .slice(-MAX_HISTORY)
        .map(m => ({ role: m.role, content: m.content }))
      const { messages: msgs } = await buildReportReviewMessages({ reportLabel: label, reportSnapshot: snapshot, history, text })
      const reply = await runCoachTurn(msgs, { onStatus: handleStatus })
      appendAi(reply)
      finishAi()
    } catch (e) {
      failAi(aiId, e)
    } finally {
      setBusy(false)
    }
  }

  async function handleSend() {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    await sendText(text)
  }

  /** AI 输出 HTML 中的可执行按钮（env: 环境改造 / ask: 继续对话） */
  async function handleAction(action: string) {
    if (action.startsWith('env:')) {
      const parts = action.split(':')
      const id = parts[1] ?? ''
      const platform = parts.slice(2).join(':') || undefined
      const res = await applyCoachEnvAction(id, platform)
      pushSystem(res.ok ? `✅ ${res.message}` : `⚠️ ${res.message}`)
    } else if (action.startsWith('ask:')) {
      const text = action.slice(4).trim()
      if (text) await sendText(text)
    }
  }

  return (
    <div className="card" style={{ padding: 20, marginBottom: 24 }}>
      {/* 头部 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#111111' }}>
            💬 与 AI 助手继续复盘<span style={{ fontSize: 12, color: '#A0A4A4', fontWeight: 400, marginLeft: 8 }}>{label}报告 · 逐层深入</span>
          </div>
          <div style={{ fontSize: 12, color: '#888888', marginTop: 6, lineHeight: 1.7 }}>
            报告已生成，AI 会基于上面的真实数据继续提问（数据→模式→认知→建议）；对话要点会自动存入你的画像，下次在 AI 助手窗口复盘时会被引用。
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => { if (!busy) void startOpening() }}
            title="重新开场一轮复盘"
            style={{
              padding: '6px 12px', borderRadius: 8, border: '1px solid #C0C4C4', background: '#E4E6E6',
              fontSize: 12, fontWeight: 600, color: '#0040FF', cursor: busy ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font-stack)', opacity: busy ? 0.5 : 1,
            }}>
            🔄 重新开场
          </button>
          {onOpenAssistant && (
            <button onClick={onOpenAssistant}
              title="打开右下角 AI 助手窗口继续聊"
              style={{
                padding: '6px 12px', borderRadius: 8, border: '1px solid #C0C4C4', background: '#EEF2FF',
                fontSize: 12, fontWeight: 600, color: '#0040FF', cursor: 'pointer',
                fontFamily: 'var(--font-stack)',
              }}>
              🧠 去 AI 助手继续
            </button>
          )}
        </div>
      </div>

      {/* 消息列表 */}
      <div ref={listRef} style={{
        marginTop: 14, maxHeight: 420, overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: 10,
        background: '#E4E6E6', borderRadius: 12, padding: 14,
      }}>
        {messages.length === 0 && !busy && (
          <div style={{ textAlign: 'center', color: '#888888', fontSize: 12.5, padding: '26px 0', lineHeight: 2 }}>
            基于这份{label}报告开始复盘
            <br />AI 会先给你数据观察，再一层层提问，最后给出建议
          </div>
        )}
        {messages.map(m => {
          if (m.role === 'system') {
            return (
              <div key={m.id} style={{ textAlign: 'center', fontSize: 12, color: '#888888', padding: '2px 0' }}>
                {m.content}
              </div>
            )
          }
          const isUser = m.role === 'user'
          const analysisEl = m.analysis && m.analysis.steps.length > 0 ? (
            <details style={{ marginTop: 6, maxWidth: '88%' }}>
              <summary style={{
                cursor: 'pointer', fontSize: 12, color: '#888888', userSelect: 'none',
                background: '#EEF2FF', border: '1px solid #D6DEFE', borderRadius: 8,
                padding: '6px 10px', display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                🧠 分析过程（{m.analysis.steps.length} 步）▾
              </summary>
              <div style={{
                marginTop: 6, background: '#EEF2FF', border: '1px solid #D6DEFE', borderRadius: 8,
                padding: '8px 10px', fontSize: 12, color: '#666666', lineHeight: 1.9,
              }}>
                {m.analysis.steps.map((s, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6 }}>
                    <span style={{ color: '#B0B4B4', flexShrink: 0 }}>{i + 1}.</span>
                    <span>{s}</span>
                  </div>
                ))}
              </div>
            </details>
          ) : null
          return (
            <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '88%', padding: '10px 13px', borderRadius: 12, fontSize: 13.5, lineHeight: 1.7,
                  background: isUser ? '#0040FF' : '#fff', color: isUser ? '#FFFFFF' : '#111111',
                  borderTopRightRadius: isUser ? 3 : 12, borderTopLeftRadius: isUser ? 12 : 3,
                  boxShadow: isUser ? '0 2px 8px rgba(0,64,255,0.25)' : '0 1px 2px rgba(0,0,0,0.04)',
                }}>
                  {isUser
                    ? <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>
                    : <AiHtml html={m.content} onAction={(a) => void handleAction(a)} />}
                  {m.streaming && <span style={{ display: 'inline-block', marginLeft: 2, animation: 'blinkDot 1s infinite' }}>▍</span>}
                </div>
              </div>
              {analysisEl}
            </div>
          )
        })}
      </div>

      {/* 输入区 */}
      <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleSend() }}
          placeholder="回答 AI 的问题，或继续聊这份报告…"
          style={{
            flex: 1, padding: '9px 12px', borderRadius: 10, border: '1px solid #C0C4C4',
            fontSize: 13, outline: 'none', fontFamily: 'var(--font-stack)', color: '#111111',
            boxSizing: 'border-box', background: '#fff', minWidth: 0,
          }}
        />
        <button onClick={() => void handleSend()} disabled={busy || !input.trim()}
          style={{
            width: 38, height: 38, borderRadius: 10, border: 'none', background: '#0040FF', color: '#FFFFFF',
            fontSize: 15, cursor: (busy || !input.trim()) ? 'not-allowed' : 'pointer', flexShrink: 0,
            opacity: (busy || !input.trim()) ? 0.5 : 1,
          }}>
          ➤
        </button>
      </div>
    </div>
  )
}

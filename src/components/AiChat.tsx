import { useState, useEffect, useRef } from 'react'
import type { ParsedLedgerItem } from '../api/deepseek'
import {
  analyzeReceiptImage,
  hasApiKey, aiErrorMessage, VisionUnsupportedError,
} from '../api/deepseek'
import { saveParsedLedger } from '../utils/ledgerSave'
import { incrementAiCount } from '../utils/aiUsage'
import { runAgent } from '../agent/engine'
import type { AgentHistoryItem } from '../agent/engine'
import type { FollowUpQuestion } from '../agent/agents'
import type { ReportFacts, ReportType } from '../agent/reportGenerator'
import EditableItemForm from './ledger/EditableItemForm'
import Markdown from './Markdown'
import RichMessage, { hasRichBlock } from './RichMessage'
import AiHtml, { isHtmlContent } from './AiHtml'
import ReportPreview from './ReportViewer'
import { execDebtAction } from '../debt/actions'

interface ChatMsg {
  id: string
  role: 'user' | 'ai' | 'system'
  content: string
  card?: { kind: 'bookkeep'; item: ParsedLedgerItem; source: 'voice' | 'ocr' }
  report?: { html: string; type: ReportType; facts: ReportFacts }
  followUps?: FollowUpQuestion[]
  streaming?: boolean
}

let msgId = 0
const uid = () => `m${++msgId}-${Date.now()}`

const HISTORY_KEY = 'agentChatHistory' // 最近 20 轮对话（localStorage）
const MAX_HISTORY = 20

const SUGGESTIONS = ['这个月拼多多花了多少', '帮我记：中午吃饭35块', '帮我存100块进储蓄', '生成这个月的报告', '我最近冲动消费怎么样', '这个月每类花了多少']

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export default function AiChat() {
  const [open, setOpen] = useState(false)
  const [online, setOnline] = useState(false)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)
  const aiIdRef = useRef<string | null>(null)
  const chatBoxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void hasApiKey().then(setOnline)
  }, [])

  // 打开时恢复最近 20 轮对话（会话记忆）
  useEffect(() => {
    if (!open) return
    try {
      const raw = localStorage.getItem(HISTORY_KEY)
      if (raw) {
        const list = JSON.parse(raw) as { role: 'user' | 'ai'; content: string }[]
        if (Array.isArray(list) && list.length > 0) {
          setMessages(list.map(m => ({ id: uid(), role: m.role, content: m.content })))
        }
      }
    } catch {
      // 历史数据损坏则忽略
    }
  }, [open])

  // 新消息自动滚到底
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // 保存最近 20 轮对话到 localStorage（跨会话记忆）
  useEffect(() => {
    if (messages.length === 0) return
    const plain = messages
      .filter(m => (m.role === 'user' || m.role === 'ai') && !m.streaming && m.content.trim())
      .slice(-MAX_HISTORY)
      .map(m => ({ role: m.role, content: m.content }))
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(plain))
    } catch {
      // localStorage 不可用时忽略
    }
  }, [messages])

  function close() {
    setOpen(false)
    setMessages([])
    setInput('')
    setBusy(false)
  }

  function pushSystem(content: string): string {
    const id = uid()
    setMessages(prev => [...prev, { id, role: 'system', content }])
    return id
  }

  function pushAi(content: string, streaming = false): string {
    const id = uid()
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
    setMessages(prev => prev.map(m => m.id === id ? { ...m, streaming: false } : m))
    aiIdRef.current = null
  }

  function failAi(id: string | null, err: unknown) {
    const text = `⚠️ ${aiErrorMessage(err)}`
    if (id) setMessages(prev => prev.map(m => m.id === id ? { ...m, content: text, streaming: false } : m))
    else pushSystem(text)
    aiIdRef.current = null
  }

  async function ensureKey(): Promise<boolean> {
    const ok = await hasApiKey()
    if (!ok) pushSystem('⚠️ 请先到设置页配置 API Key，才能使用 AI 能力')
    return ok
  }

  // ============ 截图记账（保留确认卡片） ============

  async function handleImage(files: File[]) {
    const imgs = files.filter(f => f.type.startsWith('image/'))
    if (imgs.length === 0) return
    const ok = await ensureKey()
    if (!ok) return
    setBusy(true)
    const statusId = pushSystem('📷 正在识别支付截图…')
    try {
      const urls = await Promise.all(imgs.map(fileToDataUrl))
      await incrementAiCount() // 发起识别请求即计一次调用
      const results = await analyzeReceiptImage(urls)
      const item = results[0]
      setMessages(prev => prev.map(m => m.id === statusId
        ? { id: m.id, role: 'system', content: `识别出 ${results.length} 张，先确认这一笔：`, card: { kind: 'bookkeep', item, source: 'ocr' } }
        : m))
    } catch (e) {
      if (e instanceof VisionUnsupportedError) {
        setMessages(prev => prev.map(m => m.id === statusId
          ? { ...m, content: '当前模型不支持图片识别，你可以直接发文字帮我记账，比如"帮我记：拼多多89块"。' }
          : m))
      } else {
        setMessages(prev => prev.map(m => m.id === statusId ? { ...m, content: `⚠️ ${aiErrorMessage(e)}` } : m))
      }
    } finally {
      setBusy(false)
    }
  }

  async function confirmSave(id: string, item: ParsedLedgerItem, source: 'voice' | 'ocr') {
    const ok = await saveParsedLedger(item, source)
    setMessages(prev => prev.map(m => m.id === id
      ? {
        id: m.id, role: 'system',
        content: ok
          ? `✅ 已帮你记录 ¥${item.amount.toFixed(2)} ${item.merchant}${item.category ? ' · ' + item.category : ''} 🎉`
          : '已取消保存（你取消了预警确认）',
      }
      : m))
    window.dispatchEvent(new CustomEvent('dashboard-refresh'))
  }

  function cancelCard(id: string) {
    setMessages(prev => prev.filter(m => m.id !== id))
  }

  // ============ Agent（LLM 选工具 + 本地执行） ============

  /** 工具状态消息 id（name -> 消息 id），执行完成时更新为"✅ 已执行" */
  const statusMsgIds = useRef<Map<string, string>>(new Map())
  /** 最近一次报告的 facts（用户追问报告内容时直接用，不重新调工具） */
  const lastFactsRef = useRef<ReportFacts | null>(null)

  function getLastOp(): string | null {
    try { return localStorage.getItem('agentLastOp') } catch { return null }
  }

  function reportFileName(type: ReportType, facts: ReportFacts): string {
    const label = type === 'month' ? '月度' : type === 'week' ? '周度' : '每日'
    return `财务分析报告-${label}-${facts.periodLabel}.html`
  }

  async function handleAgent(text: string) {
    const ok = await ensureKey()
    if (!ok) return
    await incrementAiCount()
    const history: AgentHistoryItem[] = messages
      .filter((m): m is ChatMsg & { role: 'user' | 'ai' } =>
        (m.role === 'user' || m.role === 'ai') && !m.streaming && m.content.trim().length > 0)
      .slice(-MAX_HISTORY)
      .map(m => ({ role: m.role, content: m.content }))
    pushAi('', true)
    const aiId = aiIdRef.current
    try {
      const reply = await runAgent(text, {
        history,
        lastOp: getLastOp(),
        lastFacts: lastFactsRef.current,
        onStatus: (s) => {
          if (s.state === 'running') {
            const mid = pushSystem(/^\p{Extended_Pictographic}/u.test(s.label) ? s.label : `🤖 ${s.label}`)
            statusMsgIds.current.set(s.id, mid)
          } else {
            const mid = statusMsgIds.current.get(s.id)
            if (mid) {
              setMessages(prev => prev.map(m => m.id === mid ? { ...m, content: `✅ ${s.label}` } : m))
            }
          }
        },
      })
      if (reply.kind === 'report') {
        lastFactsRef.current = reply.facts
        appendAi(reply.summary)
        if (aiId) {
          setMessages(prev => prev.map(m => m.id === aiId
            ? { ...m, report: { html: reply.html, type: reply.type, facts: reply.facts } } : m))
        }
      } else {
        appendAi(reply.content)
        if (reply.followUps && reply.followUps.length > 0 && aiId) {
          setMessages(prev => prev.map(m => m.id === aiId
            ? { ...m, followUps: reply.followUps } : m))
        }
      }
      finishAi()
    } catch (e) {
      failAi(aiId, e)
    }
  }

  // ============ 债务顾问可执行按钮（data-action 真实执行，逻辑见 src/debt/actions.ts） ============

  async function handleDebtAction(action: string) {
    setBusy(true)
    try {
      await execDebtAction(action, { info: (msg) => pushSystem(msg) })
    } catch {
      pushSystem('⚠️ 执行失败，请稍后再试')
    } finally {
      setBusy(false)
    }
  }

  // ============ 发送入口 ============

  /** 发送一条文本（用户输入 或 点击 AI 生成的追问按钮），点击追问会基于同轮上下文继续 */
  async function sendText(text: string) {
    if (!text || busy) return
    setMessages(prev => [...prev, { id: uid(), role: 'user', content: text }])
    setBusy(true)
    try {
      await handleAgent(text)
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

  // ============ 拖动 ============

  function onDragStart(e: React.MouseEvent) {
    const startX = e.clientX
    const startY = e.clientY
    const baseX = pos?.x ?? window.innerWidth - 440
    const baseY = pos?.y ?? 80
    dragRef.current = { startX, startY, baseX, baseY }
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const x = Math.min(window.innerWidth - 80, Math.max(0, d.baseX + (ev.clientX - d.startX)))
      const y = Math.min(window.innerHeight - 60, Math.max(0, d.baseY + (ev.clientY - d.startY)))
      setPos({ x, y })
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ============ 渲染 ============

  return (
    <>
      {/* 悬浮按钮 */}
      {!open && (
        <button onClick={() => setOpen(true)}
          title="AI 财务助手"
          style={{
            position: 'fixed', right: 24, bottom: 96, width: 56, height: 56, borderRadius: '50%',
            background: '#0040FF', border: 'none', cursor: 'pointer', zIndex: 90,
            boxShadow: '0 8px 24px rgba(0,64,255,0.4)', fontSize: 24, display: 'flex',
            alignItems: 'center', justifyContent: 'center', transition: 'transform 0.15s',
          }}>
          <span style={{ lineHeight: 1 }}>💬</span>
        </button>
      )}

      {/* 聊天窗口（全屏时铺满页面） */}
      {open && (
        <div ref={chatBoxRef}
          style={fullscreen ? {
            position: 'fixed', inset: 0, zIndex: 200,
            background: '#D8DADA',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          } : {
            position: 'fixed', width: 400, maxWidth: '94vw', height: '70vh', zIndex: 95,
            right: pos ? undefined : 24, bottom: pos ? undefined : 80,
            left: pos?.x, top: pos?.y,
            background: '#D8DADA', borderRadius: 16, boxShadow: 'var(--shadow-lg)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
          {/* 头部 */}
          <div onMouseDown={fullscreen ? undefined : onDragStart} style={{ cursor: fullscreen ? 'default' : 'grab', padding: '14px 16px 8px', borderBottom: '1px solid #E4E6E6', userSelect: 'none' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: '#111111' }}>AI 财务助手</span>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600,
                  padding: '2px 8px', borderRadius: 20,
                  background: online ? '#22D3EE14' : '#E4E6E6', color: online ? '#22D3EE' : '#888888',
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: online ? '#22D3EE' : '#888888' }} />
                  {online ? '在线' : '离线'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button onClick={() => setFullscreen(f => !f)}
                  title={fullscreen ? '还原小窗' : '放大全屏'}
                  style={{
                    background: '#E4E6E6', color: '#0040FF', border: '1px solid #C0C4C4', borderRadius: 8,
                    padding: '5px 10px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                    fontFamily: 'var(--font-stack)',
                  }}>
                  {fullscreen ? '↘ 还原' : '⛶ 放大'}
                </button>
                <button onClick={close} title="关闭" style={{ background: 'none', border: 'none', color: '#888888', fontSize: 16, cursor: 'pointer' }}>✕</button>
              </div>
            </div>
            <div style={{ fontSize: 11, color: '#888888', marginTop: 6 }}>对话会发送脱敏数据到 DeepSeek 处理 · 拖动标题可移动窗口</div>
          </div>

          {/* 消息列表 */}
          <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 6px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.length === 0 && (
              <div style={{ textAlign: 'center', color: '#888888', fontSize: 12.5, padding: '30px 0 16px', lineHeight: 2 }}>
                问我任何财务问题，或发我截图/文字帮你记账
                <br />比如"记一笔：中午吃饭35"
              </div>
            )}
            {messages.map(m => {
              if (m.card) {
                return (
                  <div key={m.id} style={{ background: '#E4E6E6', border: '1px solid #C0C4C4', borderRadius: 12, padding: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111111', marginBottom: 10 }}>{m.content}</div>
                    <EditableItemForm
                      value={m.card.item}
                      onChange={(v) => setMessages(prev => prev.map(x => x.id === m.id && x.card
                        ? { ...x, card: { ...x.card, item: v } } : x))}
                      onSave={() => confirmSave(m.id, m.card!.item, m.card!.source)}
                      saveLabel="✓ 保存这笔"
                    />
                    <button onClick={() => cancelCard(m.id)}
                      style={{ marginTop: 8, width: '100%', padding: '7px 0', borderRadius: 10, border: '1px solid #C0C4C4', background: '#D8DADA', fontSize: 13, color: '#888888', cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
                      取消
                    </button>
                  </div>
                )
              }
              const isUser = m.role === 'user'
              const bubble = (
                <div style={{
                  maxWidth: '84%', padding: '10px 13px', borderRadius: 12, fontSize: 13.5, lineHeight: 1.7,
                  background: isUser ? '#0040FF' : '#E4E6E6', color: isUser ? '#FFFFFF' : '#111111',
                  borderTopRightRadius: isUser ? 3 : 12, borderTopLeftRadius: isUser ? 12 : 3,
                  boxShadow: isUser ? '0 2px 8px rgba(0,64,255,0.25)' : '0 1px 2px rgba(0,0,0,0.04)',
                }}>
                  {isUser
                    ? <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>
                    : hasRichBlock(m.content)
                      ? <RichMessage content={m.content} />
                      : isHtmlContent(m.content)
                        ? <AiHtml html={m.content} onAction={(a) => void handleDebtAction(a)} />
                        : <Markdown md={m.content} />}
                  {m.streaming && <span style={{ display: 'inline-block', marginLeft: 2, animation: 'blinkDot 1s infinite' }}>▍</span>}
                </div>
              )
              // 报告消息：气泡下方附上可滚动/全屏/下载/打印的预览卡片
              if (m.report) {
                return (
                  <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>{bubble}</div>
                    <ReportPreview html={m.report.html} filename={reportFileName(m.report.type, m.report.facts)} />
                  </div>
                )
              }
              // AI 动态追问：气泡下方渲染可点击的追问按钮（悬停显示生成依据）
              if (!isUser && m.followUps && m.followUps.length > 0) {
                return (
                  <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>{bubble}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {m.followUps.map((f, i) => (
                        <button key={i} onClick={() => void sendText(f.question)} disabled={busy}
                          title={f.basis ? `为什么这么问：${f.basis}` : ''}
                          style={{
                            padding: '6px 12px', borderRadius: 999, cursor: busy ? 'not-allowed' : 'pointer',
                            border: '1px solid #C0C4C4', background: '#E4E6E6', color: '#0040FF',
                            fontSize: 12.5, textAlign: 'left', maxWidth: '100%',
                            fontFamily: 'var(--font-stack)', opacity: busy ? 0.5 : 1,
                          }}>
                          💬 {f.question}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              }
              return (
                <div key={m.id} style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
                  {bubble}
                </div>
              )
            })}
          </div>

          {/* 快捷问题 */}
          {messages.length === 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 14px 10px' }}>
              {SUGGESTIONS.map(s => (
                <button key={s} onClick={() => { setInput(s); }}
                  style={{ padding: '6px 12px', borderRadius: 999, border: '1px solid #C0C4C4', background: '#E4E6E6', fontSize: 12, color: '#888888', cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* 输入区 */}
          <div style={{ padding: '10px 14px 14px', borderTop: '1px solid #E4E6E6', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <input ref={fileRef} type="file" accept="image/*" hidden
              onChange={(e) => { if (e.target.files) void handleImage(Array.from(e.target.files)); e.target.value = '' }} />
            <button onClick={() => fileRef.current?.click()} disabled={busy}
              title="发送支付截图"
              style={{ width: 38, height: 38, borderRadius: 10, border: '1px solid #C0C4C4', background: '#E4E6E6', fontSize: 17, cursor: busy ? 'not-allowed' : 'pointer', flexShrink: 0 }}>
              📷
            </button>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleSend() }}
              placeholder="问我任何财务问题，或发我截图/文字帮你记账，比如'记一笔：中午吃饭35'"
              style={{
                flex: 1, padding: '9px 12px', borderRadius: 10, border: '1px solid #C0C4C4',
                fontSize: 13, outline: 'none', fontFamily: 'var(--font-stack)', color: '#111111',
                boxSizing: 'border-box', background: '#E4E6E6', minWidth: 0,
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
      )}
    </>
  )
}

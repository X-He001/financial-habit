import { useState, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { db } from '../db/database'
import {
  updateWishlistItem, getAllWishlistChats, addWishlistChat, updateWishlistChat,
} from '../db/crud'
import { hasApiKey, aiErrorMessage } from '../api/deepseek'
import type { WishlistItem, WishlistChat, WishlistChatMsg, WishlistChatSummary, Transaction, ConsumerEvent } from '../types'
import {
  buildWishlistFacts, generateWishlistOpening, runWishlistTurn,
  generateWishlistSummary, isEndIntent, classifyCategory, nameKeywords,
} from '../agent/wishlistAgent'
import RadarChart from '../components/RadarChart'
import AiHtml, { isHtmlContent } from '../components/AiHtml'
import { ForecastBanner } from '../components/ReviewPanel'
import CommitmentsSection from '../components/CommitmentsSection'
import AddWishlistModal from '../components/AddWishlistModal'

const DAY = 86_400_000

function fmtYuan(minor: number): string {
  return '¥' + (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function countdownText(endISO: string): string {
  const diff = new Date(endISO).getTime() - Date.now()
  if (diff <= 0) return '冷却结束，可以决定啦'
  const h = Math.floor(diff / 3600_000)
  const m = Math.floor((diff % 3600_000) / 60_000)
  return h > 0 ? `${h}小时${m}分` : `${m}分钟`
}

function timeLeftPct(addedISO: string, endISO: string): number {
  const total = new Date(endISO).getTime() - new Date(addedISO).getTime()
  const left = new Date(endISO).getTime() - Date.now()
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((left / total) * 100)))
}

const STATUS_LABEL: Record<string, string> = {
  cooling: '冷却中',
  confirmed: '已确认购买',
  abandoned: '已放弃',
}

/** 右栏统计行 */
function StatRow({ label, value, color = '#111111' }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 12px', background: '#E4E6E6', borderRadius: 10, border: '1px solid #E4E6E6' }}>
      <span style={{ fontSize: 12.5, color: '#888888' }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}

// ==================== 冷却卡片辅助组件（AI 分析摘要直接嵌在卡片上） ====================

function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 解析商品的 aiAnalysis 摘要；未分析或损坏返回 null */
function parseSummary(item: WishlistItem): WishlistChatSummary | null {
  if (!item.aiAnalysis) return null
  try { return JSON.parse(item.aiAnalysis) as WishlistChatSummary } catch { return null }
}

function isImpulsiveTx(t: Transaction): boolean {
  return t.impulseLevel === 'high' || t.impulseLevel === 'veryHigh'
}

/** 每张冷却卡片实时算出的"触发理智"关键数据 */
interface CardKeyData {
  similarTotalYuan: number
  impulseMonthCount: number
  nightImpulseCount: number
  hoursLeft: number
}

function cardKeyData(item: WishlistItem, txs: Transaction[]): CardKeyData {
  const now = Date.now()
  const mk = monthKeyOf(new Date())
  const matchedCategory = classifyCategory(item.name)
  const keywords = nameKeywords(item.name)
  let similarTotal = 0
  let impulseMonth = 0
  let nightImpulse = 0
  for (const t of txs) {
    if (t.txType !== 'expense') continue
    const ts = new Date(t.time).getTime()
    if (ts > now) continue
    if (now - ts <= 90 * DAY) {
      const sameCat = t.category === matchedCategory
      const kw = keywords.some(k => k && (t.merchant.includes(k) || t.note.includes(k)))
      if (sameCat || kw) similarTotal += t.amountMinor
    }
    if (monthKeyOf(new Date(t.time)) === mk && isImpulsiveTx(t)) {
      impulseMonth++
      const h = new Date(t.time).getHours()
      if (h >= 23 || h < 6) nightImpulse++
    }
  }
  const hoursLeft = Math.max(0, Math.ceil((new Date(item.coolingEndsAt).getTime() - now) / 3_600_000))
  return { similarTotalYuan: similarTotal, impulseMonthCount: impulseMonth, nightImpulseCount: nightImpulse, hoursLeft }
}

/** ① 顶部冲动信号条（全宽彩色横幅） */
function ImpulseBanner({ need }: { need: number }) {
  const cfg = need < 40
    ? { bg: '#DC2626', text: "⚠️ 高冲动风险 · 大概率是'想要'不是'需要'" }
    : need <= 70
      ? { bg: '#f59e0b', text: '⚠️ 中等风险 · 建议再冷静想想' }
      : { bg: '#22D3EE', text: '✅ 需求较清晰 · 冷静期后可再确认' }
  return (
    <div style={{
      background: cfg.bg, color: '#FFFFFF', padding: '9px 14px', fontSize: 13.5,
      fontWeight: 700, textAlign: 'center', lineHeight: 1.5,
    }}>
      {cfg.text}
    </div>
  )
}

/** ② 真实需求指数条（红→黄→绿渐变进度条 + 大字数字 + 说明） */
function NeedBar({ need }: { need: number }) {
  const caption = need > 70 ? '需求较清晰，冷静期后可再确认'
    : need >= 40 ? '需求一般，可以再等等'
      : '真实需求不高，大概率是冲动'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 11.5, color: '#888888', fontWeight: 600 }}>真实需求指数</span>
        <b style={{ fontSize: 19, color: need < 40 ? '#DC2626' : need <= 70 ? '#f59e0b' : '#22D3EE', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{need}</b>
      </div>
      <div style={{ height: 10, background: '#E4E6E6', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${need}%`,
          background: 'linear-gradient(90deg,#E11D48,#f59e0b,#22D3EE)',
          borderRadius: 6, transition: 'width 0.6s ease',
        }} />
      </div>
      <div style={{ fontSize: 11, color: '#888888', marginTop: 4 }}>{caption}</div>
    </div>
  )
}

/** ③ 命中陷阱标签（浅琥珀底圆角，悬停显示极短说明） */
const TRAP_HINT: Record<string, string> = {
  '稀缺效应': '限时限量让你觉得错过就没了，其实它一直都在',
  '损失厌恶': '害怕错过优惠，把"省钱"变成了"消费"的理由',
  '奖励心理': '把买买买当奖励自己的方式，其实可以用免费的',
  '心理账户': '给这笔钱找了"专用"理由，但它还是你的钱',
  '从众': '看到别人买、大家都在讨论，于是也想要',
  '沉没成本': '已经为它花过时间精力不舍得放弃，继续只会花更多',
  '锚定效应': '原价/划线价只是让你觉得"赚了"，实际并不便宜',
  '冲动消费': '情绪上头就下单，冷静后大多后悔',
}

function TrapChips({ traps }: { traps: string[] }) {
  if (traps.length === 0) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {traps.map((t, i) => (
        <span key={i} title={TRAP_HINT[t] ?? `你命中了「${t}」心理机制`}
          style={{ background: '#E4E6E6', color: '#f59e0b', borderRadius: 999, padding: '3px 10px', fontSize: 11.5, cursor: 'help' }}>
          ⚠️ {t}
        </span>
      ))}
    </div>
  )
}

/** ④ 关键数据卡（2-3 个迷你数字，哪个有就显示哪个） */
function KeyData({ data }: { data: CardKeyData }) {
  const cells: { value: string; label: string; color: string }[] = []
  if (data.similarTotalYuan > 0) {
    cells.push({ value: fmtYuan(data.similarTotalYuan), label: '近90天同类已花', color: '#f59e0b' })
  }
  if (data.impulseMonthCount > 0) {
    cells.push({
      value: `${data.impulseMonthCount}笔`,
      label: data.nightImpulseCount > 0 ? `本月冲动 · 深夜${data.nightImpulseCount}笔` : '本月已冲动',
      color: '#F43F5E',
    })
  }
  if (data.hoursLeft > 0) {
    cells.push({ value: `${data.hoursLeft}h`, label: '冷静期还剩', color: '#0040FF' })
  }
  if (cells.length === 0) return null
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cells.length}, 1fr)`, gap: 8 }}>
      {cells.map((c, i) => (
        <div key={i} style={{ background: '#E4E6E6', border: '1px solid #E4E6E6', borderRadius: 10, padding: '8px 6px', textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: c.color, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>{c.value}</div>
          <div style={{ fontSize: 10.5, color: '#888888', marginTop: 2 }}>{c.label}</div>
        </div>
      ))}
    </div>
  )
}

let uidSeq = 0
function msgUid(): string {
  return `wc${++uidSeq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

// ==================== 分析总结卡片 ====================

function SummaryCard({ summary, onExtend, onResume }: {
  summary: WishlistChatSummary
  onExtend: () => void
  onResume: () => void
}) {
  const need = Math.max(0, Math.min(100, summary.realNeedIndex))
  const needColor = need >= 70 ? '#22D3EE' : need >= 45 ? '#f59e0b' : '#DC2626'
  const conclusionLabel = summary.conclusion === 'buy' ? '建议购买'
    : summary.conclusion === 'delay' ? '建议延迟' : '建议不买'
  const conclusionColor = summary.conclusion === 'buy' ? '#22D3EE'
    : summary.conclusion === 'delay' ? '#f59e0b' : '#DC2626'

  return (
    <div style={{
      marginTop: 12, background: '#E4E6E6', border: '1px solid #E4E6E6', borderRadius: 16,
      padding: 16, animation: 'fadeInUp 0.4s ease both',
    }}>
      {/* 结论 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{
          background: conclusionColor + '1A', color: conclusionColor, borderRadius: 999,
          padding: '4px 12px', fontSize: 13, fontWeight: 700, flexShrink: 0,
        }}>
          {conclusionLabel}
        </span>
        <span style={{ fontSize: 13.5, color: '#111111', lineHeight: 1.6 }}>{summary.verdict}</span>
      </div>

      {/* 雷达图 + 需求指数 */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 12 }}>
        <RadarChart items={summary.dimensions} size={190} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: '#888888', marginBottom: 6 }}>真实需求指数</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, height: 10, background: '#E4E6E6', borderRadius: 5, overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${need}%`, background: needColor, borderRadius: 5,
                transition: 'width 0.6s ease',
              }} />
            </div>
            <b style={{ fontSize: 16, color: needColor, fontVariantNumeric: 'tabular-nums' }}>{need}</b>
          </div>
          <div style={{ fontSize: 11.5, color: '#888888', marginTop: 8 }}>
            {need >= 70 ? '真实需求很高，这个钱花得不冤'
              : need >= 45 ? '需求一般，可以再等等'
                : '真实需求不高，大概率是冲动'}
          </div>
        </div>
      </div>

      {/* 依据 */}
      {summary.reasons.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#111111', marginBottom: 6 }}>为什么这么判断</div>
          {summary.reasons.map((r, i) => (
            <div key={i} style={{
              fontSize: 12.5, color: '#888888', lineHeight: 1.6, marginBottom: 4,
              paddingLeft: 12, borderLeft: '2px solid #C0C4C4',
            }}>
              {r}
            </div>
          ))}
        </div>
      )}

      {/* 陷阱标签 */}
      {summary.traps.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#111111', marginBottom: 6 }}>命中的消费主义陷阱</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {summary.traps.map((t, i) => (
              <span key={i} style={{ background: '#E4E6E6', color: '#0040FF', borderRadius: 999, padding: '3px 10px', fontSize: 11.5 }}>
                ⚠️ {t}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 替代方案 */}
      {summary.alternatives.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#111111', marginBottom: 6 }}>可以替代它的方式</div>
          {summary.alternatives.map((a, i) => (
            <div key={i} style={{ fontSize: 12.5, color: '#22D3EE', background: '#E4E6E6', borderRadius: 10, padding: '7px 12px', marginBottom: 6 }}>
              🌿 {a}
            </div>
          ))}
        </div>
      )}

      {/* 冷静期操作 */}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button onClick={onExtend} style={{
          flex: 1, background: '#f59e0b', color: '#FFFFFF', border: 'none', borderRadius: 10,
          padding: '9px 0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-stack)',
        }}>
          ⏳ 延长冷静期 {summary.coolingDays} 天
        </button>
        <button onClick={onResume} style={{
          flex: 1, background: '#D8DADA', color: '#0040FF', border: '1px solid #C0C4C4', borderRadius: 10,
          padding: '9px 0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-stack)',
        }}>
          💬 继续聊聊
        </button>
      </div>
    </div>
  )
}

// ==================== 对话面板 ====================

function ChatPanel({ chat, typing, input, statusLog, listRef, onInput, onSend, onFinalize, onResume, onExtend, onClose }: {
  chat: WishlistChat
  typing: boolean
  input: string
  statusLog: string[]
  listRef: RefObject<HTMLDivElement | null>
  onInput: (v: string) => void
  onSend: () => void
  onFinalize: () => void
  onResume: () => void
  onExtend: () => void
  onClose: () => void
}) {
  const completed = chat.status === 'completed'
  const visible = chat.messages.filter(m => m.role !== 'tool' && m.content.trim() && !(m.toolCalls && m.toolCalls.length > 0))

  return (
    <div style={{ marginTop: 12, background: '#D8DADA', border: '1px solid #C0C4C4', borderRadius: 16, padding: 14, animation: 'fadeInUp 0.3s ease both' }}>
      {/* 头部 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#111111' }}>💬 AI 深度分析</span>
        <span style={{
          fontSize: 11, color: completed ? '#22D3EE' : '#0040FF', background: completed ? '#E4E6E6' : '#E4E6E6',
          borderRadius: 999, padding: '2px 10px',
        }}>
          {completed ? '已出结论' : '进行中'}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {!completed && (
            <button onClick={onFinalize} style={{
              padding: '5px 12px', borderRadius: 8, border: '1px solid #C0C4C4', background: '#D8DADA',
              color: '#0040FF', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-stack)',
            }}>
              结束分析，给结论
            </button>
          )}
          <button onClick={onClose} style={{
            padding: '5px 12px', borderRadius: 8, border: '1px solid #C0C4C4', background: '#D8DADA',
            color: '#888888', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font-stack)',
          }}>
            收起
          </button>
        </div>
      </div>

      {/* 消息流 */}
      <div ref={listRef} style={{
        maxHeight: 340, overflowY: 'auto', background: '#E4E6E6', borderRadius: 12, padding: 12,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        {visible.map(m => m.role === 'assistant' ? (
          <div key={m.id} style={{
            alignSelf: 'flex-start', maxWidth: '82%', background: '#D8DADA', border: '1px solid #C0C4C4',
            borderRadius: 12, padding: '9px 12px', fontSize: 13.5, color: '#111111', lineHeight: 1.65,
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)', wordBreak: 'break-word',
          }}>
            {isHtmlContent(m.content) ? <AiHtml html={m.content} /> : <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>}
          </div>
        ) : (
          <div key={m.id} style={{
            alignSelf: 'flex-end', maxWidth: '82%', background: '#0040FF', color: '#FFFFFF',
            borderRadius: 12, padding: '9px 12px', fontSize: 13.5, lineHeight: 1.65, whiteSpace: 'pre-wrap',
          }}>
            {m.content}
          </div>
        ))}

        {/* 打字指示器 */}
        {typing && (
          <div style={{
            alignSelf: 'flex-start', display: 'flex', gap: 5, background: '#D8DADA', border: '1px solid #C0C4C4',
            borderRadius: 12, padding: '13px 15px',
          }}>
            <span className="typing-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: '#888888' }} />
            <span className="typing-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: '#888888', animationDelay: '0.15s' }} />
            <span className="typing-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: '#888888', animationDelay: '0.3s' }} />
          </div>
        )}

        {/* 工具调用状态 */}
        {statusLog.map((s, i) => (
          <div key={i} style={{
            alignSelf: 'center', fontSize: 11, color: '#0040FF', background: '#E4E6E6',
            borderRadius: 999, padding: '3px 12px', animation: 'fadeInUp 0.25s ease both',
          }}>
            {s}
          </div>
        ))}
      </div>

      {/* 总结卡片 */}
      {completed && chat.summary && (
        <SummaryCard summary={chat.summary} onExtend={onExtend} onResume={onResume} />
      )}

      {/* 输入区 */}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input
          value={input}
          onChange={e => onInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSend() }}
          disabled={completed || typing}
          placeholder={completed ? '对话已结束' : '和 AI 聊聊你的想法…'}
          style={{
            flex: 1, padding: '9px 12px', borderRadius: 10, border: '1px solid #C0C4C4', outline: 'none',
            fontSize: 13.5, color: '#111111', background: completed ? '#E4E6E6' : '#FFFFFF',
            fontFamily: 'var(--font-stack)',
          }}
        />
        <button
          onClick={onSend}
          disabled={completed || typing || !input.trim()}
          style={{
            padding: '0 18px', borderRadius: 10, border: 'none', background: completed || typing || !input.trim() ? '#C0C4C4' : '#0040FF',
            color: '#FFFFFF', fontSize: 13.5, fontWeight: 600, cursor: completed || typing || !input.trim() ? 'not-allowed' : 'pointer',
            fontFamily: 'var(--font-stack)',
          }}
        >
          发送
        </button>
      </div>
    </div>
  )
}

// ==================== 页面 ====================

export default function Wishlist() {
  const [items, setItems] = useState<WishlistItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [apiOn, setApiOn] = useState(false)
  const [chats, setChats] = useState<Record<string, WishlistChat>>({})
  const [openId, setOpenId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [typing, setTyping] = useState(false)
  const [statusLog, setStatusLog] = useState<string[]>([])
  const [showAddModal, setShowAddModal] = useState(false)
  const [noKeyHint, setNoKeyHint] = useState<string | null>(null)
  // 全量交易/消费事件：冷却卡片关键数据 + 理智恢复统计（本地实时算）
  const [txs, setTxs] = useState<Transaction[]>([])
  const [events, setEvents] = useState<ConsumerEvent[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  // 响应式：<900px 降单栏
  const [isWide, setIsWide] = useState(window.innerWidth >= 900)

  async function load() {
    const list = await db.wishlist.toArray()
    list.sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime())
    setItems(list)
    setLoaded(true)
  }

  async function loadChats() {
    const list = await getAllWishlistChats()
    const map: Record<string, WishlistChat> = {}
    for (const c of list) map[c.wishlistId] = c
    setChats(map)
  }

  useEffect(() => { void load() }, [])
  useEffect(() => {
    void hasApiKey().then(setApiOn)
    void loadChats()
    void db.transactions.toArray().then(setTxs)
    void db.consumerEvents.toArray().then(setEvents)
  }, [])

  useEffect(() => {
    const h = () => { void load(); void loadChats(); void db.transactions.toArray().then(setTxs) }
    window.addEventListener('dashboard-refresh', h)
    return () => window.removeEventListener('dashboard-refresh', h)
  }, [])

  // 响应式：监听窗口宽度
  useEffect(() => {
    const h = () => setIsWide(window.innerWidth >= 900)
    window.addEventListener('resize', h)
    return () => window.removeEventListener('resize', h)
  }, [])

  // 消息变化自动滚到底
  const openChat = openId ? chats[openId] : undefined
  const msgCount = openChat?.messages.length ?? 0
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [openId, msgCount, typing, statusLog])

  async function setStatus(item: WishlistItem, status: 'confirmed' | 'abandoned') {
    await updateWishlistItem(item.id, { status, resolvedAt: new Date().toISOString() })
    await load()
    window.dispatchEvent(new CustomEvent('dashboard-refresh'))
  }

  /** 放弃：确认弹窗提示"省下 ¥X 转存储蓄"，给放弃一个正反馈 */
  function handleAbandon(item: WishlistItem) {
    const saved = fmtYuan(item.priceMinor)
    if (window.confirm(`放弃「${item.name}」？省下 ${saved} 将转存储蓄，让这笔钱为你工作。`)) {
      void setStatus(item, 'abandoned')
    }
  }

  // ============ 确认购买（记录实际入手价，降价追踪） ============

  const [buying, setBuying] = useState<WishlistItem | null>(null)
  const [buyPriceText, setBuyPriceText] = useState('')

  /** 已确认且有实际价的记录 → 历史平均降价率（"再等等还能降 X%"的依据） */
  function avgHistoricalDropPct(): number {
    const rows = items.filter(i => i.status === 'confirmed' && i.finalPriceMinor != null && i.finalPriceMinor < i.priceMinor)
    if (rows.length === 0) return 0
    return Math.round(
      rows.reduce((s, i) => s + ((i.priceMinor - (i.finalPriceMinor ?? 0)) / i.priceMinor), 0) / rows.length * 100
    )
  }

  function openBuyModal(item: WishlistItem) {
    setBuying(item)
    setBuyPriceText((item.priceMinor / 100).toFixed(2))
  }

  async function confirmBuy() {
    if (!buying) return
    let finalMinor = Math.round(parseFloat(buyPriceText) * 100)
    if (isNaN(finalMinor) || finalMinor <= 0) finalMinor = buying.priceMinor
    await updateWishlistItem(buying.id, {
      status: 'confirmed',
      finalPriceMinor: finalMinor,
      boughtAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
    })
    setBuying(null)
    await load()
    window.dispatchEvent(new CustomEvent('dashboard-refresh'))
  }

  // ============ 对话线程 ============

  async function saveChat(chat: WishlistChat) {
    await updateWishlistChat(chat.id, {
      messages: chat.messages,
      status: chat.status,
      summary: chat.summary,
      updatedAt: chat.updatedAt,
    })
    setChats(prev => ({ ...prev, [chat.wishlistId]: chat }))
  }

  async function createChat(item: WishlistItem): Promise<WishlistChat> {
    const facts = await buildWishlistFacts(item)
    const greeting = await generateWishlistOpening(facts)
    const chat: WishlistChat = {
      id: msgUid(),
      wishlistId: item.id,
      messages: [{ id: msgUid(), role: 'assistant', content: greeting, ts: Date.now() }],
      status: 'chatting',
      summary: null,
      updatedAt: new Date().toISOString(),
    }
    await addWishlistChat(chat)
    return chat
  }

  function toggleOpen(item: WishlistItem) {
    if (openId === item.id) { setOpenId(null); return }
    setInput('')
    setStatusLog([])
    setOpenId(item.id)
    if (!chats[item.id]) {
      void createChat(item).then(chat => {
        setChats(prev => ({ ...prev, [item.id]: chat }))
      }).catch(() => undefined)
    }
  }

  async function saveWishlistAnalysis(item: WishlistItem, summary: WishlistChatSummary) {
    await updateWishlistItem(item.id, { aiAnalysis: JSON.stringify(summary) })
  }

  async function handleSend() {
    const text = input.trim()
    const item = items.find(i => i.id === openId)
    let chat = openChat
    if (!text || typing || !item || !chat || chat.status === 'completed') return
    setInput('')
    setStatusLog([])
    const userMsg: WishlistChatMsg = { id: msgUid(), role: 'user', content: text, ts: Date.now() }
    chat = { ...chat, messages: [...chat.messages, userMsg], updatedAt: new Date().toISOString() }
    await saveChat(chat)
    if (isEndIntent(text)) {
      await finalize(item, chat)
      return
    }
    setTyping(true)
    try {
      const facts = await buildWishlistFacts(item)
      const result = await runWishlistTurn({
        item,
        facts,
        history: chat.messages,
        userText: text,
        onStatus: (s) => {
          setStatusLog(prev => [...prev, s.state === 'running' ? `🤖 ${s.label}` : s.label])
        },
      })
      const aiMsg: WishlistChatMsg = { id: msgUid(), role: 'assistant', content: result.reply, ts: Date.now() }
      const next: WishlistChat = { ...chat, messages: [...chat.messages, aiMsg], updatedAt: new Date().toISOString() }
      if (result.summary) {
        next.summary = result.summary
        next.status = 'completed'
        await saveWishlistAnalysis(item, result.summary)
      }
      await saveChat(next)
    } catch (e) {
      const errMsg: WishlistChatMsg = {
        id: msgUid(), role: 'assistant', content: `⚠️ ${aiErrorMessage(e)}`, ts: Date.now(),
      }
      await saveChat({ ...chat, messages: [...chat.messages, errMsg] })
    } finally {
      setTyping(false)
      setStatusLog([])
    }
  }

  async function finalize(item: WishlistItem, chat: WishlistChat) {
    if (typing) return
    setTyping(true)
    setStatusLog(['🤖 正在整理分析结论…'])
    try {
      const facts = await buildWishlistFacts(item)
      const summary = await generateWishlistSummary({ item, facts, history: chat.messages })
      if (summary) {
        const closing: WishlistChatMsg = {
          id: msgUid(),
          role: 'assistant',
          content: `好，聊到这我的建议是：${summary.verdict}`,
          ts: Date.now(),
        }
        const next: WishlistChat = {
          ...chat,
          messages: [...chat.messages, closing],
          status: 'completed',
          summary,
          updatedAt: new Date().toISOString(),
        }
        await saveChat(next)
        await saveWishlistAnalysis(item, summary)
      } else {
        const warn: WishlistChatMsg = {
          id: msgUid(),
          role: 'assistant',
          content: '⚠️ 暂时没能整理出结论（可能是网络问题），你可以再试一次，或者继续聊聊。',
          ts: Date.now(),
        }
        await saveChat({ ...chat, messages: [...chat.messages, warn] })
      }
    } catch (e) {
      const errMsg: WishlistChatMsg = {
        id: msgUid(), role: 'assistant', content: `⚠️ ${aiErrorMessage(e)}`, ts: Date.now(),
      }
      await saveChat({ ...chat, messages: [...chat.messages, errMsg] })
    } finally {
      setTyping(false)
      setStatusLog([])
    }
  }

  async function extendCooling(item: WishlistItem) {
    const chat = chats[item.id]
    const days = chat?.summary?.coolingDays ?? 3
    await updateWishlistItem(item.id, {
      coolingDays: item.coolingDays + days,
      coolingEndsAt: new Date(Date.now() + days * DAY).toISOString(),
      extendCount: (item.extendCount ?? 0) + 1,
    })
    await load()
  }

  async function resumeChat(chat: WishlistChat) {
    await saveChat({ ...chat, status: 'chatting', updatedAt: new Date().toISOString() })
  }

  // ============ 理智恢复统计（顶部冷静辅助数据卡，本地实时算） ============

  const mkNow = monthKeyOf(new Date())
  const abandonedRows = items.filter(i => i.status === 'abandoned' && (i.resolvedAt ?? '').startsWith(mkNow))
  const abandonedSavedMinor = abandonedRows.reduce((s, i) => s + i.priceMinor, 0)
  // 同类重复加入：同类商品被反复放进清单的次数（商品总数 - 分类数）
  const dupCount = Math.max(0, items.length - new Set(items.map(i => classifyCategory(i.name))).size)
  // 购买后悔率：优先 30 天反馈（qualityScore=20 视为后悔），否则用交易后悔标记
  const regretPct = (() => {
    const done = events.filter(e => e.feedbackStatus === 'done')
    if (done.length > 0) return Math.round(done.filter(e => e.qualityScore === 20).length / done.length * 100)
    const marked = txs.filter(t => t.regretValue != null)
    if (marked.length > 0) return Math.round(marked.filter(t => t.regretValue).length / marked.length * 100)
    return null
  })()
  const avgExtend = items.length > 0
    ? Math.round(items.reduce((s, i) => s + (i.extendCount ?? 0), 0) / items.length * 10) / 10
    : 0

  // ============ 渲染 ============

  const nowTs = Date.now()
  const cooling = items.filter(i => i.status === 'cooling')
  const coolingActive = cooling.filter(i => new Date(i.coolingEndsAt).getTime() > nowTs)
  const coolingReady = cooling.filter(i => new Date(i.coolingEndsAt).getTime() <= nowTs)
  const finished = items.filter(i => i.status === 'confirmed' || i.status === 'abandoned')

  /** 冷却卡（冷却中 / 可确认 共用） */
  function renderCoolCard(item: WishlistItem) {
    const summary = parseSummary(item)
    const need = summary ? Math.max(0, Math.min(100, summary.realNeedIndex)) : null
    const chat = chats[item.id]
    const pct = timeLeftPct(item.addedAt, item.coolingEndsAt)
    const data = cardKeyData(item, txs)
    return (
      <div key={item.id} style={{
        background: '#D8DADA', borderRadius: 16, overflow: 'hidden',
        boxShadow: '0 1px 3px rgba(15,23,42,0.08)', border: '1px solid #E4E6E6',
        animation: 'fadeInUp 0.3s ease both',
      }}>
        {/* ① 顶部冲动信号条（全宽彩色） */}
        {need != null && <ImpulseBanner need={need} />}
        <div style={{ padding: 14 }}>
          {/* 商品名 + 价格 + 倒计时 */}
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14.5, fontWeight: 600, color: '#111111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.name}
              </div>
              <div style={{ fontSize: 12, color: '#f59e0b', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                ⏳ 还剩 {countdownText(item.coolingEndsAt)}
              </div>
            </div>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#111111', fontVariantNumeric: 'tabular-nums' }}>
              {fmtYuan(item.priceMinor)}
            </span>
          </div>
          {/* 冷却进度条 */}
          <div style={{ height: 5, background: '#E4E6E6', borderRadius: 3, marginTop: 8, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${100 - pct}%`, background: '#f59e0b', borderRadius: 3, transition: 'width 0.6s ease' }} />
          </div>

          {summary ? (
            <>
              {/* ② 真实需求指数条 */}
              <div style={{ marginTop: 12 }}><NeedBar need={need!} /></div>
              {/* ③ 命中陷阱标签 */}
              <div style={{ marginTop: 10 }}><TrapChips traps={summary.traps} /></div>
              {/* ④ 关键数据卡（同类已花 / 本月冲动 / 冷静期剩） */}
              <div style={{ marginTop: 10 }}><KeyData data={data} /></div>
              {/* ⑤ AI 一句话建议（浅青卡片） */}
              <div style={{
                marginTop: 10, background: '#E4E6E6', border: '1px solid rgba(34,211,238,0.2)',
                borderRadius: 10, padding: '9px 12px', fontSize: 12.5, color: '#22D3EE', lineHeight: 1.6,
              }}>
                💡 AI 建议：{summary.verdict}
              </div>
              {/* ⑥ 替代方案 */}
              {summary.alternatives.length > 0 && (
                <div style={{ fontSize: 11.5, color: '#888888', marginTop: 8, lineHeight: 1.6 }}>
                  🌿 替代：{summary.alternatives.slice(0, 2).join('；')}
                </div>
              )}
            </>
          ) : (
            /* 分析结果还没生成：引导按钮 + 卡片内展开对话 */
            <div style={{ marginTop: 12 }}>
              <button onClick={() => { if (apiOn) toggleOpen(item); else setNoKeyHint(item.id) }}
                style={{
                  width: '100%', padding: '11px 0', borderRadius: 10, border: '1px dashed #888888',
                  background: '#E4E6E6', color: '#0040FF', fontSize: 13, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'var(--font-stack)',
                }}>
                🤖 点这里让 AI 分析
              </button>
              {noKeyHint === item.id && (
                <div style={{ fontSize: 11.5, color: '#0040FF', textAlign: 'center', marginTop: 6 }}>
                  请先到设置页配置 API Key，即可使用 AI 分析
                </div>
              )}
              {!noKeyHint && (
                <div style={{ fontSize: 11, color: '#888888', textAlign: 'center', marginTop: 6 }}>
                  AI 会结合你的消费数据，帮你判断这笔值不值得
                </div>
              )}
            </div>
          )}

          {/* ⑦ 操作按钮区 */}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={() => handleAbandon(item)} title="放弃后省下的钱会进入你的储蓄意识"
              style={{
                flex: 1, padding: '9px 0', borderRadius: 10, border: '1px solid #C0C4C4',
                background: '#D8DADA', color: '#888888', fontSize: 13, fontWeight: 500,
                cursor: 'pointer', fontFamily: 'var(--font-stack)',
              }}>
              放弃
            </button>
            <button onClick={() => openBuyModal(item)}
              style={{
                flex: 1.3, padding: '9px 0', borderRadius: 10, border: 'none',
                background: '#0040FF', color: '#FFFFFF', fontSize: 13, fontWeight: 600,
                cursor: 'pointer', fontFamily: 'var(--font-stack)',
              }}>
              确认购买
            </button>
            <button onClick={() => void extendCooling(item)} title="再冷静几天，避免冲动"
              style={{
                flex: 1, padding: '9px 0', borderRadius: 10, border: '1px solid rgba(245,158,11,0.2)',
                background: '#E4E6E6', color: '#f59e0b', fontSize: 12.5, fontWeight: 600,
                cursor: 'pointer', fontFamily: 'var(--font-stack)',
              }}>
              ⏳ 延长
            </button>
          </div>

          {/* AI 对话入口（卡片内联展开，不跳页面） */}
          {apiOn && (
            <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => toggleOpen(item)}
                style={{
                  fontSize: 11.5, color: '#0040FF', background: 'none', border: 'none',
                  cursor: 'pointer', padding: 0, textDecoration: 'underline dotted',
                  fontFamily: 'var(--font-stack)',
                }}>
                {openId === item.id
                  ? '收起对话'
                  : chat?.status === 'completed'
                    ? '💬 继续和 AI 聊聊'
                    : summary
                      ? '💬 重新聊聊'
                      : '🤖 深度分析'}
              </button>
            </div>
          )}
          {apiOn && openId === item.id && (
            chat ? (
              <ChatPanel
                chat={chat}
                typing={typing}
                input={input}
                statusLog={statusLog}
                listRef={listRef}
                onInput={setInput}
                onSend={() => void handleSend()}
                onFinalize={() => void finalize(item, chat)}
                onResume={() => void resumeChat(chat)}
                onExtend={() => void extendCooling(item)}
                onClose={() => setOpenId(null)}
              />
            ) : (
              <div style={{ fontSize: 12, color: '#888888', marginTop: 8 }}>🤖 正在准备对话…</div>
            )
          )}
        </div>
      </div>
    )
  }

  // 等等更便宜：确认购买且填了实际入手价的记录 → 平均降价金额 / 平均降价率 / 总省下金额
  const priceDrop = (() => {
    const rows = items.filter(i => i.status === 'confirmed' && i.finalPriceMinor != null && i.finalPriceMinor < i.priceMinor)
    if (rows.length === 0) return null
    const totalSaved = rows.reduce((s, i) => s + ((i.priceMinor ?? 0) - (i.finalPriceMinor ?? 0)), 0)
    const avgDropAmount = Math.round(totalSaved / rows.length)
    const avgDropRate = Math.round(
      rows.reduce((s, i) => s + (((i.priceMinor ?? 0) - (i.finalPriceMinor ?? 0)) / (i.priceMinor ?? 1)), 0) / rows.length * 100
    )
    return { count: rows.length, totalSaved, avgDropAmount, avgDropRate }
  })()

  return (
    <div style={{ maxWidth: 1100, width: '100%' }}>
      {/* 高频冲动窗口温和提示条 */}
      <ForecastBanner />
      {/* 自我承诺合约 */}
      <CommitmentsSection />
      {/* 等等更便宜：冷静后买的平均降价统计 */}
      {priceDrop && (
        <div style={{
          marginBottom: 16, padding: '16px 18px', borderRadius: 16,
          background: 'linear-gradient(135deg, #E4E6E6 0%, #E4E6E6 100%)',
          border: '1px solid #C0C4C4',
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#0040FF', marginBottom: 10 }}>💸 等等更便宜</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            <div style={{ background: '#D8DADA', borderRadius: 10, padding: '10px 8px', textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: '#888888' }}>平均降价</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: '#22D3EE', fontVariantNumeric: 'tabular-nums' }}>{fmtYuan(priceDrop.avgDropAmount)}</div>
            </div>
            <div style={{ background: '#D8DADA', borderRadius: 10, padding: '10px 8px', textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: '#888888' }}>平均降价率</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: '#22D3EE', fontVariantNumeric: 'tabular-nums' }}>{priceDrop.avgDropRate}%</div>
            </div>
            <div style={{ background: '#D8DADA', borderRadius: 10, padding: '10px 8px', textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: '#888888' }}>共省下</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: '#22D3EE', fontVariantNumeric: 'tabular-nums' }}>{fmtYuan(priceDrop.totalSaved)}</div>
            </div>
          </div>
          <div style={{ fontSize: 12, color: '#0040FF', marginTop: 10 }}>
            你冷静后买的 <b>{priceDrop.count}</b> 件，平均比刚想买时便宜 <b>{priceDrop.avgDropRate}%</b>——等待确实划算
          </div>
        </div>
      )}
      <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--color-text)', marginBottom: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>决策清单</span>
        <button onClick={() => setShowAddModal(true)}
          style={{
            padding: '6px 14px', borderRadius: 10, border: '1px solid #C0C4C4',
            background: '#E4E6E6', color: '#0040FF', fontSize: 13, fontWeight: 600,
            cursor: 'pointer', fontFamily: 'var(--font-stack)',
          }}>
          ＋ 添加
        </button>
      </h1>
      <p style={{ fontSize: 14, color: 'var(--color-text-secondary)', marginBottom: 16 }}>
        想买的先写下来，冷静 24 小时再决定
      </p>

      {/* 两栏布局：左 2/3 清单区块 · 右 1/3 冷静辅助数据 + 清单统计 */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: isWide ? '2fr 1fr' : '1fr',
        gap: 24,
        alignItems: 'start',
      }}>

        {/* ========== 左栏：冷却中 / 可确认 / 已决定 ========== */}
        <div style={{ minWidth: 0 }}>
          {!loaded ? null : items.length === 0 ? (
            <div className="card" style={{ padding: 48, textAlign: 'center' }}>
              <div style={{ fontSize: 40 }}>🧾</div>
              <div style={{ fontSize: 14, color: '#888888', marginTop: 10 }}>
                还没有清单记录。记账时被预警拦截的消费，会出现在这里等你冷静。
              </div>
              <button onClick={() => setShowAddModal(true)}
                className="btn-primary"
                style={{ marginTop: 16, padding: '10px 24px', fontSize: 14 }}>
                ＋ 添加第一个想买的
              </button>
            </div>
          ) : (
            <>
              {coolingActive.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text)', marginBottom: 4 }}>
                    🧊 冷却中（{coolingActive.length}）
                  </div>
                  <div style={{ fontSize: 12, color: '#888888', marginBottom: 12 }}>
                    冷静结束后再决定要不要买 · AI 分析已直接展示在卡片上
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {coolingActive.map(renderCoolCard)}
                  </div>
                </div>
              )}

              {coolingReady.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#22D3EE', marginBottom: 4 }}>
                    ✅ 可确认（{coolingReady.length}）
                  </div>
                  <div style={{ fontSize: 12, color: '#888888', marginBottom: 12 }}>
                    冷静期已结束，现在可以下决定了
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {coolingReady.map(renderCoolCard)}
                  </div>
                </div>
              )}

              {finished.length > 0 && (
                <div className="card" style={{ padding: 20 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text)', marginBottom: 8 }}>已决定</div>
                  {finished.map((item, i) => (
                    <div key={item.id} style={{
                      display: 'flex', alignItems: 'center', padding: '10px 0',
                      borderBottom: i < finished.length - 1 ? '1px solid #E4E6E6' : 'none',
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, color: '#111111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.name}
                        </div>
                        <div style={{ fontSize: 11.5, color: '#888888', marginTop: 1 }}>
                          {STATUS_LABEL[item.status]}
                        </div>
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 600, color: item.status === 'abandoned' ? '#888888' : '#111111', fontVariantNumeric: 'tabular-nums' }}>
                        {item.finalPriceMinor != null && item.finalPriceMinor < item.priceMinor
                          ? <s style={{ color: '#888888', fontWeight: 400 }}>{fmtYuan(item.priceMinor)}</s>
                          : null}{' '}
                        {item.finalPriceMinor != null ? fmtYuan(item.finalPriceMinor) : fmtYuan(item.priceMinor)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* ========== 右栏：冷静辅助数据 + 清单统计 ========== */}
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* 冷静辅助数据卡 */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text)', marginBottom: 12 }}>🧠 冷静辅助数据</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div style={{ background: '#E4E6E6', border: '1px solid rgba(34,211,238,0.2)', borderRadius: 14, padding: '11px 14px' }}>
                <div style={{ fontSize: 11, color: '#22D3EE', marginBottom: 3 }}>🛡️ 本月已放弃 · 省下</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#22D3EE', fontVariantNumeric: 'tabular-nums', lineHeight: 1.25 }}>
                  {abandonedRows.length} 件 · {fmtYuan(abandonedSavedMinor)}
                </div>
                <div style={{ fontSize: 10.5, color: '#888888' }}>等待的回报，看得见摸得着</div>
              </div>
              <div style={{ background: '#E4E6E6', border: '1px solid rgba(249,115,22,0.2)', borderRadius: 14, padding: '11px 14px' }}>
                <div style={{ fontSize: 11, color: '#f59e0b', marginBottom: 3 }}>🔁 同类重复加入</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#f59e0b', fontVariantNumeric: 'tabular-nums', lineHeight: 1.25 }}>
                  {dupCount} 次
                </div>
                <div style={{ fontSize: 10.5, color: '#888888' }}>注意成瘾循环，同类先停一停</div>
              </div>
              <div style={{ background: '#E4E6E6', border: '1px solid rgba(0,64,255,0.2)', borderRadius: 14, padding: '11px 14px' }}>
                <div style={{ fontSize: 11, color: '#0040FF', marginBottom: 3 }}>😔 购买后悔率</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#0040FF', fontVariantNumeric: 'tabular-nums', lineHeight: 1.25 }}>
                  {regretPct == null ? '暂无反馈' : `${regretPct}%`}
                </div>
                <div style={{ fontSize: 10.5, color: '#888888' }}>历史购买后的真实感受</div>
              </div>
              <div style={{ background: '#E4E6E6', border: '1px solid #C0C4C4', borderRadius: 14, padding: '11px 14px' }}>
                <div style={{ fontSize: 11, color: '#0040FF', marginBottom: 3 }}>⏳ 冷静期平均延长</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#0040FF', fontVariantNumeric: 'tabular-nums', lineHeight: 1.25 }}>
                  {avgExtend} 次
                </div>
                <div style={{ fontSize: 10.5, color: '#888888' }}>你正在学会"再等等"</div>
              </div>
            </div>
          </div>

          {/* 清单统计 */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text)', marginBottom: 12 }}>📊 清单统计</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <StatRow label="全部记录" value={`${items.length} 件`} />
              <StatRow label="冷却中" value={`${coolingActive.length} 件`} color="#f59e0b" />
              <StatRow label="可确认" value={`${coolingReady.length} 件`} color="#22D3EE" />
              <StatRow label="已决定" value={`${finished.length} 件`} color="#0040FF" />
            </div>
          </div>
        </div>
      </div>

      {/* 确认购买弹层：填实际入手价（降价追踪） */}
      {buying && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(17,24,39,0.45)', padding: 20,
        }} onClick={() => setBuying(null)}>
          <div style={{
            background: '#D8DADA', borderRadius: 18, padding: 22, maxWidth: 400, width: '100%',
            boxShadow: 'var(--shadow-lg)', animation: 'fadeInUp 0.25s ease both',
          }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111111', marginBottom: 4 }}>确认购买</div>
            <div style={{ fontSize: 13, color: '#888888', marginBottom: 14 }}>{buying.name}</div>

            {/* 冷静期结束增强：价格对比 */}
            <div style={{ background: '#E4E6E6', border: '1px solid #C0C4C4', borderRadius: 10, padding: '10px 12px', fontSize: 12.5, color: '#0040FF', lineHeight: 1.8, marginBottom: 14 }}>
              添加时 <b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtYuan(buying.priceMinor)}</b>
              {avgHistoricalDropPct() > 0 && (
                <> → 如果你再等 7 天，历史显示同类平均还能再降 <b style={{ fontVariantNumeric: 'tabular-nums' }}>{avgHistoricalDropPct()}%</b></>
              )}
            </div>

            <div style={{ fontSize: 13, fontWeight: 600, color: '#111111', marginBottom: 6 }}>实际入手价是多少？</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 18, color: '#888888' }}>¥</span>
              <input
                type="text" inputMode="decimal" value={buyPriceText}
                onChange={(e) => setBuyPriceText(e.target.value)}
                placeholder={String((buying.priceMinor / 100).toFixed(2))}
                autoFocus
                style={{
                  flex: 1, padding: '10px 12px', fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                  border: '1px solid #C0C4C4', borderRadius: 10, outline: 'none', fontFamily: 'var(--font-stack)',
                }}
              />
            </div>
            <div style={{ fontSize: 11.5, color: '#888888', marginTop: 6 }}>默认等于添加时价格，改价后会记录"实际降价"，用于统计等等更便宜</div>

            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button onClick={() => setBuying(null)}
                style={{
                  flex: 1, padding: '11px 0', borderRadius: 12, border: '1px solid #C0C4C4',
                  background: '#D8DADA', color: '#888888', fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-stack)',
                }}>
                取消
              </button>
              <button onClick={() => void confirmBuy()}
                style={{
                  flex: 1, padding: '11px 0', borderRadius: 12, border: 'none',
                  background: '#0040FF', color: '#FFFFFF', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-stack)',
                }}>
                ✓ 确认入手
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 添加欲望弹窗 */}
      <AddWishlistModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSaved={() => setShowAddModal(false)}
      />
    </div>
  )
}

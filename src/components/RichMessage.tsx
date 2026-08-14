// oxlint-disable react/only-export-components -- 块解析工具函数与渲染组件同文件（既定设计）
import { useMemo } from 'react'
import type { ReactNode } from 'react'

// ==================== 块标记解析 ====================

export type RichBlockType = 'stat' | 'insight' | 'tip' | 'progress' | 'bars' | 'text' | 'conclusion'

export interface RichBlock {
  type: RichBlockType
  lines: string[]
}

const BLOCK_RE = /\[(stat|insight|tip|progress|bars|text|conclusion)\]([\s\S]*?)\[\/\1\]/g

/**
 * 解析 AI 返回内容中的块标记（[stat]/[insight]/[tip]/[progress]/[bars]/[text]/[conclusion]）。
 * 块标记外的纯文本段落自动降级为 [text] 块，保证不破版、不泄漏标记符号。
 */
export function parseRichBlocks(input: string): RichBlock[] {
  const blocks: RichBlock[] = []
  const re = new RegExp(BLOCK_RE.source, 'g')
  let last = 0
  let m: RegExpExecArray | null
  // 剥离孤立/未闭合的块标记符号，避免原样泄漏
  const stripMarkers = (s: string) => s.replace(/\[(?:\/)?(stat|insight|tip|progress|bars|text|conclusion)\]/g, '')
  const pushText = (raw: string) => {
    const t = stripMarkers(raw).trim()
    if (t) blocks.push({ type: 'text', lines: t.split('\n').map(s => s.trim()).filter(Boolean) })
  }
  while ((m = re.exec(input)) !== null) {
    pushText(input.slice(last, m.index))
    blocks.push({ type: m[1] as RichBlockType, lines: m[2].split('\n').map(s => s.trim()).filter(Boolean) })
    last = re.lastIndex
  }
  pushText(input.slice(last))
  return blocks
}

/** 判断文本中是否含块标记（含则用 RichMessage 渲染，否则保持原渲染方式） */
export function hasRichBlock(input: string): boolean {
  return /\[(stat|insight|tip|progress|bars|text|conclusion)\]/.test(input)
}

/** 行内轻量渲染：支持 **加粗**（AI 偶尔在块内夹带，避免星号字面泄漏） */
function renderInline(text: string): ReactNode[] {
  return text.split(/\*\*(.+?)\*\*/g).map((p, i) =>
    i % 2 === 1 ? <b key={i} style={{ fontWeight: 700 }}>{p}</b> : p)
}

/** 剥离标签里的视觉字符（AI 常把 ██ 进度条、星号、▶ 箭头写进标签），避免破坏条形/进度条宽度解析 */
const VISUAL_CHARS = /[▏▎▍▌▋▊▉█▇▆▅▄▃▂▁▶▸▹►►xX*_]/g
function cleanLabel(s: string): string {
  return s.replace(VISUAL_CHARS, '').replace(/\s+/g, ' ').trim()
}

// ==================== 单块渲染 ====================

function StatBlock({ lines }: { lines: string[] }) {
  const cards = lines.slice(0, 3).map(line => {
    const [label, value, unit = ''] = line.split('|').map(s => s.trim())
    return { label, value, unit }
  })
  return (
    <div style={{ display: 'flex', gap: 10, background: '#E4E6E6', borderRadius: 12, padding: 12, animation: 'fadeInUp 0.4s ease both' }}>
      {cards.map((c, i) => (
        <div key={i} style={{ flex: 1, background: '#D8DADA', borderRadius: 10, padding: '10px 8px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          <div style={{ fontSize: 11, color: '#A0A4A4', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cleanLabel(c.label)}</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#0040FF', fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>{c.value.replace(/\*/g, '')}</div>
          {c.unit && <div style={{ fontSize: 10, color: '#A0A4A4', marginTop: 2 }}>{cleanLabel(c.unit)}</div>}
        </div>
      ))}
    </div>
  )
}

/** 发现卡（琥珀）/ 建议卡（青）单卡：供 RichMessage 与冷静流程拆解复用 */
export function InsightCard({ text, kind = 'insight' }: { text: string; kind?: 'insight' | 'tip' }) {
  const isTip = kind === 'tip'
  return (
    <div style={{
      background: isTip ? '#ECFEFF' : '#FFFBEB',
      borderLeft: isTip ? '4px solid #22D3EE' : '4px solid #F59E0B',
      borderRadius: 12, padding: '11px 14px',
      display: 'flex', gap: 8, alignItems: 'flex-start',
    }}>
      <span style={{ fontSize: 13, lineHeight: 1.6, flexShrink: 0 }}>{isTip ? '📌' : '🔍'}</span>
      <div style={{ fontSize: 13.5, color: isTip ? '#155E75' : '#78350F', lineHeight: 1.7, flex: 1 }}>{renderInline(text)}</div>
    </div>
  )
}

const TIP_NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣']

function InsightBlock({ lines, kind }: { lines: string[]; kind: 'insight' | 'tip' }) {
  if (kind === 'tip') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {lines.slice(0, 5).map((l, i) => (
          <InsightCard key={i} text={`${TIP_NUM[i] ?? ''} ${l}`.trim()} kind="tip" />
        ))}
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {lines.slice(0, 3).map((l, i) => <InsightCard key={i} text={l} kind="insight" />)}
    </div>
  )
}

function ProgressBlock({ lines }: { lines: string[] }) {
  const [label, pctRaw] = lines[0].split('|').map(s => s.trim())
  const pct = Math.max(0, Math.min(100, parseFloat(pctRaw) || 0))
  return (
    <div style={{ animation: 'fadeInUp 0.4s ease both' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: '#374151', marginBottom: 6 }}>
        <span>{cleanLabel(label)}</span>
        <b style={{ color: '#0040FF', fontVariantNumeric: 'tabular-nums' }}>{Math.round(pct)}%</b>
      </div>
      <div style={{ height: 8, background: '#E4E6E6', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg,#0040FF,#06B6D4)', borderRadius: 4, transition: 'width 0.6s ease' }} />
      </div>
    </div>
  )
}

function BarsBlock({ lines }: { lines: string[] }) {
  const rows = lines.slice(0, 8).map(l => {
    const [label, pctRaw] = l.split('|').map(s => s.trim())
    return { label, pct: Math.max(0, Math.min(100, parseFloat(pctRaw) || 0)) }
  })
  return (
    <div style={{ background: '#E4E6E6', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, animation: 'fadeInUp 0.4s ease both' }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 60, fontSize: 12, color: '#888888', flexShrink: 0, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cleanLabel(r.label)}</span>
          <div style={{ flex: 1, height: 14, background: '#E4E6E6', borderRadius: 7, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${r.pct}%`, background: '#0040FF', borderRadius: 7, transition: 'width 0.6s ease' }} />
          </div>
          <span style={{ width: 40, fontSize: 12, fontWeight: 600, color: '#0040FF', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{Math.round(r.pct)}%</span>
        </div>
      ))}
    </div>
  )
}

function TextBlock({ lines }: { lines: string[] }) {
  return (
    <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
      {lines.map((l, i) => (
        <div key={i}>{renderInline(l)}</div>
      ))}
    </div>
  )
}

function ConclusionBlock({ lines }: { lines: string[] }) {
  return (
    <div style={{ background: '#EEF2FF', borderLeft: '4px solid #0040FF', borderRadius: 12, padding: '12px 14px', fontSize: 15, fontWeight: 600, color: '#312E81', lineHeight: 1.7 }}>
      {lines.join(' ')}
    </div>
  )
}

function BlockView({ block }: { block: RichBlock }) {
  switch (block.type) {
    case 'stat': return <StatBlock lines={block.lines} />
    case 'insight': return <InsightBlock lines={block.lines} kind="insight" />
    case 'tip': return <InsightBlock lines={block.lines} kind="tip" />
    case 'progress': return <ProgressBlock lines={block.lines} />
    case 'bars': return <BarsBlock lines={block.lines} />
    case 'conclusion': return <ConclusionBlock lines={block.lines} />
    default: return <TextBlock lines={block.lines} />
  }
}

// ==================== 主组件 ====================

/**
 * 富渲染器：把 AI 返回的块标记文本解析并按序渲染成精美卡片。
 * 所有块纵向排列（间距12px），数据块带入场动画，整体包在白卡片容器里。
 * bare 模式去掉外层白卡片（供已带容器的场景，如聊天气泡内）。
 */
export default function RichMessage({ content, bare = false, style }: {
  content: string
  bare?: boolean
  style?: React.CSSProperties
}) {
  const blocks = useMemo(() => parseRichBlocks(content), [content])
  const inner = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {blocks.map((b, i) => <BlockView key={i} block={b} />)}
    </div>
  )
  if (bare) return inner
  return (
    <div style={{ background: '#D8DADA', borderRadius: 16, boxShadow: '0 2px 12px rgba(15,23,42,0.06)', padding: 16, ...style }}>
      {inner}
    </div>
  )
}

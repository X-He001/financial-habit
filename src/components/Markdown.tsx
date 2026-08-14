import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'

// ==================== ¥金额高亮 ====================

const MONEY_RE = /(¥\s*[\d,]+(?:\.\d+)?)/g

/** 把字符串中的 ¥金额 拆成靛蓝高亮节点 */
function moneyParts(text: string, prefix: string): ReactNode[] {
  const parts = text.split(MONEY_RE)
  const out: ReactNode[] = []
  parts.forEach((p, i) => {
    if (/^¥/.test(p)) {
      out.push(
        <b key={`${prefix}-m${i}`} style={{ color: '#0040FF', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
          {p}
        </b>
      )
    } else if (p) {
      out.push(p)
    }
  })
  return out
}

/** 递归处理 children：字符串拆分 ¥金额 高亮，元素节点继续递归 */
function richChildren(children: ReactNode, prefix: string): ReactNode {
  return Children.toArray(children).map((child, i) => {
    if (typeof child === 'string') return moneyParts(child, `${prefix}-${i}`)
    if (isValidElement(child)) {
      const el = child as ReactElement<{ children?: ReactNode }>
      const kids = el.props.children != null ? richChildren(el.props.children, `${prefix}-${i}`) : undefined
      return cloneElement(el, { children: kids })
    }
    return child
  })
}

/** 提取 children 的纯文本（用于判断行类型） */
function plainText(children: ReactNode): string {
  let s = ''
  Children.forEach(children, c => {
    if (typeof c === 'string') s += c
    else if (isValidElement(c)) s += plainText((c as ReactElement<{ children?: ReactNode }>).props.children)
  })
  return s
}

/** 判断是否为"整行只有一个 **加粗**"（独立小标题） */
function boldLineText(children: ReactNode): string | null {
  let title: string | null = null
  let hasOther = false
  Children.forEach(children, c => {
    if (typeof c === 'string') {
      if (c.trim()) hasOther = true
      return
    }
    if (isValidElement(c)) {
      if ((c as ReactElement).type === StrongRenderer && title === null) {
        const s = plainText((c as ReactElement<{ children?: ReactNode }>).props.children).trim()
        if (s) title = s
        else hasOther = true
      } else {
        hasOther = true
      }
    }
  })
  return hasOther || title === null ? null : title
}

// ==================== 样式常量 ====================

/** 独立加粗行小标题：总结/结论→琥珀、动作/建议→青、其他→靛蓝 */
const boxStyle: Record<'amber' | 'cyan' | 'indigo', { bg: string; border: string; color: string; icon: string }> = {
  amber: { bg: '#FFFBEB', border: '#FDE68A', color: '#92400E', icon: '💡' },
  cyan: { bg: '#ECFEFF', border: '#A5F3FC', color: '#0E7490', icon: '✨' },
  indigo: { bg: '#EEF2FF', border: '#C7D2FE', color: '#0040FF', icon: '' },
}

function boxOf(title: string): 'amber' | 'cyan' | 'indigo' {
  if (/总结|结论/.test(title)) return 'amber'
  if (/动作|建议|行动/.test(title)) return 'cyan'
  return 'indigo'
}

function BoxTitle({ title }: { title: string }) {
  const s = boxStyle[boxOf(title)]
  return (
    <div style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 10, padding: '10px 14px', margin: '12px 0 8px' }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: s.color }}>{s.icon}{title}</span>
    </div>
  )
}

/** 行内加粗（具名组件：react-markdown 会用函数引用作为元素 type，用于识别独立加粗行） */
function StrongRenderer({ children }: { children?: ReactNode }) {
  return <strong style={{ fontWeight: 700, color: '#111111' }}>{richChildren(children, 's')}</strong>
}

// ==================== react-markdown 自定义渲染 ====================

// react-markdown 会在运行时给 li 额外传 ordered / index / checked，类型定义未覆盖，这里手动补齐
type LiProps = React.ComponentProps<'li'> & ExtraProps & { ordered?: boolean; index?: number; checked?: boolean }

const components: Components = {
  // 大标题：靛蓝 24px 粗体 + 下划线装饰
  h1: ({ children }) => (
    <h1 style={{
      fontSize: 24, fontWeight: 700, color: '#0040FF', lineHeight: 1.4,
      margin: '0 0 14px', paddingBottom: 8, borderBottom: '2px solid #0040FF',
    }}>
      {richChildren(children, 'h1')}
    </h1>
  ),
  // 小标题：深灰 18px + 左侧 4px 靛蓝竖条
  h2: ({ children }) => (
    <h2 style={{
      fontSize: 18, fontWeight: 700, color: '#111111', lineHeight: 1.5,
      borderLeft: '4px solid #0040FF', paddingLeft: 12, margin: '18px 0 8px',
    }}>
      {richChildren(children, 'h2')}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 style={{
      fontSize: 16, fontWeight: 700, color: '#111111', lineHeight: 1.5,
      borderLeft: '3px solid #0040FF', paddingLeft: 10, margin: '16px 0 6px',
    }}>
      {richChildren(children, 'h3')}
    </h3>
  ),
  // 段落：正文 14px 深灰；独立 **加粗** 行 → 彩色小标题框
  p: ({ children }) => {
    const t = boldLineText(children)
    if (t) return <BoxTitle title={t} />
    return (
      <p style={{ fontSize: 14, color: '#374151', lineHeight: 1.8, margin: '4px 0' }}>
        {richChildren(children, 'p')}
      </p>
    )
  },
  // 引用块：浅琥珀背景 + 琥珀左边框（结论框）
  blockquote: ({ children }) => (
    <blockquote style={{
      margin: '10px 0', background: '#FFFBEB', borderLeft: '4px solid #F59E0B',
      borderRadius: 10, padding: '10px 14px', fontSize: 14, color: '#78350F', lineHeight: 1.7,
    }}>
      {richChildren(children, 'bq')}
    </blockquote>
  ),
  ul: ({ children }) => <div style={{ margin: '6px 0' }}>{children}</div>,
  ol: ({ children }) => <div style={{ margin: '6px 0' }}>{children}</div>,
  // 列表项：圆点/序号靛蓝；含 建议/动作/明日/下月 关键词 → 浅青行动卡片
  li: ({ ordered, index, children }: LiProps) => {
    const txt = plainText(children)
    const isAction = /建议|动作|明日|下月|行动/.test(txt)
    if (isAction) {
      return (
        <div style={{
          background: '#ECFEFF', border: '1px solid #A5F3FC', borderRadius: 10,
          padding: '9px 12px', margin: '6px 0', lineHeight: 1.7,
        }}>
          <span style={{ fontSize: 14, color: '#0E7490' }}>📌 {richChildren(children, 'li')}</span>
        </div>
      )
    }
    return (
      <div style={{ display: 'flex', gap: 8, margin: '4px 0', lineHeight: 1.75 }}>
        <span style={{ color: ordered ? '#0040FF' : '#0040FF', fontWeight: 700, flexShrink: 0, fontSize: 14, marginTop: 1 }}>
          {ordered ? `${(index ?? 0) + 1}.` : '•'}
        </span>
        <span style={{ fontSize: 14, color: '#374151', flex: 1, minWidth: 0 }}>
          {richChildren(children, 'li')}
        </span>
      </div>
    )
  },
  strong: StrongRenderer,
  em: ({ children }) => <em style={{ color: '#888888' }}>{children}</em>,
  code: ({ children }) => (
    <code style={{ background: '#E4E6E6', padding: '1px 6px', borderRadius: 6, fontSize: 13, color: '#374151' }}>
      {children}
    </code>
  ),
  hr: () => <hr style={{ border: 'none', borderTop: '1px dashed #C0C4C4', margin: '14px 0' }} />,
}

/** 把 Markdown 渲染成精美 HTML 报告（react-markdown + 自定义样式） */
export default function Markdown({ md }: { md: string }) {
  return <ReactMarkdown components={components}>{md}</ReactMarkdown>
}

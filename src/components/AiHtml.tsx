// ==================== AI 输出 HTML 卡片渲染 ====================
// 所有 Agent 的对话回复按系统提示输出"精美 HTML 片段（内联CSS、蓝白配色）"。
// 本组件负责：检测内容是否 HTML → DOMPurify 白名单清洗 → 安全渲染。
// 富块标记文本（[stat]/[tip]…）与纯文本仍走 RichMessage / Markdown，不在此渲染。

import DOMPurify from 'dompurify'
import type { CSSProperties } from 'react'

/** 判断 AI 内容是否为 HTML 片段（含常见 HTML 标签且不是富块标记文本） */
export function isHtmlContent(s: string): boolean {
  if (!s || s.length < 8) return false
  // 富块标记走 RichMessage，避免被误判为 HTML
  if (/\[(stat|insight|tip|progress|bars|text|conclusion)\]/.test(s)) return false
  return /<(div|p|section|b|strong|h[1-6]|ul|ol|li|table|span|img|br|blockquote)\b/i.test(s)
}

/** DOMPurify 白名单清洗（与行为教练 REVIEW 同一套白名单；data-action 用于债务顾问可执行按钮） */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'div', 'p', 'span', 'b', 'strong', 'i', 'em', 'u', 'br',
      'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'img', 'a', 'code', 'pre', 'blockquote', 'button',
      'details', 'summary', // 「了解更多」折叠区（反馈卡出处唯一合法位置）
    ],
    ALLOWED_ATTR: ['style', 'class', 'href', 'src', 'alt', 'title', 'target', 'rel'],
    ALLOW_DATA_ATTR: true,
  })
}

/** 可执行按钮 data-action 委托：点击 button[data-action] 时回调（债务顾问的还款计划/设为优先等动作） */
export default function AiHtml({ html, style, onAction }: {
  html: string
  style?: CSSProperties
  onAction?: (action: string) => void
}) {
  return (
    <div
      style={{
        fontSize: 13.5, lineHeight: 1.7, color: '#374151',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        ...style,
      }}
      onClick={(e) => {
        if (!onAction) return
        const t = (e.target as HTMLElement).closest('button[data-action]')
        if (t) {
          e.preventDefault()
          onAction(t.getAttribute('data-action') ?? '')
        }
      }}
      dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}
    />
  )
}

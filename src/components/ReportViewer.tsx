// oxlint-disable react/only-export-components -- 导出 downloadHtml/printHtml 工具与展示组件同文件（既定设计）
// ==================== HTML 报告展示组件 ====================
// 预览卡片（内嵌 iframe srcdoc 渲染完整报告）+ 全屏模态 + 下载/打印。

import { useState } from 'react'

/** 把报告 HTML 下载为 .html 文件 */
export function downloadHtml(html: string, filename: string) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.html') ? filename : `${filename}.html`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 打印报告：写入隐藏 iframe 后调用其 print（打印预览只含报告内容） */
export function printHtml(html: string) {
  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(iframe)
  const doc = iframe.contentDocument
  if (!doc) return
  doc.open()
  doc.write(html)
  doc.close()
  iframe.contentWindow?.focus()
  setTimeout(() => {
    iframe.contentWindow?.print()
    setTimeout(() => iframe.remove(), 1000)
  }, 400)
}

const VIEWER_CSS: React.CSSProperties = {
  fontFamily: 'var(--font-stack)',
  fontSize: 12,
  fontWeight: 600,
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid #C0C4C4',
  background: 'rgba(255,255,255,0.95)',
  color: '#111111',
  cursor: 'pointer',
  boxShadow: '0 1px 4px rgba(15,23,42,0.1)',
}

function ViewerBtn({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={VIEWER_CSS}>
      {children}
    </button>
  )
}

/** 全屏查看模态：顶部 下载/打印/关闭 + 完整报告 iframe */
function FullscreenViewer({ html, filename, onClose }: { html: string; filename: string; onClose: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 999, background: '#D8DADA', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 16px', borderBottom: '1px solid #C0C4C4', background: '#E4E6E6', flexShrink: 0,
      }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111111' }}>📄 财务分析报告</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <ViewerBtn onClick={() => downloadHtml(html, filename)}>⬇ 下载HTML</ViewerBtn>
          <ViewerBtn onClick={() => printHtml(html)}>🖨 打印</ViewerBtn>
          <ViewerBtn onClick={onClose}>✕ 关闭</ViewerBtn>
        </div>
      </div>
      <iframe srcDoc={html} title="完整报告" style={{ flex: 1, width: '100%', border: 'none', background: '#E4E6E6' }} />
    </div>
  )
}

/**
 * 报告预览卡片：内嵌可滚动的完整报告 + 右上角 [全屏/下载/打印] 按钮。
 * 点击全屏 → 打开全屏模态（顶部同样有下载/打印/关闭）。
 */
export default function ReportPreview({ html, filename }: { html: string; filename: string }) {
  const [fullscreen, setFullscreen] = useState(false)
  return (
    <div style={{ position: 'relative', borderRadius: 14, overflow: 'hidden', border: '1px solid #C0C4C4', background: '#E4E6E6' }}>
      <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 3, display: 'flex', gap: 6 }}>
        <ViewerBtn onClick={() => setFullscreen(true)}>⛶ 全屏查看</ViewerBtn>
        <ViewerBtn onClick={() => downloadHtml(html, filename)}>⬇ 下载HTML</ViewerBtn>
        <ViewerBtn onClick={() => printHtml(html)}>🖨 打印</ViewerBtn>
      </div>
      <iframe srcDoc={html} title="报告预览" style={{ width: '100%', height: 400, border: 'none', background: '#D8DADA' }} />
      {fullscreen && <FullscreenViewer html={html} filename={filename} onClose={() => setFullscreen(false)} />}
    </div>
  )
}

// oxlint-disable react/only-export-components -- 命令式 API openWarnings 与弹窗组件同文件（既定设计）
import { useSyncExternalStore } from 'react'
import type { Warning } from '../utils/warningEngine'

// ==================== Promise 式全局预警弹窗 ====================

let current: { warnings: Warning[]; cancelLabel: string } | null = null
let resolver: ((ok: boolean) => void) | null = null
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach(l => l())
}
function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
function getSnapshot(): { warnings: Warning[]; cancelLabel: string } | null {
  return current
}

/** 弹出预警确认框，返回 Promise<boolean>：true=我还是要记 / false=取消 */
export function openWarnings(warnings: Warning[], cancelLabel = '先不记了'): Promise<boolean> {
  return new Promise(resolve => {
    current = { warnings, cancelLabel }
    resolver = resolve
    emit()
  })
}

function respond(ok: boolean) {
  const r = resolver
  current = null
  resolver = null
  emit()
  r?.(ok)
}

// ==================== 弹窗组件（挂载在 App 根部） ====================

export default function WarningModalHost() {
  const state = useSyncExternalStore(subscribe, getSnapshot)
  if (!state) return null
  const { warnings, cancelLabel } = state

  return (
    <div
      onClick={() => respond(false)}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 300,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 400, background: '#D8DADA', borderRadius: 16,
          boxShadow: 'var(--shadow-lg)', padding: 24,
        }}
      >
        {/* 标题：琥珀警示图标 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <span style={{
            width: 40, height: 40, borderRadius: '50%', background: '#FFFBEB',
            border: '1px solid #FDE68A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0,
          }}>
            ⚠️
          </span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111111' }}>保存前提醒</div>
            <div style={{ fontSize: 12, color: '#A0A4A4', marginTop: 1 }}>先别急着下单，看看这几点</div>
          </div>
        </div>

        {/* 预警列表 */}
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {warnings.map((w, i) => (
            <div key={`${w.type}-${i}`} style={{
              display: 'flex', gap: 10, alignItems: 'flex-start',
              background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 10, padding: '10px 12px',
            }}>
              <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>{w.icon}</span>
              <span style={{ fontSize: 13.5, color: '#78350F', lineHeight: 1.6 }}>{w.message}</span>
            </div>
          ))}
        </div>

        {/* 按钮 */}
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button onClick={() => respond(false)}
            style={{
              flex: 1, padding: '11px 0', borderRadius: 10, border: '1px solid #C0C4C4',
              background: '#D8DADA', color: '#888888', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-stack)',
            }}>
            {cancelLabel}
          </button>
          <button onClick={() => respond(true)}
            style={{
              flex: 1, padding: '11px 0', borderRadius: 10, border: 'none',
              background: '#0040FF', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-stack)',
              boxShadow: '0 4px 12px rgba(0,64,255,0.3)',
            }}>
            我还是要记
          </button>
        </div>
      </div>
    </div>
  )
}

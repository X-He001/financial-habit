// ==================== 主动提醒横幅（AI 主动找你） ====================
// 监听 dashboard-refresh / impulse-saved，调用 checkProactiveAlerts() 展示：
// - 洞察卡（连续3晚购物 / 储蓄达标 / 债务下降 / 画像规律）
// （30天购买回访已由首页顶部"待反馈"区块统一展示）

import { useEffect, useState, useCallback } from 'react'
import { checkProactiveAlerts } from '../agent/proactive'
import { acknowledgeInsight } from '../db/crud'
import type { ProactiveAlert } from '../agent/proactive'

const TYPE_STYLE: Partial<Record<ProactiveAlert['kind'], { border: string; bg: string; title: string }>> = {
  insight: { border: '#C7D2FE', bg: '#EEF2FF', title: '洞察' },
}

export default function ProactiveBanner() {
  const [alerts, setAlerts] = useState<ProactiveAlert[]>([])
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  const check = useCallback(async () => {
    try {
      const list = await checkProactiveAlerts()
      setAlerts(list)
    } catch {
      // 数据库未就绪等场景静默
    }
  }, [])

  useEffect(() => {
    void check()
    const h1 = () => void check()
    window.addEventListener('dashboard-refresh', h1)
    window.addEventListener('impulse-saved', h1)
    return () => {
      window.removeEventListener('dashboard-refresh', h1)
      window.removeEventListener('impulse-saved', h1)
    }
  }, [check])

  if (alerts.length === 0) return null

  // 30 天购买反馈已合并到首页顶部"待反馈"区块统一展示，这里只保留洞察类提醒
  const list = alerts.filter(a => a.kind !== 'feedback')
  if (list.length === 0) return null

  async function dismiss(a: ProactiveAlert) {
    if (a.insightId) await acknowledgeInsight(a.insightId)
    setHidden(prev => new Set(prev).add(a.id))
    window.dispatchEvent(new CustomEvent('dashboard-refresh'))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
      {list
        .filter(a => !hidden.has(a.id))
        .map(a => {
          const s = TYPE_STYLE[a.kind] ?? { border: '#C7D2FE', bg: '#EEF2FF', title: '洞察' }
          return (
            <div key={a.id} style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              background: s.bg, border: `1px solid ${s.border}`, borderRadius: 12, padding: '10px 14px',
            }}>
              <span style={{ fontSize: 16, lineHeight: '22px' }}>{a.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111111', lineHeight: 1.5 }}>{a.message}</div>
                <div style={{ fontSize: 12, color: '#888888', marginTop: 3, lineHeight: 1.6 }}>{a.evidence}</div>
              </div>
              <button onClick={() => void dismiss(a)}
                style={{ background: 'none', border: 'none', color: '#A0A4A4', fontSize: 13, cursor: 'pointer', flexShrink: 0 }}>
                ✕
              </button>
            </div>
          )
        })}
    </div>
  )
}

import { useState } from 'react'
import { addWishlistItem } from '../db/crud'

/** 按金额分档冷静期 */
function coolingDaysForPrice(priceMinor: number): number {
  if (priceMinor < 100_00) return 1       // <100元 → 24h
  if (priceMinor < 500_00) return 3       // 100-500元 → 72h
  if (priceMinor < 2000_00) return 7      // 500-2000元 → 7天
  return 30                                // >2000元 → 30天
}

function coolingLabel(days: number): string {
  if (days === 1) return '24 小时'
  if (days === 30) return '30 天'
  return `${days} 天`
}

export interface AddWishlistModalProps {
  open: boolean
  onClose: () => void
  onSaved?: () => void
}

export default function AddWishlistModal({ open, onClose, onSaved }: AddWishlistModalProps) {
  const [name, setName] = useState('')
  const [priceText, setPriceText] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const priceMinor = (() => {
    const n = parseFloat(priceText)
    if (isNaN(n) || n <= 0) return 0
    return Math.round(n * 100)
  })()

  const coolingDays = coolingDaysForPrice(priceMinor)
  const valid = name.trim().length > 0 && priceMinor > 0

  async function handleSave() {
    if (!valid || saving) return
    setSaving(true)
    try {
      const now = new Date()
      await addWishlistItem({
        name: name.trim(),
        priceMinor,
        addedAt: now.toISOString(),
        coolingDays,
        coolingEndsAt: new Date(now.getTime() + coolingDays * 86_400_000).toISOString(),
        status: 'cooling',
        aiAnalysis: null,
        finalPriceMinor: null,
        boughtAt: null,
      })
      window.dispatchEvent(new CustomEvent('dashboard-refresh'))
      setName('')
      setPriceText('')
      setNote('')
      onClose()
      onSaved?.()
    } finally {
      setSaving(false)
    }
  }

  function handleClose() {
    if (saving) return
    setName('')
    setPriceText('')
    setNote('')
    onClose()
  }

  if (!open) return null

  return (
    <div
      onClick={handleClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(17,24,39,0.45)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: 20,
        backdropFilter: 'blur(2px)',
      }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#D8DADA', borderRadius: 16, padding: 24,
          maxWidth: 400, width: '100%',
          boxShadow: 'var(--shadow-lg)',
          animation: 'fadeInUp 0.25s ease both',
        }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: '#111111', marginBottom: 4 }}>
          ＋ 添加欲望
        </div>
        <div style={{ fontSize: 13, color: '#888888', marginBottom: 20 }}>
          想买的先写下来，冷静后再决定
        </div>

        {/* 名称 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>
            名称 <span style={{ color: '#D73333' }}>*</span>
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 机械键盘、降噪耳机"
            autoFocus
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 10,
              border: '1px solid #C0C4C4', fontSize: 14, color: '#111111',
              outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box',
            }}
          />
        </div>

        {/* 价格 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>
            价格 <span style={{ color: '#D73333' }}>*</span>
          </div>
          <div style={{ position: 'relative' }}>
            <span style={{
              position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
              fontSize: 15, color: '#A0A4A4', fontWeight: 500,
            }}>¥</span>
            <input
              type="text" inputMode="decimal"
              value={priceText}
              onChange={(e) => {
                const v = e.target.value
                if (/^\d*\.?\d{0,2}$/.test(v) || v === '') setPriceText(v)
              }}
              placeholder="0.00"
              style={{
                width: '100%', padding: '10px 12px 10px 30px', borderRadius: 10,
                border: '1px solid #C0C4C4', fontSize: 18, fontWeight: 600,
                color: '#111111', fontVariantNumeric: 'tabular-nums',
                outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box',
              }}
            />
          </div>
          {/* 冷静期提示 */}
          {priceMinor > 0 && (
            <div style={{
              marginTop: 8, padding: '8px 12px', borderRadius: 8,
              background: '#EEF2FF', border: '1px solid #C7D2FE',
              fontSize: 12.5, color: '#0040FF', lineHeight: 1.6,
            }}>
              🧊 该商品将进入 <b>{coolingLabel(coolingDays)}</b> 冷静期
              （按金额分档：&lt;100元 / 100-500 / 500-2000 / &gt;2000元）
            </div>
          )}
        </div>

        {/* 备注/链接 */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>
            备注/链接 <span style={{ color: '#A0A4A4', fontWeight: 400 }}>（可选）</span>
          </div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="如 京东链接、颜色规格"
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 10,
              border: '1px solid #C0C4C4', fontSize: 13.5, color: '#111111',
              outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box',
            }}
          />
        </div>

        {/* 按钮 */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={handleClose}
            style={{
              flex: 1, padding: '11px 0', borderRadius: 12,
              border: '1px solid #C0C4C4', background: '#D8DADA',
              color: '#888888', fontSize: 14, fontWeight: 500,
              cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-stack)',
            }}>
            取消
          </button>
          <button onClick={() => void handleSave()}
            disabled={!valid || saving}
            style={{
              flex: 1, padding: '11px 0', borderRadius: 12,
              border: 'none', background: valid && !saving ? '#0040FF' : '#C7D2FE',
              color: '#fff', fontSize: 14, fontWeight: 600,
              cursor: valid && !saving ? 'pointer' : 'not-allowed',
              fontFamily: 'var(--font-stack)',
            }}>
            {saving ? '保存中…' : '✓ 加入清单'}
          </button>
        </div>
      </div>
    </div>
  )
}
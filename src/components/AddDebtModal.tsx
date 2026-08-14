import { useState } from 'react'
import { recordNewDebt } from '../debt/operations'
import type { CreditPlatform } from '../types'

const PLATFORMS: CreditPlatform[] = ['花呗', '京东白条', '抖音月付', '拼多多先用后付', '信用卡', '其他']

function todayStr(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export interface AddDebtModalProps {
  open: boolean
  onClose: () => void
  onSaved?: () => void
}

export default function AddDebtModal({ open, onClose, onSaved }: AddDebtModalProps) {
  const [platform, setPlatform] = useState<CreditPlatform>('花呗')
  const [amountText, setAmountText] = useState('')
  const [use, setUse] = useState('')
  const [feeText, setFeeText] = useState('')
  const [nextDueDate, setNextDueDate] = useState(todayStr(30))
  const [monthlyText, setMonthlyText] = useState('')
  const [saving, setSaving] = useState(false)

  const amountMinor = (() => {
    const n = parseFloat(amountText)
    if (isNaN(n) || n <= 0) return 0
    return Math.round(n * 100)
  })()
  const feeRate = (() => {
    const n = parseFloat(feeText)
    if (isNaN(n) || n < 0) return 0
    return n
  })()
  const monthlyPayMinor = (() => {
    const n = parseFloat(monthlyText)
    if (isNaN(n) || n <= 0) return 0
    return Math.round(n * 100)
  })()

  const valid = amountMinor > 0 && !!nextDueDate

  async function handleSave() {
    if (!valid || saving) return
    setSaving(true)
    try {
      await recordNewDebt({
        platform,
        amountMinor,
        use: use.trim(),
        feeRate,
        nextDueDate,
        monthlyPayMinor,
      })
      window.dispatchEvent(new CustomEvent('dashboard-refresh'))
      setAmountText('')
      setUse('')
      setFeeText('')
      setMonthlyText('')
      onClose()
      onSaved?.()
    } finally {
      setSaving(false)
    }
  }

  function handleClose() {
    if (saving) return
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
          maxWidth: 400, width: '100%', maxHeight: '88vh', overflowY: 'auto',
          boxShadow: 'var(--shadow-lg)',
          animation: 'fadeInUp 0.25s ease both',
        }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: '#111111', marginBottom: 4 }}>
          ＋ 记负债
        </div>
        <div style={{ fontSize: 13, color: '#888888', marginBottom: 20 }}>
          借来的每一分钱都有成本，先记下来再慢慢还
        </div>

        {/* 平台 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>
            平台 <span style={{ color: '#D73333' }}>*</span>
          </div>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value as CreditPlatform)}
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 10,
              border: '1px solid #C0C4C4', fontSize: 14, color: '#111111',
              outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box',
              background: '#D8DADA',
            }}>
            {PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        {/* 金额 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>
            金额 <span style={{ color: '#D73333' }}>*</span>
          </div>
          <div style={{ position: 'relative' }}>
            <span style={{
              position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
              fontSize: 15, color: '#A0A4A4', fontWeight: 500,
            }}>¥</span>
            <input
              value={amountText}
              onChange={(e) => {
                const v = e.target.value
                if (/^\d*\.?\d{0,2}$/.test(v) || v === '') setAmountText(v)
              }}
              inputMode="decimal" placeholder="0.00"
              autoFocus
              style={{
                width: '100%', padding: '10px 12px 10px 30px', borderRadius: 10,
                border: '1px solid #C0C4C4', fontSize: 18, fontWeight: 600,
                color: '#111111', fontVariantNumeric: 'tabular-nums',
                outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box',
              }}
            />
          </div>
        </div>

        {/* 用途/商家 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>
            用途/商家 <span style={{ color: '#A0A4A4', fontWeight: 400 }}>（可选）</span>
          </div>
          <input
            value={use}
            onChange={(e) => setUse(e.target.value)}
            placeholder="如 iPhone、Switch、医院挂号"
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 10,
              border: '1px solid #C0C4C4', fontSize: 13.5, color: '#111111',
              outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box',
            }}
          />
        </div>

        {/* 利率 XIRR */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>
            利率（XIRR，%） <span style={{ color: '#A0A4A4', fontWeight: 400 }}>（可选，默认 0）</span>
          </div>
          <input
            value={feeText}
            onChange={(e) => {
              const v = e.target.value
              if (/^\d*\.?\d{0,2}$/.test(v) || v === '') setFeeText(v)
            }}
            inputMode="decimal" placeholder="如 18"
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 10,
              border: '1px solid #C0C4C4', fontSize: 13.5, color: '#111111',
              outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box',
            }}
          />
        </div>

        {/* 下次还款日 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>
            下次还款日 <span style={{ color: '#D73333' }}>*</span>
          </div>
          <input
            type="date"
            value={nextDueDate}
            onChange={(e) => setNextDueDate(e.target.value)}
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 10,
              border: '1px solid #C0C4C4', fontSize: 13.5, color: '#111111',
              outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box',
              background: '#D8DADA',
            }}
          />
        </div>

        {/* 月还款 */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>
            月还款 <span style={{ color: '#A0A4A4', fontWeight: 400 }}>（可选）</span>
          </div>
          <input
            value={monthlyText}
            onChange={(e) => {
              const v = e.target.value
              if (/^\d*\.?\d{0,2}$/.test(v) || v === '') setMonthlyText(v)
            }}
            inputMode="decimal" placeholder="如 300"
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 10,
              border: '1px solid #C0C4C4', fontSize: 13.5, color: '#111111',
              outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box',
            }}
          />
        </div>

        {/* 提示 */}
        <div style={{
          marginBottom: 18, padding: '10px 12px', borderRadius: 10,
          background: '#EEF2FF', border: '1px solid #C7D2FE',
          fontSize: 12.5, color: '#0040FF', lineHeight: 1.7,
        }}>
          {amountMinor > 0
            ? `将记入「${platform}」待还 ¥${(amountMinor / 100).toFixed(2)}，并同步一条消费记录`
            : '同平台已存在会自动累加待还，否则自动创建负债账户'}
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
            {saving ? '保存中…' : '✓ 记下负债'}
          </button>
        </div>
      </div>
    </div>
  )
}

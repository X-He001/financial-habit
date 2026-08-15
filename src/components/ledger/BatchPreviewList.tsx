import { useState, useEffect } from 'react'
import type { Category } from '../../types'
import { getAllCategories } from '../../db/crud'
import { LEDGER_CATEGORIES, LEDGER_PAYMENTS } from '../../api/deepseek'
import { saveBatchItems } from '../../utils/batchImport'
import type { BatchItem } from '../../utils/batchImport'

interface Props {
  items: BatchItem[]
  onChange: (items: BatchItem[]) => void
  /** 保存成功后回调（父组件刷新交易列表） */
  onSaved: () => void
  /** 列表标题，默认「账单 · 识别出 N 条」 */
  title?: string
  /** 「取消/重新开始」按钮文案与回调（可选，不传则不显示） */
  resetLabel?: string
  onReset?: () => void
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid #C0C4C4',
  fontSize: 13, fontFamily: 'var(--font-stack)', outline: 'none', color: '#111111',
  background: '#FAFBFC', boxSizing: 'border-box', fontVariantNumeric: 'tabular-nums',
}

/**
 * 多记录批量预览列表（截图识别 / 文件导入 / 语音记账共用）：
 * 每行可编辑日期/金额/商家/分类/支付方式/备注，可勾选、删除；底部全选 + 批量保存。
 */
export default function BatchPreviewList({ items, onChange, onSaved, title, resetLabel, onReset }: Props) {
  const [categories, setCategories] = useState<Category[]>([])
  const [saving, setSaving] = useState(false)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void getAllCategories().then(setCategories) }, [])

  // 分类下拉：系统 7 分类 + 用户自定义（去重）
  const catOptions = [...LEDGER_CATEGORIES, ...categories.map((c) => c.name)]
    .filter((v, idx, arr) => arr.indexOf(v) === idx)

  function updateItem(uid: string, patch: Partial<BatchItem>) {
    setOkMsg(null)
    onChange(items.map((it) => (it.uid === uid ? { ...it, ...patch } : it)))
  }

  function toggleItem(uid: string) {
    onChange(items.map((it) => (it.uid === uid ? { ...it, checked: !it.checked } : it)))
  }

  function removeItem(uid: string) {
    onChange(items.filter((it) => it.uid !== uid))
  }

  const allChecked = items.length > 0 && items.every((it) => it.checked)
  const selectedCount = items.filter((it) => it.checked).length

  async function handleSave() {
    if (saving || selectedCount === 0) return
    setSaving(true)
    setError(null)
    setOkMsg(null)
    try {
      const res = await saveBatchItems(items.filter((it) => it.checked))
      setOkMsg(`✅ 成功保存 ${res.saved} 条${res.failed > 0 ? `，${res.failed} 条失败` : ''}`)
      window.dispatchEvent(new CustomEvent('dashboard-refresh'))
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#111111' }}>
          {title ?? '账单'} · 识别出 <b style={{ color: '#0040FF' }}>{items.length}</b> 条
        </div>
        {onReset && (
          <button onClick={onReset} style={{ fontSize: 12, color: '#A0A4A4', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
            {resetLabel ?? '取消，重新开始'}
          </button>
        )}
      </div>

      <div style={{ border: '1px solid #C0C4C4', borderRadius: 14, overflow: 'hidden' }}>
        {items.map((it, i) => (
          <div key={it.uid} style={{
            padding: '10px 12px',
            borderBottom: i < items.length - 1 ? '1px solid #E4E6E6' : 'none',
            background: it.checked ? '#FFFFFF' : '#E4E6E6',
            opacity: it.checked ? 1 : 0.55,
          }}>
            {/* 行1：勾选 + 商家 + 金额 + 删除 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <input type="checkbox" checked={it.checked} onChange={() => toggleItem(it.uid)}
                style={{ width: 16, height: 16, accentColor: '#0040FF', flexShrink: 0 }} />
              <div style={{ fontSize: 11, color: '#A0A4A4', flexShrink: 0 }}>
                {i + 1}. {it.txType === 'income' ? '收入' : '支出'}
              </div>
              <input value={it.merchant} placeholder="商家名称"
                onChange={(e) => updateItem(it.uid, { merchant: e.target.value })}
                style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
              <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                <span style={{ fontSize: 13, color: '#888888', marginRight: 4 }}>¥</span>
                <input value={it.amount ? String(it.amount) : ''} placeholder="0.00" inputMode="decimal"
                  onChange={(e) => {
                    const v = e.target.value
                    if (/^\d*\.?\d{0,2}$/.test(v) || v === '') updateItem(it.uid, { amount: parseFloat(v) || 0 })
                  }}
                  style={{ ...inputStyle, width: 84, textAlign: 'right', fontWeight: 600 }} />
              </div>
              <button onClick={() => removeItem(it.uid)} title="删除这条"
                style={{ background: 'none', border: 'none', color: '#A0A4A4', fontSize: 15, cursor: 'pointer', padding: '2px 4px', fontFamily: 'var(--font-stack)', flexShrink: 0 }}>
                ✕
              </button>
            </div>
            {/* 行2：日期 + 分类 + 支付 + 备注 */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input type="date" value={it.time}
                onChange={(e) => updateItem(it.uid, { time: e.target.value })}
                style={{ ...inputStyle, width: 148 }} />
              <select value={it.category} onChange={(e) => updateItem(it.uid, { category: e.target.value })}
                style={{ ...inputStyle, width: 104, background: '#D8DADA' }}>
                {catOptions.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={it.paymentMethod} onChange={(e) => updateItem(it.uid, { paymentMethod: e.target.value })}
                style={{ ...inputStyle, width: 104, background: '#D8DADA' }}>
                {LEDGER_PAYMENTS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <input value={it.note} placeholder="备注（可选）"
                onChange={(e) => updateItem(it.uid, { note: e.target.value })}
                style={{ ...inputStyle, flex: 1, minWidth: 120 }} />
            </div>
          </div>
        ))}
      </div>

      {/* 全选 + 批量保存 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
          <input type="checkbox" checked={allChecked}
            onChange={() => onChange(items.map((it) => ({ ...it, checked: !allChecked })))}
            style={{ width: 16, height: 16, accentColor: '#0040FF' }} />
          全选
        </label>
        <button onClick={handleSave} disabled={saving || selectedCount === 0}
          style={{
            flex: 1, padding: '12px 0', fontFamily: 'var(--font-stack)',
            background: selectedCount === 0 ? '#C7D2FE' : '#0040FF', color: '#fff', border: 'none',
            borderRadius: 12, fontSize: 14, fontWeight: 600,
            cursor: selectedCount === 0 ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1,
          }}>
          {saving ? '⏳ 正在保存…' : `📥 批量保存（${selectedCount} 条）`}
        </button>
      </div>

      {error && (
        <div style={{ marginTop: 10, padding: '10px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, fontSize: 13, color: '#B91C1C', textAlign: 'left' }}>
          ⚠️ {error}
        </div>
      )}
      {okMsg && (
        <div style={{ marginTop: 10, padding: '10px 16px', background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 10, fontSize: 13, color: '#065F46', textAlign: 'left' }}>
          {okMsg}
        </div>
      )}

      <div style={{ marginTop: 8, fontSize: 12, color: '#A0A4A4', textAlign: 'center', lineHeight: 1.7 }}>
        保存前可修改每条的日期、金额、商家、分类与支付方式；勾选状态决定哪些条目入库
      </div>
    </div>
  )
}

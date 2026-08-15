import { useState, useEffect, useRef } from 'react'
import type { Category } from '../../types'
import { getAllCategories } from '../../db/crud'
import { LEDGER_CATEGORIES, LEDGER_PAYMENTS } from '../../api/deepseek'
import { parseImportFile, saveBatchItems } from '../../utils/batchImport'
import type { BatchItem } from '../../utils/batchImport'

interface Props {
  /** 保存成功后回调（父组件刷新交易列表） */
  onSaved: () => void
}

const STEPS = [
  '上传账单文件：Excel（.xlsx/.xls）、PDF 账单、或交易截图（.png/.jpg/.jpeg）',
  '自动解析 + AI 识别：一份文件里不管有 1 条还是 20 条记录，都会全部提取出来',
  '确认无误后批量保存，自动计算每条记录的冲动指数',
]

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid #C0C4C4',
  fontSize: 13, fontFamily: 'var(--font-stack)', outline: 'none', color: '#111111',
  background: '#FAFBFC', boxSizing: 'border-box', fontVariantNumeric: 'tabular-nums',
}

export default function BatchImportTab({ onSaved }: Props) {
  const [items, setItems] = useState<BatchItem[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [stage, setStage] = useState<{ label: string; percent: number | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [categories, setCategories] = useState<Category[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { void getAllCategories().then(setCategories) }, [])

  // 分类下拉：系统 7 分类 + 用户自定义（去重）
  const catOptions = [...LEDGER_CATEGORIES, ...categories.map((c) => c.name)]
    .filter((v, idx, arr) => arr.indexOf(v) === idx)

  function handleFile(file: File) {
    if (busy || saving) return
    setError(null)
    setOkMsg(null)
    setItems(null)
    setFileName(file.name)
    setBusy(true)
    setStage({ label: '开始解析…', percent: 0 })
    void parseImportFile(file, (label, percent) => setStage({ label, percent }))
      .then((list) => {
        if (list.length === 0) {
          setError('没有从文件里识别到交易记录，请确认文件内容或换一张更清晰的截图')
          setFileName('')
        } else {
          setItems(list)
        }
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : '解析失败，请重试')
        setFileName('')
      })
      .finally(() => {
        setBusy(false)
        setStage(null)
      })
  }

  function updateItem(uid: string, patch: Partial<BatchItem>) {
    setItems((prev) => prev && prev.map((it) => (it.uid === uid ? { ...it, ...patch } : it)))
  }

  function toggleItem(uid: string) {
    setItems((prev) => prev && prev.map((it) => (it.uid === uid ? { ...it, checked: !it.checked } : it)))
  }

  function removeItem(uid: string) {
    setItems((prev) => prev && prev.filter((it) => it.uid !== uid))
  }

  const allChecked = items ? items.length > 0 && items.every((it) => it.checked) : false
  const selectedCount = items ? items.filter((it) => it.checked).length : 0

  async function handleSave() {
    if (!items || saving || selectedCount === 0) return
    setSaving(true)
    setError(null)
    setOkMsg(null)
    try {
      const selected = items.filter((it) => it.checked)
      const res = await saveBatchItems(selected)
      setOkMsg(`✅ 成功保存 ${res.saved} 条${res.failed > 0 ? `，${res.failed} 条失败` : ''}`)
      window.dispatchEvent(new CustomEvent('dashboard-refresh'))
      onSaved()
      setItems(null)
      setFileName('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  function resetAll() {
    if (busy || saving) return
    setItems(null)
    setFileName('')
    setError(null)
    setOkMsg(null)
  }

  return (
    <div style={{ padding: '4px 0' }}>
      {/* 说明步骤 */}
      <div style={{ marginBottom: 16, padding: '12px 16px', background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#3730A3', marginBottom: 6 }}>📦 批量导入账单</div>
        {STEPS.map((s, i) => (
          <div key={s} style={{ fontSize: 12, color: '#0040FF', lineHeight: 2 }}>
            <b>{i + 1}.</b> {s}
          </div>
        ))}
        <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 6, lineHeight: 1.7 }}>
          支持一份文件含多条记录；单文件 ≤10MB；图片优先用视觉模型直接识别（纯文本模型会先本地 OCR 再让 AI 整理，首次使用需联网下载识别模型）。
        </div>
      </div>

      {/* 上传区 */}
      {!items && (
        <div
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const f = e.dataTransfer.files?.[0]
            if (f) handleFile(f)
          }}
          style={{
            border: dragOver ? '2px dashed #0040FF' : '2px dashed #A0A4A4',
            background: dragOver ? '#EEF2FF' : '#FAFBFC',
            borderRadius: 16, padding: '34px 20px', textAlign: 'center', cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}>
          <div style={{ fontSize: 30, marginBottom: 8 }}>📂</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#0040FF', marginBottom: 4 }}>
            {dragOver ? '松手开始解析' : '把账单文件拖到这里'}
          </div>
          <div style={{ fontSize: 12, color: '#A0A4A4' }}>或点击选择文件 · 支持 Excel / PDF / 截图</div>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls,.pdf,.png,.jpg,.jpeg,image/png,image/jpeg"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleFile(f)
          e.target.value = ''
        }}
      />

      {/* 解析进度 */}
      {busy && stage && (
        <div style={{ marginTop: 16, padding: '14px 16px', background: '#FAFBFC', border: '1px solid #C0C4C4', borderRadius: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 15 }}>⏳</span>
            <span style={{ fontSize: 13, color: '#111111', fontWeight: 500 }}>{stage.label}</span>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: '#E4E6E6', overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 999, background: '#0040FF',
              width: stage.percent === null ? '30%' : `${Math.max(4, stage.percent)}%`,
              transition: 'width 0.3s ease',
              ...(stage.percent === null ? { animation: 'progressPulse 1.2s ease-in-out infinite' } : {}),
            }} />
          </div>
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div style={{ marginTop: 14, padding: '12px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, fontSize: 13, color: '#B91C1C', textAlign: 'left' }}>
          ⚠️ {error}
        </div>
      )}

      {/* 保存成功提示 */}
      {okMsg && (
        <div style={{ marginTop: 14, padding: '12px 16px', background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 10, fontSize: 13, color: '#065F46', textAlign: 'left' }}>
          {okMsg}
        </div>
      )}

      {/* 预览列表 */}
      {items && items.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111111' }}>
              {fileName || '账单'} · 识别出 <b style={{ color: '#0040FF' }}>{items.length}</b> 条
            </div>
            <button onClick={resetAll} style={{ fontSize: 12, color: '#A0A4A4', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
              取消，重新选文件
            </button>
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
                onChange={() => setItems((prev) => prev && prev.map((it) => ({ ...it, checked: !allChecked })))}
                style={{ width: 16, height: 16, accentColor: '#0040FF' }} />
              全选
            </label>
            <button onClick={handleSave} disabled={saving || selectedCount === 0} className="btn-primary"
              style={{
                flex: 1, padding: '12px 0', fontFamily: 'var(--font-stack)',
                background: selectedCount === 0 ? '#C7D2FE' : '#0040FF', color: '#fff', border: 'none',
                borderRadius: 12, fontSize: 14, fontWeight: 600,
                cursor: selectedCount === 0 ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1,
              }}>
              {saving ? '⏳ 正在保存…' : `📥 批量保存（${selectedCount} 条）`}
            </button>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: '#A0A4A4', textAlign: 'center', lineHeight: 1.7 }}>
            保存前可修改每条的日期、金额、商家、分类与支付方式；勾选状态决定哪些条目入库
          </div>
        </div>
      )}
    </div>
  )
}

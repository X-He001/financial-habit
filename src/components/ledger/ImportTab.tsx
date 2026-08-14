import { useState, useRef } from 'react'
import { getAllCategories } from '../../db/crud'
import type { Category } from '../../types'
import { parseCsvText, importRows, type ParsedImportRow } from '../../utils/csvImporter'

// 待确认行：在解析结果基础上附加勾选状态（勾选 = 导入，取消勾选 = 跳过）
interface ConfirmRow extends ParsedImportRow {
  checked: boolean
}

const STEPS = [
  '去支付宝 / 微信 → 「我的」→「账单」',
  '点击右上角「导出流水」→ 选时间范围',
  '把文件发到电脑，然后拖进下面的区域',
]

function fmtYuan(minor: number): string {
  return (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 尝试按 UTF-8 读取；若出现替换符（乱码），回退到 GBK 解码（支付宝/微信导出常见编码）。
 */
function readCsvText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.onload = () => {
      const buf = reader.result as ArrayBuffer
      const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf)
      if (!utf8.includes('\uFFFD')) {
        resolve(utf8)
        return
      }
      try {
        resolve(new TextDecoder('gbk').decode(buf))
      } catch {
        resolve(utf8)
      }
    }
    reader.readAsArrayBuffer(file)
  })
}

export default function ImportTab() {
  const [dragOver, setDragOver] = useState(false)
  const [rows, setRows] = useState<ConfirmRow[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [categories, setCategories] = useState<Category[]>([])
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError('请选择 .csv 文件（支付宝 / 微信导出的账单）')
      return
    }
    setError(null)
    setResult(null)
    setFileName(file.name)
    try {
      const text = await readCsvText(file)
      const parsed = parseCsvText(text)
      if (parsed.length === 0) {
        setError('没解析到有效记录。请确认导出的账单包含「交易时间」「金额」列，且是已支付成功的记录')
        setRows(null)
        return
      }
      const cats = await getAllCategories()
      setCategories(cats)
      setRows(parsed.map((r) => ({ ...r, checked: true })))
    } catch (e) {
      setError(e instanceof Error ? e.message : '解析失败，请重试')
      setRows(null)
    }
  }

  function toggleRow(idx: number) {
    setRows((prev) => prev && prev.map((r, i) => (i === idx ? { ...r, checked: !r.checked } : r)))
  }

  function removeRow(idx: number) {
    setRows((prev) => prev && prev.filter((_, i) => i !== idx))
  }

  function setCategory(idx: number, category: string) {
    setRows((prev) => prev && prev.map((r, i) => (i === idx ? { ...r, category } : r)))
  }

  async function handleImport() {
    if (!rows) return
    const selected = rows.filter((r) => r.checked)
    if (selected.length === 0) return
    setImporting(true)
    setError(null)
    try {
      const res = await importRows(selected)
      setResult({ imported: res.imported, skipped: res.skipped })
      // 触发首页 / 报告数据刷新
      window.dispatchEvent(new CustomEvent('dashboard-refresh'))
      setRows(null)
      setFileName('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败，请重试')
    } finally {
      setImporting(false)
    }
  }

  const selectedCount = rows ? rows.filter((r) => r.checked).length : 0

  return (
    <div style={{ padding: '4px 0' }}>
      {/* 说明步骤 */}
      <div style={{ marginBottom: 16, padding: '12px 16px', background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#3730A3', marginBottom: 6 }}>📥 怎么导出账单？</div>
        {STEPS.map((s, i) => (
          <div key={s} style={{ fontSize: 12, color: '#0040FF', lineHeight: 2 }}>
            <b>{i + 1}.</b> {s}
          </div>
        ))}
      </div>

      {/* 拖拽区 / 选择文件 */}
      {!rows && (
        <>
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const f = e.dataTransfer.files?.[0]
              if (f) void handleFile(f)
            }}
            style={{
              border: dragOver ? '2px dashed #0040FF' : '2px dashed #A0A4A4',
              background: dragOver ? '#EEF2FF' : '#FAFBFC',
              borderRadius: 16, padding: '36px 20px', textAlign: 'center', cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📂</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#0040FF', marginBottom: 4 }}>
              {dragOver ? '松手导入' : '把账单 CSV 拖到这里'}
            </div>
            <div style={{ fontSize: 12, color: '#A0A4A4' }}>或点击选择文件（仅 .csv）</div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleFile(f)
              e.target.value = ''
            }}
          />
        </>
      )}

      {/* 错误提示 */}
      {error && (
        <div style={{ marginTop: 14, padding: '12px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, fontSize: 13, color: '#B91C1C', textAlign: 'left' }}>
          ⚠️ {error}
        </div>
      )}

      {/* 导入完成提示 */}
      {result && (
        <div style={{
          marginTop: 14, padding: '12px 16px', background: '#ECFDF5', border: '1px solid #A7F3D0',
          borderRadius: 10, fontSize: 13, color: '#065F46', textAlign: 'left',
        }}>
          ✅ 成功导入 <b>{result.imported}</b> 条{result.skipped > 0 ? `，跳过重复 <b>${result.skipped}</b> 条` : ''}
        </div>
      )}

      {/* 待确认列表 */}
      {rows && rows.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111111' }}>
              {fileName} · 待确认 <b style={{ color: '#0040FF' }}>{rows.length}</b> 条
            </div>
            <button onClick={() => setRows(null)} style={{ fontSize: 12, color: '#A0A4A4', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
              取消，重新选文件
            </button>
          </div>

          <div style={{ border: '1px solid #C0C4C4', borderRadius: 14, overflow: 'hidden' }}>
            {rows.map((r, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                borderBottom: i < rows.length - 1 ? '1px solid #E4E6E6' : 'none',
                background: r.checked ? '#fff' : '#E4E6E6', opacity: r.checked ? 1 : 0.55,
              }}>
                <input type="checkbox" checked={r.checked} onChange={() => toggleRow(i)} style={{ width: 16, height: 16, accentColor: '#0040FF' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: '#A0A4A4' }}>
                    {fmtDate(r.time)} · {r.txType === 'income' ? '收入' : '支出'} · {r.paymentMethod}
                  </div>
                  <div style={{ fontSize: 13, color: '#111111', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.merchant}
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: r.txType === 'income' ? '#10B981' : '#111111', whiteSpace: 'nowrap' }}>
                  {r.txType === 'income' ? '+' : '−'}{fmtYuan(r.amountMinor)}
                </div>
                <select
                  value={r.category}
                  onChange={(e) => setCategory(i, e.target.value)}
                  style={{
                    fontSize: 12, padding: '5px 6px', borderRadius: 8, border: '1px solid #C0C4C4',
                    outline: 'none', background: '#FAFBFC', color: '#374151', fontFamily: 'var(--font-stack)', maxWidth: 90,
                  }}>
                  {['餐饮', '购物', '日用百货', '娱乐', '交通', '虚拟消费', '其他', ...categories.map((c) => c.name)]
                    .filter((v, idx, arr) => arr.indexOf(v) === idx)
                    .map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <button onClick={() => removeRow(i)} title="删除这条" style={{
                  background: 'none', border: 'none', color: '#A0A4A4', fontSize: 15, cursor: 'pointer', padding: '2px 4px', fontFamily: 'var(--font-stack)',
                }}>✕</button>
              </div>
            ))}
          </div>

          {/* 批量导入 */}
          <button onClick={handleImport} disabled={importing || selectedCount === 0} className="btn-primary"
            style={{
              width: '100%', padding: '12px 0', marginTop: 14, fontFamily: 'var(--font-stack)',
              background: selectedCount === 0 ? '#C7D2FE' : '#0040FF', color: '#fff', border: 'none',
              borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: selectedCount === 0 ? 'not-allowed' : 'pointer',
            }}>
            {importing ? '⏳ 正在导入…' : `📥 批量导入（${selectedCount} 条）`}
          </button>
          <div style={{ marginTop: 8, fontSize: 12, color: '#A0A4A4', textAlign: 'center' }}>
            导入时自动跳过已导入过的记录（按交易单号去重），并自动计算每条记录的冲动指数
          </div>
        </div>
      )}
    </div>
  )
}

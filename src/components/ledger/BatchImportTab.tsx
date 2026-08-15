import { useState, useRef } from 'react'
import { parseImportFile } from '../../utils/batchImport'
import type { BatchItem } from '../../utils/batchImport'
import BatchPreviewList from './BatchPreviewList'

interface Props {
  /** 保存成功后回调（父组件刷新交易列表） */
  onSaved: () => void
}

const STEPS = [
  '上传账单文件：Excel（.xlsx/.xls）、PDF 账单、或交易截图（.png/.jpg/.jpeg）',
  '自动解析 + AI 识别：一份文件里不管有 1 条还是 20 条记录，都会全部提取出来',
  '确认无误后批量保存，自动计算每条记录的冲动指数',
]

export default function BatchImportTab({ onSaved }: Props) {
  const [items, setItems] = useState<BatchItem[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<{ label: string; percent: number | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  function handleFile(file: File) {
    if (busy) return
    setError(null)
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

  function resetAll() {
    if (busy) return
    setItems(null)
    setFileName('')
    setError(null)
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

      {/* 预览列表（复用共享组件） */}
      {items && items.length > 0 && (
        <BatchPreviewList
          items={items}
          onChange={setItems}
          onSaved={onSaved}
          title={fileName || '账单'}
          resetLabel="取消，重新选文件"
          onReset={resetAll}
        />
      )}
    </div>
  )
}

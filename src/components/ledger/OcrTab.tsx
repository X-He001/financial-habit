import { useState, useEffect, useRef } from 'react'
import type { ParsedLedgerItem } from '../../api/deepseek'
import { analyzeReceiptImage, VisionUnsupportedError } from '../../api/deepseek'
import { saveParsedLedger } from '../../utils/ledgerSave'
import EditableItemForm from './EditableItemForm'

interface ImageItem { id: string; url: string }
interface Props { onSaved: () => void }

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export default function OcrTab({ onSaved }: Props) {
  const [images, setImages] = useState<ImageItem[]>([])
  const [results, setResults] = useState<ParsedLedgerItem[] | null>(null)
  const [recognizing, setRecognizing] = useState(false)
  const [savingAll, setSavingAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function addFiles(files: File[]) {
    const imgs = files.filter((f) => f.type.startsWith('image/'))
    if (imgs.length === 0) return
    const urls = await Promise.all(imgs.map(fileToDataUrl))
    setImages((prev) => [...prev, ...urls.map((url, i) => ({ id: `${Date.now()}-${i}`, url }))])
  }

  // 全局 Ctrl+V 粘贴截图
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const f = items[i].getAsFile()
          if (f) files.push(f)
        }
      }
      if (files.length > 0) {
        e.preventDefault()
        void addFiles(files)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  function removeImage(idx: number) {
    setImages((prev) => prev.filter((_, i) => i !== idx))
  }

  async function handleRecognize() {
    if (images.length === 0 || recognizing) return
    setRecognizing(true); setError(null); setUnsupported(false)
    try {
      const parsed = await analyzeReceiptImage(images.map((i) => i.url))
      setResults(parsed)
    } catch (e) {
      if (e instanceof VisionUnsupportedError) {
        // 降级：模型不支持图片，转成空卡片让用户手动填
        setUnsupported(true)
        setResults(images.map(() => ({
          amount: 0, category: '餐饮', merchant: '', time: todayStr(), paymentMethod: '微信', note: '',
        })))
      } else if (e instanceof Error && e.message === 'NO_API_KEY') {
        setError('请先到设置页配置 API Key')
      } else {
        setError('识别失败，请检查网络或 API Key，也可以手动填写')
      }
    } finally {
      setRecognizing(false)
    }
  }

  function updateItem(idx: number, v: ParsedLedgerItem) {
    setResults((prev) => prev ? prev.map((it, i) => (i === idx ? v : it)) : prev)
  }

  async function handleSaveOne(idx: number) {
    const item = results?.[idx]
    if (!item) return
    const ok = await saveParsedLedger(item, 'ocr')
    if (!ok) return
    setResults((prev) => prev ? prev.filter((_, i) => i !== idx) : prev)
    setImages((prev) => prev.filter((_, i) => i !== idx))
    onSaved()
  }

  async function handleSaveAll() {
    if (!results || savingAll) return
    setSavingAll(true)
    const keep: ParsedLedgerItem[] = []
    for (let i = 0; i < results.length; i++) {
      const ok = await saveParsedLedger(results[i], 'ocr')
      if (!ok) keep.push(results[i])
    }
    if (keep.length > 0) {
      setResults(keep)
      setImages((prev) => prev.slice(0, keep.length))
    } else {
      setResults(null)
      setImages([])
    }
    setSavingAll(false)
    onSaved()
  }

  return (
    <div>
      {/* 拖拽/点击上传区 */}
      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); void addFiles(Array.from(e.dataTransfer.files)) }}
        style={{
          border: `2px dashed ${dragOver ? '#0040FF' : '#A0A4A4'}`,
          background: dragOver ? '#EEF2FF' : '#FAFBFC',
          borderRadius: 16, padding: '36px 16px', textAlign: 'center', cursor: 'pointer',
          transition: 'all 0.2s ease',
        }}>
        <div style={{ fontSize: 28, marginBottom: 8 }}>📷</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#111111' }}>点击上传 或 拖入支付截图（支持多张）</div>
        <div style={{ fontSize: 12, color: '#A0A4A4', marginTop: 6 }}>支持 Ctrl+V 直接粘贴剪贴板里的截图</div>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden
          onChange={(e) => { if (e.target.files) void addFiles(Array.from(e.target.files)); e.target.value = '' }} />
      </div>

      {/* 已上传缩略图 + 开始识别 */}
      {images.length > 0 && !results && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {images.map((img, idx) => (
              <div key={img.id} style={{ position: 'relative' }}>
                <img src={img.url} alt="截图" style={{ width: 76, height: 76, objectFit: 'cover', borderRadius: 10, border: '1px solid #C0C4C4', display: 'block' }} />
                <button onClick={() => removeImage(idx)} title="删除"
                  style={{
                    position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%',
                    background: '#D73333', color: '#fff', border: 'none', cursor: 'pointer',
                    fontSize: 12, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>×</button>
              </div>
            ))}
          </div>
          <button onClick={handleRecognize} disabled={recognizing} className="btn-primary"
            style={{ width: '100%', padding: '11px 0', marginTop: 14, opacity: recognizing ? 0.6 : 1 }}>
            {recognizing ? '⏳ 识别中，请稍候…' : '🚀 开始识别'}
          </button>
        </div>
      )}

      {/* 错误/降级提示 */}
      {error && (
        <div style={{ marginTop: 14, padding: '12px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, fontSize: 13, color: '#B91C1C' }}>
          ⚠️ {error}
        </div>
      )}
      {unsupported && (
        <div style={{ marginTop: 14, padding: '12px 14px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 10, fontSize: 13, color: '#92400E' }}>
          ℹ️ 当前模型不支持图片识别。已为你生成空白卡片，请对照右侧原图手动填写金额等信息。
        </div>
      )}

      {/* 识别确认卡片 */}
      {results && (
        <div style={{ marginTop: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#111111' }}>识别确认（{results.length} 张）</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setResults(null); setUnsupported(false) }}
                style={{ padding: '7px 14px', borderRadius: 10, border: '1px solid #C0C4C4', background: '#D8DADA', fontSize: 13, color: '#888888', cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
                重新识别
              </button>
              <button onClick={handleSaveAll} disabled={savingAll} className="btn-primary"
                style={{ padding: '7px 18px', opacity: savingAll ? 0.6 : 1 }}>
                {savingAll ? '保存中…' : '全部保存'}
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {results.map((item, idx) => (
              <div key={idx} style={{ background: '#D8DADA', border: '1px solid #C0C4C4', borderRadius: 16, padding: 16, boxShadow: '0 1px 2px rgba(16,24,40,0.04), 0 4px 16px rgba(16,24,40,0.04)' }}>
                {/* 卡片头：序号 + 原图缩略图（点击放大） */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#888888' }}>第 {idx + 1} 张</span>
                  <img
                    src={images[idx]?.url}
                    alt="原图"
                    onClick={() => setPreview(images[idx]?.url ?? null)}
                    title="点击放大查看原图"
                    style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 8, border: '1px solid #C0C4C4', cursor: 'zoom-in' }}
                  />
                </div>
                <EditableItemForm
                  value={item}
                  onChange={(v) => updateItem(idx, v)}
                  onSave={() => handleSaveOne(idx)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 原图放大查看 */}
      {preview && (
        <div onClick={() => setPreview(null)} style={{
          position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(15,23,42,0.75)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out', padding: 24,
        }}>
          <img src={preview} alt="原图放大" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 12, boxShadow: 'var(--shadow-lg)' }} />
        </div>
      )}
    </div>
  )
}

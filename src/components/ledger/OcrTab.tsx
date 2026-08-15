import { useState, useEffect, useRef } from 'react'
import type { ParsedLedgerItem } from '../../api/deepseek'
import { analyzeReceiptImagesMulti, VisionUnsupportedError } from '../../api/deepseek'
import { visionItemsToBatch } from '../../utils/batchImport'
import type { BatchItem } from '../../utils/batchImport'
import BatchPreviewList from './BatchPreviewList'

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
  const [items, setItems] = useState<BatchItem[] | null>(null)
  const [recognizing, setRecognizing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)
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
      // 每张图里可能有多条账单（如微信/支付宝账单列表页），全部提取后合并
      const parsed: ParsedLedgerItem[] = []
      for (const img of images) {
        parsed.push(...await analyzeReceiptImagesMulti([img.url]))
      }
      if (parsed.length === 0) throw new Error('EMPTY_RESULT')
      setItems(visionItemsToBatch(parsed))
    } catch (e) {
      if (e instanceof VisionUnsupportedError) {
        // 降级：模型不支持图片，生成空白条目让用户手动填
        setUnsupported(true)
        setItems(visionItemsToBatch(images.map(() => ({
          amount: 0, category: '餐饮', merchant: '', time: todayStr(), paymentMethod: '微信', note: '',
        }))))
      } else if (e instanceof Error && e.message === 'NO_API_KEY') {
        setError('请先到设置页配置 API Key')
      } else if (e instanceof Error && e.message === 'EMPTY_RESULT') {
        setError('没有从截图里识别到交易记录，请换一张更清晰的截图')
      } else {
        setError('识别失败，请检查网络或 API Key，也可以手动填写')
      }
    } finally {
      setRecognizing(false)
    }
  }

  function resetAll() {
    setItems(null)
    setUnsupported(false)
    setImages([])
    setError(null)
  }

  return (
    <div>
      {/* 拖拽/点击上传区（识别出结果后收起） */}
      {!items && (
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
          <div style={{ fontSize: 14, fontWeight: 600, color: '#111111' }}>点击上传 或 拖入支付截图（支持多张，每张可含多条账单）</div>
          <div style={{ fontSize: 12, color: '#A0A4A4', marginTop: 6 }}>支持 Ctrl+V 直接粘贴剪贴板里的截图</div>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden
            onChange={(e) => { if (e.target.files) void addFiles(Array.from(e.target.files)); e.target.value = '' }} />
        </div>
      )}

      {/* 已上传缩略图 + 开始识别 */}
      {images.length > 0 && !items && (
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
          ℹ️ 当前模型不支持图片识别。已生成空白条目，请在下方填写每条的金额、商家等信息后保存。
        </div>
      )}

      {/* 识别结果：多记录批量预览 */}
      {items && items.length > 0 && (
        <BatchPreviewList
          items={items}
          onChange={setItems}
          onSaved={onSaved}
          title="截图识别"
          resetLabel="取消，重新上传"
          onReset={resetAll}
        />
      )}
    </div>
  )
}

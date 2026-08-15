import { useState, useRef } from 'react'
import { parseVoiceTextMulti, hasApiKey } from '../../api/deepseek'
import { visionItemsToBatch } from '../../utils/batchImport'
import type { BatchItem } from '../../utils/batchImport'
import BatchPreviewList from './BatchPreviewList'

interface Props { onSaved: () => void }

const EXAMPLES = [
  '「今天花了38块买奶茶，65块吃火锅，12块坐地铁」',
  '「中午吃饭花了35块」',
  '「拼多多买了89块的手机壳，先用后付」',
  '「昨天打车28」',
]

export default function VoiceTab({ onSaved }: Props) {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [recognizing, setRecognizing] = useState(false)
  const [items, setItems] = useState<BatchItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<{ stop: () => void } | null>(null)
  const supported = !!(window as unknown as Record<string, unknown>).SpeechRecognition
    || !!(window as unknown as Record<string, unknown>).webkitSpeechRecognition

  function toggleListen() {
    if (listening) {
      recRef.current?.stop()
      return
    }
    const W = window as unknown as Record<string, new () => { start: () => void; stop: () => void; lang: string; continuous: boolean; interimResults: boolean; onresult: unknown; onend: unknown; onerror: unknown }>
    const SR = W.SpeechRecognition || W.webkitSpeechRecognition
    if (!SR) return
    const rec = new SR()
    recRef.current = rec
    rec.lang = 'zh-CN'
    rec.interimResults = true
    rec.continuous = true
    // 结果与错误回调通过赋值闭包变量绑定
    const raw = rec as unknown as {
      onresult: ((e: { results: { [key: number]: { [key: number]: { transcript: string } } } }) => void) | null
      onend: (() => void) | null
      onerror: ((e: { error: string }) => void) | null
    }
    raw.onresult = (e) => {
      let t = ''
      for (let i = 0; i < Object.keys(e.results).length; i++) t += e.results[i][0].transcript
      setTranscript(t)
    }
    raw.onend = () => setListening(false)
    raw.onerror = (e) => {
      if (e.error === 'not-allowed') setError('麦克风权限被拒绝，请在浏览器地址栏允许使用麦克风')
      else setError('语音识别出错，请重试')
      setListening(false)
    }
    rec.start()
    setListening(true)
    setError(null)
  }

  async function handleParse() {
    const text = transcript.trim()
    if (!text || recognizing) return
    const ok = await hasApiKey()
    if (!ok) { setError('请先到设置页配置 API Key'); return }
    setRecognizing(true); setError(null); setItems(null)
    try {
      const list = await parseVoiceTextMulti(text)
      if (list.length === 0) {
        setError('没有识别到有效的消费记录，请确认描述里有金额（如「38块买奶茶」）')
        return
      }
      setItems(visionItemsToBatch(list))
    } catch (e) {
      if (e instanceof Error && e.message === 'NO_API_KEY') setError('请先到设置页配置 API Key')
      else setError('解析失败，请检查网络或 API Key，也可以手动修改文字后重试')
    } finally {
      setRecognizing(false)
    }
  }

  function resetAll() {
    setItems(null)
    setTranscript('')
    setError(null)
  }

  return (
    <div style={{ textAlign: 'center' }}>
      {/* 麦克风按钮 */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 0 8px' }}>
        <button
          onClick={toggleListen}
          disabled={!supported}
          className={listening ? 'mic-btn mic-listening' : 'mic-btn'}
          title={supported ? '点击开始/停止说话' : '当前浏览器不支持语音识别'}
          style={{
            width: 88, height: 88, borderRadius: '50%', cursor: supported ? 'pointer' : 'not-allowed',
            background: listening ? '#0040FF' : '#0040FF', border: 'none', outline: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-stack)',
            transition: 'background 0.2s ease',
          }}>
          <span style={{ fontSize: 34, lineHeight: 1 }}>🎤</span>
        </button>
        <div style={{ fontSize: 13, color: listening ? '#0040FF' : '#A0A4A4', marginTop: 12, fontWeight: listening ? 600 : 400 }}>
          {!supported ? '当前浏览器不支持语音识别（请用 Chrome / Edge）' : listening ? '正在聆听…' : '点击开始说话'}
        </div>
      </div>

      {/* 语音转文字 */}
      {supported && (
        <textarea
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="识别出的文字会显示在这里，识别不准可以直接修改…"
          rows={3}
          style={{
            width: '100%', padding: 12, borderRadius: 12, border: '1px solid #C0C4C4',
            fontSize: 14, color: '#888888', outline: 'none', fontFamily: 'var(--font-stack)',
            boxSizing: 'border-box', background: '#FAFBFC', resize: 'vertical', marginTop: 16,
          }}
        />
      )}

      {/* 解析按钮 */}
      {supported && (
        <button onClick={handleParse} disabled={!transcript.trim() || recognizing} className="btn-primary"
          style={{ width: '100%', padding: '11px 0', marginTop: 12, opacity: !transcript.trim() || recognizing ? 0.5 : 1 }}>
          {recognizing ? '⏳ 解析中…' : '✨ 解析并记账'}
        </button>
      )}

      {/* 错误提示 */}
      {error && (
        <div style={{ marginTop: 14, padding: '12px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, fontSize: 13, color: '#B91C1C', textAlign: 'left' }}>
          ⚠️ {error}
        </div>
      )}

      {/* 例子 */}
      {!items && (
        <div style={{ marginTop: 16, fontSize: 12, color: '#A0A4A4', textAlign: 'left', lineHeight: 2 }}>
          可以说这些试试（一句话可以说多笔）：
          <div style={{ color: '#888888' }}>
            {EXAMPLES.map((s) => <div key={s}>· {s}</div>)}
          </div>
        </div>
      )}

      {/* 多记录预览列表 */}
      {items && items.length > 0 && (
        <BatchPreviewList
          items={items}
          onChange={setItems}
          onSaved={onSaved}
          title="语音识别"
          resetLabel="重新开始"
          onReset={resetAll}
        />
      )}
    </div>
  )
}

import { useState, useEffect } from 'react'
import { getMoodByDate, addMood, updateMood, deleteMood, getAllMoods } from '../db/crud'
import { MOOD_OPTIONS, negativeMoodStreak, type MoodOption } from '../utils/moodEngine'

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 连续负面情绪 ≥3 天的温和关怀（HTML 片段，Agent 口吻） */
function careHtml(streak: number, moodName: string): string {
  return `<div style="font-family:var(--font-stack);font-size:13px;line-height:1.8;color:#065F46;background:#ECFDF5;border:1px solid #A7F3D0;border-radius:12px;padding:12px 14px">
  <div style="font-weight:700;color:#047857;margin-bottom:4px">🤖 连续 ${streak} 天${moodName}，听我说两句</div>
  你已经连续 <strong>${streak}</strong> 天处于负面状态了。今天要不要试试做点别的？<br/>
  散步 20 分钟、把想买的东西先写进欲望清单、或找朋友聊两句——冲动消费解决不了情绪，但冷静可以。
</div>`
}

export default function MoodSelector({ compact = false }: { compact?: boolean }) {
  const [today, setToday] = useState<string | null>(null)
  const [streak, setStreak] = useState(0)
  const [streakMood, setStreakMood] = useState('')
  const [saving, setSaving] = useState(false)

  async function load() {
    const tk = todayStr()
    const [row, all] = await Promise.all([getMoodByDate(tk), getAllMoods()])
    setToday(row?.mood ?? null)
    const n = negativeMoodStreak(all)
    if (n >= 3 && row?.mood) {
      const opt = MOOD_OPTIONS.find(m => m.key === row.mood)
      setStreak(n)
      setStreakMood(opt?.label ?? '情绪不好')
    } else {
      setStreak(0)
      setStreakMood('')
    }
  }

  useEffect(() => { void load() }, [])

  async function pick(m: MoodOption) {
    if (saving) return
    setSaving(true)
    try {
      const tk = todayStr()
      const row = await getMoodByDate(tk)
      if (row) {
        if (row.mood === m.key) {
          await deleteMood(row.id)
        } else {
          await updateMood(row.id, { mood: m.key })
        }
      } else {
        await addMood({ date: tk, mood: m.key, note: '', createdAt: new Date().toISOString() })
      }
      await load()
      window.dispatchEvent(new CustomEvent('dashboard-refresh'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: '#A0A4A4', marginBottom: 8 }}>今日心情</div>
      <div style={{ display: 'flex', gap: compact ? 4 : 6 }}>
        {MOOD_OPTIONS.map(m => {
          const active = today === m.key
          return (
            <button key={m.key} onClick={() => void pick(m)} disabled={saving}
              title={m.label}
              style={{
                flex: 1, padding: '7px 0', borderRadius: 10, cursor: 'pointer',
                fontFamily: 'var(--font-stack)', fontSize: compact ? 17 : 20,
                transition: 'all 0.15s',
                border: active ? '1.5px solid #0040FF' : '1px solid #C0C4C4',
                background: active ? '#EEF2FF' : '#FAFBFC',
                transform: active ? 'scale(1.05)' : 'none',
                boxShadow: active ? '0 2px 8px rgba(0,64,255,0.2)' : 'none',
              }}>
              {m.emoji}
            </button>
          )
        })}
      </div>
      {today && (
        <div style={{ fontSize: 11, color: '#A0A4A4', marginTop: 6 }}>
          已记录：{MOOD_OPTIONS.find(m => m.key === today)?.emoji}
          {MOOD_OPTIONS.find(m => m.key === today)?.label}（再点一下可取消）
        </div>
      )}
      {streak >= 3 && (
        <div style={{ marginTop: 10 }} dangerouslySetInnerHTML={{ __html: careHtml(streak, streakMood) }} />
      )}
    </div>
  )
}

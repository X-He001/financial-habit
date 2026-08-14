import type { Mood, Transaction } from '../types'
import { isImpulsive } from './impulseEngine'

// ==================== 情绪定义 ====================

export interface MoodOption {
  key: Mood['mood']
  emoji: string
  label: string
  negative: boolean
}

export const MOOD_OPTIONS: MoodOption[] = [
  { key: 'happy', emoji: '😊', label: '开心', negative: false },
  { key: 'stressed', emoji: '😫', label: '压力大', negative: true },
  { key: 'bored', emoji: '🥱', label: '无聊', negative: true },
  { key: 'angry', emoji: '😠', label: '烦躁', negative: true },
  { key: 'calm', emoji: '😐', label: '平静', negative: false },
]

export const MOOD_LABEL: Record<string, string> = Object.fromEntries(
  MOOD_OPTIONS.map(m => [m.key, `${m.emoji}${m.label}`])
)

export function moodLabel(key: string): string {
  return MOOD_LABEL[key] ?? key
}

function isIncome(t: { txType?: string }): boolean { return t.txType === 'income' }
function isTransfer(t: { note?: string }): boolean { return t.note === '储蓄转入' }

function pad2(n: number): string { return String(n).padStart(2, '0') }
function dateKey(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }

// ==================== 统计 ====================

export interface PerMoodStat {
  /** 标记该情绪的天数 */
  days: number
  /** 有记账的天数（平均消费分母） */
  txDays: number
  /** 当日日均支出（分） */
  avgSpendMinor: number
  /** 冲动笔数 */
  impulseCount: number
  /** 冲动率（冲动笔数 / 有记账天数） */
  impulseRate: number
}

export interface MoodStats {
  perMood: Record<string, PerMoodStat>
  /** 压力大 vs 平静 的日均消费差 */
  stressedVsCalm: { stressedAvgMinor: number; calmAvgMinor: number; diffMinor: number; diffPct: number } | null
  /** 至少一个情绪记录 ≥2 天，才够数据分析 */
  enoughData: boolean
}

/**
 * 本地统计：各情绪标记天数 → 对应日子的日均消费 / 冲动笔数 / 冲动率。
 * 只统计"当天有情绪记录"的日子，跨天累计每笔支出与冲动。
 */
export function computeMoodStats(moods: Mood[], txs: Transaction[]): MoodStats {
  // 情绪 → 有记录的天集合
  const moodDays: Record<string, Set<string>> = {}
  for (const m of moods) {
    (moodDays[m.mood] ??= new Set()).add(m.date)
  }

  // 记录日 → 该日支出合计 / 冲动笔数 / 是否记账
  const daySpend = new Map<string, number>()
  const dayImpulse = new Map<string, number>()
  for (const t of txs) {
    if (isIncome(t) || isTransfer(t)) continue
    const dk = dateKey(new Date(t.time))
    daySpend.set(dk, (daySpend.get(dk) ?? 0) + t.amountMinor)
    if (isImpulsive(t.impulseLevel)) dayImpulse.set(dk, (dayImpulse.get(dk) ?? 0) + 1)
  }

  const perMood: Record<string, PerMoodStat> = {}
  for (const opt of MOOD_OPTIONS) {
    const days = moodDays[opt.key]
    if (!days || days.size === 0) continue
    let spend = 0
    let impulse = 0
    let txDays = 0
    for (const d of days) {
      const s = daySpend.get(d)
      if (s != null && s > 0) {
        spend += s
        txDays++
      }
      impulse += dayImpulse.get(d) ?? 0
    }
    perMood[opt.key] = {
      days: days.size,
      txDays,
      avgSpendMinor: txDays > 0 ? Math.round(spend / txDays) : 0,
      impulseCount: impulse,
      impulseRate: txDays > 0 ? Math.round((impulse / txDays) * 100) : 0,
    }
  }

  let stressedVsCalm: MoodStats['stressedVsCalm'] = null
  const stressed = perMood['stressed']
  const calm = perMood['calm']
  if (stressed && calm && stressed.txDays > 0 && calm.txDays > 0) {
    const diffMinor = stressed.avgSpendMinor - calm.avgSpendMinor
    const diffPct = calm.avgSpendMinor > 0
      ? Math.round((diffMinor / calm.avgSpendMinor) * 100)
      : 0
    stressedVsCalm = {
      stressedAvgMinor: stressed.avgSpendMinor,
      calmAvgMinor: calm.avgSpendMinor,
      diffMinor,
      diffPct,
    }
  }

  const enoughData = Object.values(perMood).some(p => p.days >= 2)
  return { perMood, stressedVsCalm, enoughData }
}

/** 最近 7 天情绪分布（供 buildContext / 周报） */
export function recentMoodDistribution(moods: Mood[], days = 7): Record<string, number> {
  const from = new Date()
  from.setDate(from.getDate() - (days - 1))
  const fromKey = dateKey(from)
  const dist: Record<string, number> = {}
  for (const m of moods) {
    if (m.date >= fromKey) dist[m.mood] = (dist[m.mood] ?? 0) + 1
  }
  return dist
}

/**
 * 连续负面情绪天数：从今天往前数，连续 N 天标记了负面情绪（压力大/无聊/烦躁）。
 * 用于"连续3天负面情绪 → Agent 温和关怀"。
 */
export function negativeMoodStreak(moods: Mood[], today = new Date()): number {
  const negative = new Set(MOOD_OPTIONS.filter(m => m.negative).map(m => m.key))
  const byDate = new Map(moods.map(m => [m.date, m.mood]))
  let streak = 0
  for (let back = 0; back < 30; back++) {
    const d = new Date(today)
    d.setDate(d.getDate() - back)
    const key = dateKey(d)
    const mood = byDate.get(key)
    if (mood && negative.has(mood)) streak++
    else break
  }
  return streak
}

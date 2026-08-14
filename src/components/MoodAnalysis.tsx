import { useState, useEffect } from 'react'
import { db } from '../db/database'
import type { Transaction } from '../types'
import { generateMoodInsight, hasApiKey, aiErrorMessage } from '../api/deepseek'
import { incrementAiCount } from '../utils/aiUsage'
import { computeMoodStats, MOOD_OPTIONS, moodLabel, type MoodStats } from '../utils/moodEngine'

function fmtYuan(minor: number): string {
  return '¥' + (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

/** AI 失败时的本地降级洞察（HTML，引用真实数字） */
function localInsightHtml(s: MoodStats): string {
  const blocks: string[] = []
  const sc = s.stressedVsCalm
  if (sc && sc.diffMinor !== 0) {
    const dir = sc.diffMinor > 0 ? '高' : '低'
    blocks.push(
      `<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:10px;padding:10px 12px;font-size:13px;color:#78350F;line-height:1.7">` +
      `<b style="color:#92400E">🔍 发现</b> 压力大的日子日均消费 ${fmtYuan(sc.stressedAvgMinor)}，比平静日（${fmtYuan(sc.calmAvgMinor)}）${dir} <b>${Math.abs(sc.diffPct)}%</b>。情绪起伏确实会传导到钱包上。</div>`
    )
  }
  const tips: string[] = []
  if (sc && sc.diffMinor > 0) {
    tips.push('压力大的时候先散步 20 分钟，再决定要不要买')
  }
  const bored = s.perMood['bored']
  if (bored && bored.avgSpendMinor > 0) {
    tips.push(`无聊的日子日均花 ${fmtYuan(bored.avgSpendMinor)}，给「想做清单」备点不花钱的选项`)
  }
  const stressed = s.perMood['stressed']
  if (stressed && stressed.impulseRate > 0) {
    tips.push(`压力大时冲动率 ${stressed.impulseRate}%，下单前先写进欲望清单冷静 24 小时`)
  }
  if (tips.length === 0) tips.push('把心情和记账连起来记录几天，就能看到你的情绪消费模式')
  blocks.push(
    `<div style="background:#ECFEFF;border:1px solid #A5F3FC;border-radius:10px;padding:10px 12px;font-size:13px;color:#164E63;line-height:1.7">` +
    `<b style="color:#155E75">💡 建议</b> ${tips.map(t => `<div>· ${t}</div>`).join('')}</div>`
  )
  return blocks.join('')
}

/** 报告页"情绪分析"区块：本地统计 + AI 洞察（引用真实数字） */
export default function MoodAnalysis({ mode = 'week' }: { mode?: 'week' | 'month' }) {
  const [stats, setStats] = useState<MoodStats | null>(null)
  const [insightHtml, setInsightHtml] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void load() }, [])

  async function load() {
    const [moods, txs] = await Promise.all([db.moods.toArray(), db.transactions.toArray()])
    setStats(computeMoodStats(moods, txs as Transaction[]))
  }

  async function handleAi() {
    if (!stats) return
    const ok = await hasApiKey()
    if (!ok) { setError('请先到设置页配置 API Key，才能生成 AI 洞察'); return }
    setLoading(true)
    setError(null)
    try {
      await incrementAiCount()
      const html = await generateMoodInsight({
        stats,
        period: mode === 'week' ? '本周' : '本月',
        perMood: Object.fromEntries(
          Object.entries(stats.perMood).map(([k, v]) => [moodLabel(k), { 天数: v.days, 日均消费: v.avgSpendMinor / 100, 冲动笔数: v.impulseCount, 冲动率: v.impulseRate + '%' }])
        ),
        stressedVsCalm: stats.stressedVsCalm
          ? {
              压力大日均: stats.stressedVsCalm.stressedAvgMinor / 100,
              平静日均: stats.stressedVsCalm.calmAvgMinor / 100,
              差值: stats.stressedVsCalm.diffMinor / 100,
              差百分比: stats.stressedVsCalm.diffPct + '%',
            }
          : null,
      })
      setInsightHtml(html)
    } catch (e) {
      setInsightHtml(localInsightHtml(stats))
      setError(`AI 生成失败（${aiErrorMessage(e)}），已展示本地计算结果`)
    } finally {
      setLoading(false)
    }
  }

  if (!stats) return null

  const rows = Object.entries(stats.perMood)
  if (!stats.enoughData || rows.length === 0) {
    return (
      <div className="card" style={{ padding: 24, marginBottom: 24 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#111111', marginBottom: 8 }}>😌 情绪-消费分析</div>
        <div style={{ fontSize: 13, color: '#A0A4A4', lineHeight: 1.8 }}>
          数据还不够，多记录几天心情（首页 → 记账天数卡下方"今日心情"）。
          <br />每个情绪至少记录 <b>2</b> 天，才能看出情绪和消费的关系。
        </div>
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: 24, marginBottom: 24 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: '#111111', marginBottom: 2 }}>😌 情绪-消费分析</div>
      <div style={{ fontSize: 12, color: '#A0A4A4', marginBottom: 14 }}>情绪记录 → 消费关联（统计期间：最近记录的所有心情日）</div>

      {/* 本地统计表 */}
      <div style={{ overflowX: 'auto', marginBottom: 14 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #C0C4C4', color: '#888888', fontSize: 12 }}>情绪</th>
              <th style={{ textAlign: 'right', padding: '8px 10px', borderBottom: '1px solid #C0C4C4', color: '#888888', fontSize: 12 }}>天数</th>
              <th style={{ textAlign: 'right', padding: '8px 10px', borderBottom: '1px solid #C0C4C4', color: '#888888', fontSize: 12 }}>日均消费</th>
              <th style={{ textAlign: 'right', padding: '8px 10px', borderBottom: '1px solid #C0C4C4', color: '#888888', fontSize: 12 }}>冲动笔数</th>
              <th style={{ textAlign: 'right', padding: '8px 10px', borderBottom: '1px solid #C0C4C4', color: '#888888', fontSize: 12 }}>冲动率</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, v]) => {
              const opt = MOOD_OPTIONS.find(m => m.key === k)
              const color = opt?.negative ? '#F43F5E' : '#10B981'
              return (
                <tr key={k}>
                  <td style={{ padding: '9px 10px', borderBottom: '1px solid #E4E6E6' }}>
                    {moodLabel(k)} {opt?.negative && <span style={{ fontSize: 11, color }}>负面</span>}
                  </td>
                  <td style={{ textAlign: 'right', padding: '9px 10px', borderBottom: '1px solid #E4E6E6', fontVariantNumeric: 'tabular-nums' }}>{v.days} 天</td>
                  <td style={{ textAlign: 'right', padding: '9px 10px', borderBottom: '1px solid #E4E6E6', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtYuan(v.avgSpendMinor)}</td>
                  <td style={{ textAlign: 'right', padding: '9px 10px', borderBottom: '1px solid #E4E6E6', fontVariantNumeric: 'tabular-nums' }}>{v.impulseCount} 笔</td>
                  <td style={{ textAlign: 'right', padding: '9px 10px', borderBottom: '1px solid #E4E6E6', color: v.impulseRate > 40 ? '#F43F5E' : '#374151', fontWeight: v.impulseRate > 40 ? 700 : 400, fontVariantNumeric: 'tabular-nums' }}>{v.impulseRate}%</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 压力大 vs 平静 对比 */}
      {stats.stressedVsCalm && (
        <div style={{
          padding: '12px 14px', borderRadius: 10, marginBottom: 14,
          background: stats.stressedVsCalm.diffMinor > 0 ? '#FEF2F2' : '#ECFDF5',
          border: `1px solid ${stats.stressedVsCalm.diffMinor > 0 ? '#FECACA' : '#A7F3D0'}`,
          fontSize: 13, lineHeight: 1.8,
        }}>
          <b style={{ color: '#111111' }}>对比：</b>
          压力大的日子日均消费 <b style={{ fontVariantNumeric: 'tabular-nums', color: stats.stressedVsCalm.diffMinor > 0 ? '#DC2626' : '#059669' }}>{fmtYuan(stats.stressedVsCalm.stressedAvgMinor)}</b>
          ，比平静日（{fmtYuan(stats.stressedVsCalm.calmAvgMinor)}）
          {stats.stressedVsCalm.diffPct >= 0 ? '高' : '低'} <b style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.abs(stats.stressedVsCalm.diffPct)}%</b>
        </div>
      )}

      {/* AI 洞察 */}
      {insightHtml ? (
        <div style={{ fontSize: 13 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#0040FF', marginBottom: 8, borderLeft: '3px solid #0040FF', paddingLeft: 8 }}>🧠 AI 洞察</div>
          <div dangerouslySetInnerHTML={{ __html: insightHtml }} />
        </div>
      ) : (
        <button onClick={() => void handleAi()} disabled={loading} className="btn-primary"
          style={{ padding: '9px 18px', opacity: loading ? 0.6 : 1, fontSize: 13 }}>
          {loading ? '⏳ AI 正在分析…' : '✨ 生成情绪洞察'}
        </button>
      )}
      {error && <div style={{ fontSize: 12, color: '#A0A4A4', marginTop: 8 }}>{error}</div>}
    </div>
  )
}

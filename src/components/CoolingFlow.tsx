// oxlint-disable react/only-export-components -- 命令式 API openCoolingFlow 与弹窗组件同文件（既定设计）
import { useEffect, useState, useSyncExternalStore } from 'react'
import { getSetting, setSetting } from '../db/crud'
import type { CoolingInfo } from '../utils/impulseEngine'
import { isImpulsive } from '../utils/impulseEngine'
import { generateCoolingAnalysis, COOLING_DEFAULT_QUESTIONS, type CoolingAnalysis } from '../api/deepseek'
import { db } from '../db/database'
import { InsightCard } from './RichMessage'

export type CoolingResult = 'wishlist' | 'buy' | 'cancel'

/** 当天冷静流程记录（存 settings 表 dailyCooling，供每日报告引用） */
export interface DailyCooling {
  date: string
  count: number
  /** 拦截金额（分）：选了"放清单 / 取消"的金额合计 */
  blockedMinor: number
  /** AI 心理拆解要点摘要（当天最后一次触发的） */
  insightSummary: string | null
}

/** AI 分析结果暂存，finish 时写进 dailyCooling 的 insightSummary */
let lastInsightSummary: string | null = null

// ==================== Promise 式全局冷静流程 ====================

let current: CoolingInfo | null = null
let resolver: ((r: CoolingResult) => void) | null = null
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach(l => l())
}
function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
function getSnapshot(): CoolingInfo | null {
  return current
}

/** 读改写当天冷静流程记录（自动按日期重置） */
async function updateDailyCooling(mutate: (r: DailyCooling) => DailyCooling): Promise<void> {
  const KEY = 'dailyCooling'
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  let rec: DailyCooling = { date: today, count: 0, blockedMinor: 0, insightSummary: null }
  const raw = await getSetting(KEY)
  try {
    if (typeof raw === 'string') rec = { ...rec, ...JSON.parse(raw) }
  } catch { /* 数据损坏则重置 */ }
  if (rec.date !== today) rec = { date: today, count: 0, blockedMinor: 0, insightSummary: null }
  await setSetting(KEY, JSON.stringify(mutate(rec)))
}

/** 统计当天冷静流程触发次数 */
async function recordCoolingTrigger() {
  await updateDailyCooling(r => ({ ...r, count: r.count + 1 }))
}

/**
 * 打开多步冷静流程（账单复盘 → 心理拆解 → 三个问题 → 结果）。
 * 返回 'wishlist'（放清单）| 'buy'（现在就买）| 'cancel'（中途关闭）。
 */
export function openCoolingFlow(info: CoolingInfo): Promise<CoolingResult> {
  void recordCoolingTrigger()
  return new Promise(resolve => {
    current = info
    resolver = resolve
    emit()
  })
}

function finish(r: CoolingResult) {
  const res = resolver
  const amt = current?.amountMinor ?? 0
  const summary = lastInsightSummary
  current = null
  resolver = null
  lastInsightSummary = null
  emit()
  // 选了"放清单 / 中途关闭"都算拦截，累加金额并记录拆解摘要
  if (r === 'wishlist' || r === 'cancel') {
    void updateDailyCooling(rec => {
      const next = { ...rec, blockedMinor: rec.blockedMinor + amt }
      if (summary) next.insightSummary = summary
      return next
    })
  }
  res?.(r)
}

// ==================== 文案模板（本地规则，不调 AI） ====================

function fmtYuan(minor: number): string {
  return (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

function buildTemplates(info: CoolingInfo): string[] {
  const list: string[] = []
  // 深夜时段
  if (info.isLateNight) {
    list.push('你正在用『未来的钱』买『现在的快乐』，这是典型的现时偏误——深夜人的自控力最弱')
  }
  // 先用后付 / 分期
  if (info.isDeferred) {
    const meals = Math.max(1, Math.ceil(info.amountMinor / 1500)) // 每顿 ¥15
    list.push(`先用后付把支付痛感延迟了，但钱终究要还。这笔 ¥${fmtYuan(info.amountMinor)} 相当于你 ${meals} 顿食堂的饭钱（按每顿¥15估算）`)
  }
  // 拼多多 / 抖音
  if (info.platform === '拼多多' || info.platform === '抖音') {
    list.push("这类平台的『限时折扣』利用的是稀缺效应，制造'错过就亏'的错觉——你不是省钱，是被算法带节奏")
  }
  // 当日多笔
  if (info.dayShoppingCount >= 2) {
    list.push('小额多次下单会弱化每笔的痛感，但加起来就是一笔大钱')
  }
  // 大额超均值
  if (info.overMedianTimes != null && info.overMedianTimes >= 2) {
    list.push(`这笔超出你同类消费平均的 ${info.overMedianTimes} 倍，大概率是冲动`)
  }
  // 预算紧张
  if (info.budgetTight) {
    list.push(`这笔之后，你本月剩余预算只剩 ¥${fmtYuan(info.budgetRemainingAfter)}`)
  }
  return list.slice(0, 3)
}

// ==================== AI 深度分析 facts（数字全部由本地代码计算） ====================

function slotOf(h: number): string {
  if (h < 6) return '凌晨'
  if (h < 12) return '上午'
  if (h < 18) return '下午'
  if (h < 22) return '晚上'
  return '深夜'
}

function yuan(minor: number): number {
  return Math.round((minor / 100) * 100) / 100
}

/**
 * 把冷静流程所需的真实数字拼成 facts：
 * 本笔交易（金额/分类/商家/支付方式/时段/冲动分数/命中维度）+
 * 今日购物累计（总金额/各平台明细/笔数）+
 * 用户画像（近30天该类支出、平均单笔、本月预算剩余、近30天冲动总次数）。
 */
async function buildCoolingFacts(info: CoolingInfo): Promise<object> {
  const allTxs = await db.transactions.toArray()
  const now = new Date()
  const DAY = 86_400_000
  const mk = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  // 今日各平台购物金额明细（元）
  const platformAmount: Record<string, number> = {}
  for (const t of info.todayShopTxs) {
    if (t.platform) platformAmount[t.platform] = (platformAmount[t.platform] || 0) + yuan(t.amountMinor)
  }

  // 用户画像：近30天该类支出 + 冲动总次数；本月已支出
  let catCount30 = 0
  let catTotal30 = 0
  let impulseCount30 = 0
  let monthExpense = 0
  for (const t of allTxs) {
    if ((t as { txType?: string }).txType === 'income') continue
    const d = new Date(t.time)
    const tTime = d.getTime()
    if (tTime > now.getTime()) continue
    if (now.getTime() - tTime <= 30 * DAY) {
      if (t.category === info.category) {
        catCount30++
        catTotal30 += t.amountMinor
      }
      if (isImpulsive(t.impulseLevel)) impulseCount30++
    }
    if (`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === mk) monthExpense += t.amountMinor
  }

  const budgetRaw = await getSetting('monthlyBudget')
  const budget = typeof budgetRaw === 'number' && budgetRaw > 0 ? budgetRaw : 1000_00

  const levelLabel = info.level === 'veryHigh' ? '高度' : info.level === 'high' ? '中度' : info.level === 'medium' ? '轻度' : '低'

  return {
    transaction: {
      merchant: info.merchant,
      amountYuan: yuan(info.amountMinor),
      category: info.category,
      paymentMethod: info.paymentMethod,
      platform: info.platform,
      timeSlot: slotOf(now.getHours()),
      impulseScore: info.score,
      impulseLevel: levelLabel,
      hitDimensions: info.reasons,
    },
    todayShopping: {
      totalYuan: yuan(info.totalMinor),
      count: info.dayShoppingCount,
      platformAmountYuan: Object.fromEntries(
        Object.entries(platformAmount).map(([k, v]) => [k, Math.round(v * 100) / 100])
      ),
    },
    profile: {
      category30Count: catCount30,
      category30TotalYuan: yuan(catTotal30),
      category30AvgYuan: catCount30 > 0 ? Math.round((catTotal30 / catCount30) * 100) / 100 : null,
      monthBudgetYuan: yuan(budget),
      monthSpentYuan: yuan(monthExpense),
      monthRemainingYuan: yuan(Math.max(0, budget - monthExpense)),
      impulse30Count: impulseCount30,
    },
  }
}

/** 解析 AI 拆解条目的类型前缀（"insight: xxx" 发现 / "tip: xxx" 建议），无前缀默认 insight */
function parseInsightKind(s: string): { kind: 'insight' | 'tip'; text: string } {
  const m = s.match(/^(insight|tip)[：:]\s*(.*)$/s)
  if (m) return { kind: m[1] as 'insight' | 'tip', text: m[2].trim() }
  return { kind: 'insight', text: s }
}

// ==================== 主组件 ====================

export default function CoolingFlowHost() {
  const info = useSyncExternalStore(subscribe, getSnapshot)
  if (!info) return null
  return <CoolingWizard info={info} onDone={finish} />
}

const phaseName = ['账单复盘', '心理拆解', '三个问题', '结果']

function CoolingWizard({ info, onDone }: { info: CoolingInfo; onDone: (r: CoolingResult) => void }) {
  // 0 复盘 / 1 拆解 / 2 Q1 / 3 Q2 / 4 Q3 / 5 结果
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<string[]>([])
  const [done, setDone] = useState<'wishlist' | 'buy'>('buy')
  // AI 深度分析（心理拆解 + 个性化三问）；加载中显示占位，失败/无 Key 降级本地模板
  const [analysis, setAnalysis] = useState<CoolingAnalysis | null>(null)
  const [aiLoading, setAiLoading] = useState(true)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const facts = await buildCoolingFacts(info)
      const result = await generateCoolingAnalysis(facts)
      if (!alive) return
      setAnalysis(result)
      setAiLoading(false)
      if (result && result.insights.length > 0) {
        lastInsightSummary = result.insights.slice(0, 2).map(s => parseInsightKind(s).text).join('；')
      }
    })()
    return () => { alive = false }
  }, [info])

  const templates = buildTemplates(info)
  const sortedTxs = [...info.todayShopTxs].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
  const overLine = info.totalMinor >= 200_00

  // 当前阶段（1-4，用于步骤圆点）
  const phaseIdx = step === 0 ? 0 : step === 1 ? 1 : step <= 4 ? 2 : 3

  // 三个问题：优先用 AI 生成的个性化三问，未配置 Key / 失败时降级默认三问
  const questions = analysis && analysis.questions.length >= 3 ? analysis.questions : COOLING_DEFAULT_QUESTIONS
  const qIndex = Math.min(2, Math.max(0, step - 2))
  const questionText = step >= 2 && step <= 4 ? questions[qIndex].question : ''
  const questionOptions = step >= 2 && step <= 4 ? questions[qIndex].options : []

  function chooseOption(opt: string) {
    const next = [...answers, opt]
    setAnswers(next)
    if (step === 4) {
      setDone(opt === '放清单' ? 'wishlist' : 'buy')
      setStep(5)
    } else {
      setStep(step + 1)
    }
  }

  const btnPrimary: React.CSSProperties = {
    flex: 1, padding: '11px 0', borderRadius: 10, border: 'none',
    background: '#0040FF', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'var(--font-stack)', boxShadow: '0 4px 12px rgba(0,64,255,0.3)',
  }

  return (
    <div
      onClick={() => onDone('cancel')}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 310,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        backdropFilter: 'blur(3px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 460, background: '#D8DADA', borderRadius: 16,
          boxShadow: 'var(--shadow-lg)', padding: '22px 24px', maxHeight: '90vh', overflowY: 'auto',
        }}
      >
        {/* 头部：标题 + 步骤指示器 + 关闭 */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span style={{
            width: 40, height: 40, borderRadius: '50%', background: '#EFF6FF',
            border: '1px solid #BFDBFE', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20, flexShrink: 0,
          }}>
            🧊
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111111' }}>先冷静一下</div>
            <div style={{ fontSize: 12, color: '#A0A4A4', marginTop: 1 }}>{phaseName[phaseIdx]}</div>
          </div>
          <button onClick={() => onDone('cancel')}
            style={{ border: 'none', background: 'transparent', fontSize: 18, color: '#A0A4A4', cursor: 'pointer', lineHeight: 1, padding: 4 }}>
            ✕
          </button>
        </div>

        {/* 步骤圆点 1/2/3/4 */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 14 }}>
          {[0, 1, 2, 3].map(i => (
            <div key={i} style={{
              width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700,
              background: i < phaseIdx ? '#0040FF' : i === phaseIdx ? '#EEF2FF' : '#E4E6E6',
              border: i === phaseIdx ? '1.5px solid #0040FF' : '1px solid #C0C4C4',
              color: i <= phaseIdx ? '#0040FF' : '#A0A4A4',
            }}>
              {i + 1}
            </div>
          ))}
        </div>

        {/* ===== 第1步 账单复盘 ===== */}
        {step === 0 && (
          <>
            <div style={{ textAlign: 'center', marginTop: 18 }}>
              <div style={{ fontSize: 12, color: '#A0A4A4' }}>今天购物已合计</div>
              <div style={{ fontSize: 40, fontWeight: 800, color: overLine ? '#DC2626' : '#F59E0B', lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' }}>
                ¥{fmtYuan(info.totalMinor)}
              </div>
              {overLine && (
                <div style={{ fontSize: 13, fontWeight: 600, color: '#DC2626', marginTop: 2 }}>已超过警戒线 ¥200</div>
              )}
            </div>

            {/* 触发原因横幅 */}
            {info.coolMessages.length > 0 && (
              <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {info.coolMessages.map((m, i) => (
                  <div key={i} style={{
                    background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 10, padding: '8px 12px',
                    fontSize: 12.5, color: '#78350F', lineHeight: 1.6,
                  }}>
                    ⚠️ {m}
                  </div>
                ))}
              </div>
            )}

            {/* 今日购物账单列表（浅灰背景） */}
            <div style={{ marginTop: 14, background: '#E4E6E6', borderRadius: 12, padding: '6px 4px' }}>
              {sortedTxs.map((t, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', padding: '9px 12px',
                  borderBottom: i < sortedTxs.length - 1 ? '1px solid #E4E6E6' : 'none',
                }}>
                  <span style={{
                    fontSize: 11, padding: '2px 7px', borderRadius: 5, background: t.platform ? '#EEF2FF' : '#E4E6E6',
                    color: t.platform ? '#0040FF' : '#888888', fontWeight: 600, marginRight: 8, flexShrink: 0,
                  }}>
                    {t.platform ?? '其他'}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.merchant}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#111111', fontVariantNumeric: 'tabular-nums' }}>
                    ¥{fmtYuan(t.amountMinor)}
                  </span>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button onClick={() => setStep(1)} style={btnPrimary}>继续</button>
            </div>
          </>
        )}

        {/* ===== 第2步 消费心理拆解 ===== */}
        {step === 1 && (
          <>
            <div style={{ fontSize: 13, color: '#888888', marginTop: 16, marginBottom: 10 }}>
              这笔消费背后，可能藏着这些心理机制：
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {aiLoading ? (
                <div style={{
                  background: '#FFFBEB', border: '1px dashed #FCD34D', borderRadius: 12,
                  padding: '16px 14px', fontSize: 13, color: '#B45309', textAlign: 'center', lineHeight: 1.8,
                }}>
                  <span style={{ display: 'inline-block', animation: 'coolingPulse 1.2s ease-in-out infinite' }}>🧠</span>
                  <div>AI 正在结合你的真实消费数据分析…</div>
                </div>
              ) : analysis && analysis.insights.length > 0 ? (
                analysis.insights.map((t, i) => {
                  const parsed = parseInsightKind(t)
                  return <InsightCard key={i} text={parsed.text} kind={parsed.kind} />
                })
              ) : (
                templates.map((t, i) => (
                  <div key={i} style={{
                    background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 12, padding: '12px 14px',
                    fontSize: 13, color: '#78350F', lineHeight: 1.8,
                  }}>
                    {t}
                  </div>
                ))
              )}
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button onClick={() => setStep(2)} style={btnPrimary}>继续</button>
            </div>
          </>
        )}

        {/* ===== 第3步 三个问题 ===== */}
        {step >= 2 && step <= 4 && (
          <>
            <div style={{
              marginTop: 18, fontSize: 17, fontWeight: 700, color: '#111111', textAlign: 'center',
              padding: '8px 4px', lineHeight: 1.5,
            }}>
              {questionText}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
              {questionOptions.map(opt => (
                <button key={opt} onClick={() => chooseOption(opt)}
                  style={{
                    padding: '12px 0', borderRadius: 12, border: '1px solid #C0C4C4', background: '#D8DADA',
                    fontSize: 14, fontWeight: 500, color: '#374151', cursor: 'pointer', fontFamily: 'var(--font-stack)',
                    transition: 'all 0.15s',
                  }}>
                  {opt}
                </button>
              ))}
            </div>
          </>
        )}

        {/* ===== 第4步 结果 ===== */}
        {step === 5 && (
          <>
            {done === 'wishlist' ? (
              <div style={{ textAlign: 'center', marginTop: 20 }}>
                <div style={{ fontSize: 40 }}>🧾</div>
                <div style={{ fontSize: 17, fontWeight: 700, color: '#111111', marginTop: 8 }}>
                  已放入欲望清单
                </div>
                <div style={{ fontSize: 13, color: '#888888', marginTop: 6 }}>
                  「{info.merchant} ¥{fmtYuan(info.amountMinor)}」
                </div>
                <div style={{
                  display: 'inline-block', marginTop: 10, background: '#EEF2FF', color: '#0040FF',
                  fontSize: 12.5, fontWeight: 600, borderRadius: 999, padding: '6px 14px',
                }}>
                  24 小时后回来确认
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', marginTop: 20 }}>
                <div style={{ fontSize: 40 }}>🛒</div>
                <div style={{ fontSize: 17, fontWeight: 700, color: '#111111', marginTop: 8 }}>
                  已记录这笔消费
                </div>
                <div style={{ fontSize: 13, color: '#888888', marginTop: 6 }}>
                  已在备注中标记「冷静后仍购买」
                </div>
              </div>
            )}

            {/* 回答回顾 */}
            {answers.length > 0 && (
              <div style={{ marginTop: 16, background: '#E4E6E6', borderRadius: 12, padding: '10px 14px' }}>
                {questions.map((q, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '4px 0', color: '#888888' }}>
                    <span style={{ marginRight: 8, minWidth: 0 }}>{q.question.replace(/[？?]/g, '')}</span>
                    <b style={{ color: '#111111', fontWeight: 600, flexShrink: 0 }}>{answers[i] ?? '—'}</b>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button onClick={() => onDone(done)} style={btnPrimary}>完成</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

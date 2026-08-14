// ========== 分类 ==========
export interface Category {
  id: string
  name: string
  icon: string
  color: string // 十六进制颜色，如 #0040FF
  isDefault: boolean // 默认分类不可删除
}

// ========== 交易记录 ==========
export interface Transaction {
  id: string // UUID
  amountMinor: number // 整数"分"，¥3.50 → 350
  category: string // 分类名称（匹配 categories 表）
  merchant: string
  time: string // ISO 时间
  txType: 'income' | 'expense' // 收入 / 支出
  paymentMethod: '微信' | '支付宝' | '银行卡' | '现金' | '先用后付' | '分期' | '花呗' | '信用支付' | '京东白条' | '抖音月付' | '拼多多先用后付' | '信用卡'
  source: 'manual' | 'ocr' | 'voice' | 'import'
  impulseScore: number // 冲动指数 0-100
  impulseLevel: 'low' | 'medium' | 'high' | 'veryHigh'
  isRevoked: boolean // 是否已撤销转储蓄
  revokedAt: string | null
  regretValue: boolean | null // 值/不值后悔标记
  regretAt: string | null
  importId: string | null // CSV 导入去重用
  note: string
  screenshot: string | null
  /** 资金来源（负债支付时为对应平台，普通支付标记现金/银行/微信/支付宝） */
  fundingSource?: 'cash' | 'bank' | 'wechat' | 'alipay' | 'huabei' | 'baitiao' | 'douyin_month' | 'pdd_bnpl' | 'credit_card' | null
  /** 关联负债账户（credit_accounts.id），负债支付时写入 */
  lienAccountId?: string | null
}

// ========== 扣费日程 ==========
export interface Schedule {
  id: string
  name: string // 日程名，如"爱奇艺会员续费"
  type: 'subscription' | 'debt' | 'other' // 续费服务 / 还款 / 其他
  amountMinor: number // 金额，分
  date: string // 年月日，YYYY-MM-DD
  repeat: 'none' | 'monthly' | 'yearly' // 是否重复
  note: string // 备注
  notified: boolean // 是否已提醒
}

// ========== 账户 ==========
export interface Account {
  id: string
  name: string
  type: 'asset' | 'liability' | 'expense' | 'revenue'
  balanceMinor: number // 账户余额，分
  isLocked: boolean // 是否锁定为储蓄
}

// ========== 储蓄目标 ==========
export interface SavingsGoal {
  id: string
  name: string
  reason: string // 动机描述
  image: string | null
  targetMinor: number
  currentMinor: number
  milestones: number[] // 子里程碑金额（分），升序
  deadline: string | null
  isActive: boolean // 当前焦点目标
  revokedContributionsMinor: number // 来自撤销消费的贡献
}

// ========== 偿债基金 ==========
export interface SinkingFund {
  id: string
  name: string // 如"春节红包""年保费""双十一"
  targetMinor: number
  monthlyMinor: number
  nextDue: string | null
}

// ========== 欲望清单 ==========
export interface WishlistItem {
  id: string
  name: string
  priceMinor: number
  /** 确认购买时的实际入手价（降价追踪用，可空） */
  finalPriceMinor: number | null
  /** 确认购买时间 */
  boughtAt: string | null
  addedAt: string
  coolingDays: number
  coolingEndsAt: string
  status: 'cooling' | 'confirmed' | 'abandoned'
  aiAnalysis: string | null
  /** 冷静期被延长的次数（理智恢复统计用，可空兼容历史数据） */
  extendCount?: number
  /** 决策落定时间（放弃/确认，理智恢复"本月已放弃"统计用） */
  resolvedAt?: string | null
}

// ========== 欲望清单 AI 对话线程 ==========

/** 一条对话消息（保留 tool 回合以便 API 上下文重建） */
export interface WishlistChatMsg {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  /** tool 消息：工具名 */
  name?: string
  /** tool 消息：对应的 tool_call_id */
  toolCallId?: string
  /** assistant 消息：本轮请求调用的工具（用于 API 重建） */
  toolCalls?: { id: string; name: string; args: string }[]
  /** 消息时间戳 */
  ts: number
}

/** 冲动分析维度（0-100，分数越高冲动风险越高） */
export interface WishlistSummaryDimension {
  label: string
  score: number
}

/** AI 动态生成的对话总结（JSON，前端渲染雷达图/指数条/标签/建议卡） */
export interface WishlistChatSummary {
  /** 结论：买 / 延迟 / 不买 */
  conclusion: 'buy' | 'delay' | 'skip'
  /** 一句话结论文案 */
  verdict: string
  /** 依据（引用对话里用户说过的话 + 真实数据） */
  reasons: string[]
  /** 7 个维度冲动分析（0-100） */
  dimensions: WishlistSummaryDimension[]
  /** 真实需求指数（0-100，越高越需要） */
  realNeedIndex: number
  /** 命中的消费主义陷阱 */
  traps: string[]
  /** 建议冷静期（天） */
  coolingDays: number
  /** 替代方案（结合用户场景） */
  alternatives: string[]
}

/** 每个欲望商品一个对话线程 */
export interface WishlistChat {
  id: string
  wishlistId: string
  messages: WishlistChatMsg[]
  status: 'chatting' | 'completed'
  summary: WishlistChatSummary | null
  updatedAt: string
}

// ========== 债务 ==========
export interface Debt {
  id: string
  name: string
  remainingMinor: number
  aprXirr: number // 真实年化利率，百分比
  nextDue: string | null
  strategy: 'snowball' | 'avalanche' // 雪球/雪崩
}

// ========== 负债账户（花呗/京东白条/抖音月付/先用后付/信用卡） ==========

export type CreditPlatform = '花呗' | '京东白条' | '抖音月付' | '拼多多先用后付' | '信用卡' | '其他'

export interface CreditAccount {
  id: string
  platform: CreditPlatform
  nickname: string // 账户昵称，如"主花呗"
  creditLimitMinor: number // 授信额度（分）
  statementDay: number // 账单日（1-28）
  dueDay: number // 还款日（1-28）
  graceDays: number // 免息期（天）
  minPayRatio: number // 最低还款比例，默认 0.1
  rateType: 'day_fee' | 'installment_fee' | 'apr' // 日费率 / 分期费率 / 年化
  feeRate: number // 如 0.0005 = 万五/日；installment_fee 为每期费率；apr 为年化百分比
  createdAt: string
}

/** 每期账单（每账户每月一条） */
export interface CreditStatement {
  id: string
  accountId: string
  period: string // '2026-08'
  statementDate: string
  dueDate: string
  statementAmtMinor: number // 本期应还
  minPaymentMinor: number
  paidAmtMinor: number // 已还
  principalRemMinor: number // 剩余待还
  isMinOnly: boolean // 只还最低 → 滚存预警
  status: 'pending' | 'paid' | 'overdue'
  createdAt: string
}

/** 分期（负债支付可分 3/6/12 期） */
export interface Installment {
  id: string
  accountId: string
  txId: string
  totalPeriods: number
  currentPeriod: number
  principalPerMinor: number // 每期本金
  feePerMinor: number // 每期手续费
  realApr: number // 真实年化（Newton 法反解），百分比
  createdAt: string
}

// ========== 自动化储蓄规则 ==========
export interface SavingsRule {
  id: string
  type: 'payday' | 'roundup' | 'noSpendDay' | 'surplus'
  config: Record<string, unknown> // 规则参数
  enabled: boolean
}

// ========== 通知日志 ==========
export interface NotificationLog {
  id: string
  type: string
  sentAt: string
  status: string
}

// ========== 设置（key-value 存储） ==========
export interface Setting {
  id: string // key，如 'monthlyBudget'
  value: number | string // 数值（金额用"分"）或字符串（如 API Key）
}

// ========== 导航项（UI 用） ==========
export interface NavItem {
  path: string
  label: string
  icon: string
}

// ========== 净资产快照 ==========
export interface BalanceSnapshot {
  id: string
  date: string // YYYY-MM-DD
  cashMinor: number
  bankMinor: number
  wechatMinor: number
  alipayMinor: number
  otherMinor: number
  liabilityMinor: number // 负债合计
  note: string
  createdAt: string
}

// ========== 自我承诺合约 ==========
export interface Commitment {
  id: string
  text: string // 承诺内容，如"本月购物不超¥200"
  targetCategory: string | null // 统计的分类（如"购物"），null = 总支出
  targetMinor: number // 承诺目标金额（分）
  penaltyMinor: number // 违约罚金（分），违约时转储蓄
  deadline: string // YYYY-MM-DD（默认月底）
  status: 'active' | 'kept' | 'broken' | 'cancelled'
  createdAt: string
  fulfilledAt: string | null
}

// ========== 情绪记录 ==========
export interface Mood {
  id: string
  date: string // YYYY-MM-DD（每天至多一条）
  mood: 'happy' | 'stressed' | 'bored' | 'angry' | 'calm'
  note: string
  createdAt: string
}

// ========== 消费事件（多 Agent 画像数据基础） ==========

export type ConsumerTriggerType = '深夜' | '优惠' | '无聊' | '情绪' | '促销推送' | '其他'

export interface ConsumerEvent {
  id: string
  txId: string | null // 对应交易 id（导入/历史回填时也可为 null）
  product: string // 商品/商家
  amountMinor: number
  time: string // ISO
  platform: string | null
  category: string
  triggerType: ConsumerTriggerType
  riskScore: number // 0-100（保存时已算的冲动指数）
  isImpulse: boolean
  aiNotes: string | null
  createdAt: string
  // ---- 30 天购买反馈闭环（spec 三，扩展字段） ----
  qualityScore: number | null // 90=经常用 / 50=偶尔用 / 20=没用
  feedbackStatus: 'pending' | 'done' | null
}

// ========== 决策记录（购买决策引擎问答留档） ==========

export interface DecisionQuestion {
  question: string
  options: string[]
  answer: string | null
}

export interface DecisionRecord {
  id: string
  relatedType: 'wishlist' | 'impulse' | 'transaction'
  relatedId: string
  questions: DecisionQuestion[]
  finalDecision: 'buy' | 'abandon' | 'delay' | null
  createdAt: string
}

// ========== 行为画像（统计引擎实时计算，非手写模板） ==========

export interface BehaviorProfile {
  id: string
  nightRisk: number // 近30天深夜消费占比 0-100
  discountSensitivity: number // 近30天优惠触发事件占比 0-100
  repeatRisk: number // 近30天同分类重复购买率 0-100
  impulseProbability: number // 近30天冲动交易占比 0-100
  delayedGratification: number // 欲望清单放弃率 0-100（越高越能延迟满足）
  highRiskWindows: string[] // 近30天冲动最集中时段 Top2，如 ['22:00-24:00']
  highRiskCategories: string[] // 近30天冲动最集中分类 Top2
  avgPurchaseQuality: number | null // 近90天购买质量分均值（30天反馈后才有）
  lastUpdatedAt: string
}

// ========== 洞察（AI 主动找你 / 洞察卡） ==========

export interface Insight {
  id: string
  type: 'pattern' | 'warning' | 'praise'
  content: string
  evidence: string // 数据依据（必须引用真实数字）
  relatedCategory: string | null
  createdAt: string
  acknowledged: boolean
  sourceKey: string | null // 去重键，如 3nights_2026-08-10 / savings_2026-08
}

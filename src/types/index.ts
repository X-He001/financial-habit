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
  /** 计划来源：'user' = 用户手动填写月还/月数；缺省 = 旧版按金额自动推算的期数（兼容保留，不删改） */
  source?: 'user' | 'auto'
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

/** 认知教练（Cognitive Coach）逐次复盘存档：用户自述 / 洞察结论 / 自我标记 */
export interface CoachNote {
  id: string
  ts: string // ISO 时间
  type: 'onboarding' | 'review' | 'self_label' | 'reflection'
  /** 主题标签：消费习惯 / 场景触发 / 存钱目标 / 风险点 / 自我认知 / 模式命名 */
  tag: string | null
  /** 用户关键回答 / AI 洞察结论（供下次复盘引用，如"上次你说深夜压力大会点外卖"） */
  content: string
  /** 引用的真实数据（如"深夜订单 3 笔 ¥128"），由工具调用方写入 */
  dataRef?: string | null
}

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
  // ---- 认知教练存档（统计重算时保留，不参与画像统计） ----
  coachNotes?: CoachNote[]
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

// ========== F5 购买反馈 Agent 循环：知识库 / 反馈日志 / 队列 ==========

/**
 * 知识库条目（knowledge_refs）
 * F5 7.2：检索式"图书馆"，不是触发式"触发器"。
 * - 没有 trigger_keywords 字段（禁止机械匹配）；Agent 用推理语境检索概念。
 * - 书/作者信息只作为出处（citation）用于"了解更多"折叠区，禁止出现在反馈正文。
 */
export interface KnowledgeRef {
  id: string
  /** 概念类别：犹豫合理化 / 情绪渴望 / 习惯身份 / 稀缺限时 / 资产负债 / 储蓄金鹅 */
  category: string
  /** 概念名（如"犹豫合理化"） */
  concept: string
  /** 书名（仅存元数据，不直接进正文） */
  book: string
  /** 作者（仅存元数据，不直接进正文） */
  author: string
  /** 核心论点（供 Agent 理解与情境匹配，可改写） */
  thesis: string
  /** 适用场景描述（供情境检索打分） */
  applicable_scenarios: string[]
  /** 可落地的动作模板（Agent 基于具体场景改写） */
  action_templates: string[]
  /** 术语的人话科普文案（Agent 可基于场景改写，必须大白话） */
  plain_explanation: string
  /** 出处，仅"了解更多"折叠区展示，绝不进正文 */
  citation: string
  /** active=可用 / pending=待审 */
  status: 'active' | 'pending'
  updatedAt: string
}

/**
 * 反馈效果日志（feedback_logs）
 * F5 7.3⑩：反馈 2 周后自动回查该模式消费变化，≥20% 下降 → effective，否则 ineffective。
 * 下次同类场景优先用 effective 角度、跳过 ineffective 角度。
 */
export interface FeedbackLog {
  id: string
  /** 关联 agent_inbox 条目 id（同一反馈的显示队列记录） */
  inboxId: string
  /** 正面（进步） / 负面（问题）反馈 */
  type: 'positive' | 'negative'
  /** 反馈对象：wishlist=欲望清单犹豫后购买（对象A）/ event=对话中承认陷阱的消费（对象B） */
  objectType: 'wishlist' | 'event'
  objectId: string
  /** 关联知识库条目（⑤检索命中的概念） */
  knowledgeRefId?: string | null
  /** ④ 形成的假设（供回查与下次引用） */
  hypothesis: string
  /** ⑥ 生成的开场（一个数据观察 + 一个开放问题） */
  opening: string
  /** 模式标识（如"深夜购物"），用于⑩前后对比 */
  patternKey: string
  /** ⑩ 反馈前该模式消费金额（分） */
  beforeMinor: number
  /** ⑩ 反馈后该模式消费金额（分） */
  afterMinor?: number | null
  /** ⑩ 效果：下降≥20% → effective，否则 ineffective */
  effectStatus?: 'effective' | 'ineffective' | null
  effectCheckedAt?: string | null
  /** 实际对话轮数（7.5.2：单卡最多 4 轮） */
  rounds: number
  createdAt: string
  updatedAt: string
}

/**
 * 反馈/提醒队列（agent_inbox）
 * F5 7.3⑨ + 7.6：Agent 判断有必要 → 写入队列，scheduled_at = 次日 09:00；
 * 次日 09:00 后用户打开应用时，首页看板顶部展示。
 */
export interface AgentInboxItem {
  id: string
  /** feedback_card=反馈卡 / impulse_window=高频冲动窗口提醒（7.7） */
  kind: 'feedback_card' | 'impulse_window'
  objectType: 'wishlist' | 'event' | 'window'
  objectId: string
  /** 卡片标题 */
  title: string
  /** 开场内容（数据观察 + 开放问题；窗口提醒为分析文案） */
  opening: string
  /** 关联知识库条目 */
  knowledgeRefId?: string | null
  /** 关联反馈日志（feedback_card 时） */
  feedbackLogId?: string | null
  /** 展示时间（次日 09:00） */
  scheduledAt: string
  /** pending=排队中 / shown=已展示 / dismissed=用户关闭 / completed=对话完成 */
  status: 'pending' | 'shown' | 'dismissed' | 'completed'
  /** 对话轮数（7.5.2：最多 4 轮） */
  rounds: number
  createdAt: string
  updatedAt: string
}

/**
 * 隐私分层三档（AI 调用层脱敏，F5 配套规则，确认版）
 * 档1 聚合数据（默认，日常分析）：只传聚合统计，绝不传单笔明细（商户名/备注/单笔金额明细列表）
 * 档2 脱敏单笔（反馈/引用场景）：金额/时间/类别保留，商户名/平台名/备注 → "某平台"/"某商户"
 * 档3 完整单笔（仅用户主动查明细时）：用户明确发起单笔查询才使用，循环/日常分析不得自动使用
 */
export type PrivacyTier = 1 | 2 | 3

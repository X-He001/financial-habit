import Dexie, { type Table } from 'dexie'
import type {
  Transaction, Account, SavingsGoal, SinkingFund,
  WishlistItem, Debt, SavingsRule, NotificationLog, Category, Schedule, Setting, WishlistChat,
  BalanceSnapshot, Commitment, Mood,
  ConsumerEvent, DecisionRecord, BehaviorProfile, Insight,
  CreditAccount, CreditStatement, Installment,
} from '../types'

class FinancialDB extends Dexie {
  transactions!: Table<Transaction, string>
  accounts!: Table<Account, string>
  savingsGoals!: Table<SavingsGoal, string>
  sinkingFunds!: Table<SinkingFund, string>
  wishlist!: Table<WishlistItem, string>
  wishlistChats!: Table<WishlistChat, string>
  debts!: Table<Debt, string>
  savingsRules!: Table<SavingsRule, string>
  notificationLogs!: Table<NotificationLog, string>
  categories!: Table<Category, string>
  schedules!: Table<Schedule, string>
  settings!: Table<Setting, string>
  balanceSnapshots!: Table<BalanceSnapshot, string>
  commitments!: Table<Commitment, string>
  moods!: Table<Mood, string>
  consumerEvents!: Table<ConsumerEvent, string>
  decisionRecords!: Table<DecisionRecord, string>
  behaviorProfiles!: Table<BehaviorProfile, string>
  insights!: Table<Insight, string>
  creditAccounts!: Table<CreditAccount, string>
  creditStatements!: Table<CreditStatement, string>
  installments!: Table<Installment, string>

  constructor() {
    super('financial-habit-db')

    this.version(1).stores({
      transactions: 'id, category, time',
      accounts: 'id, name',
      savingsGoals: 'id, isActive',
      sinkingFunds: 'id, name',
      wishlist: 'id, status, coolingEndsAt',
      debts: 'id, name',
      savingsRules: 'id, type, enabled',
      notificationLogs: 'id, type, sentAt',
    })

    this.version(2).stores({
      transactions: 'id, category, time',
      accounts: 'id, name',
      savingsGoals: 'id, isActive',
      sinkingFunds: 'id, name',
      wishlist: 'id, status, coolingEndsAt',
      debts: 'id, name',
      savingsRules: 'id, type, enabled',
      notificationLogs: 'id, type, sentAt',
      categories: 'id, name',
    })

    this.version(3).stores({
      transactions: 'id, category, time, txType',
      accounts: 'id, name',
      savingsGoals: 'id, isActive',
      sinkingFunds: 'id, name',
      wishlist: 'id, status, coolingEndsAt',
      debts: 'id, name',
      savingsRules: 'id, type, enabled',
      notificationLogs: 'id, type, sentAt',
      categories: 'id, name',
      schedules: 'id, type, date, repeat',
    })

    this.version(4).stores({
      transactions: 'id, category, time, txType',
      accounts: 'id, name',
      savingsGoals: 'id, isActive',
      sinkingFunds: 'id, name',
      wishlist: 'id, status, coolingEndsAt',
      debts: 'id, name',
      savingsRules: 'id, type, enabled',
      notificationLogs: 'id, type, sentAt',
      categories: 'id, name',
      schedules: 'id, type, date, repeat',
      settings: 'id, value',
    })

    this.version(5).stores({
      transactions: 'id, category, time, txType',
      accounts: 'id, name',
      savingsGoals: 'id, isActive',
      sinkingFunds: 'id, name',
      wishlist: 'id, status, coolingEndsAt',
      wishlistChats: 'id, wishlistId',
      debts: 'id, name',
      savingsRules: 'id, type, enabled',
      notificationLogs: 'id, type, sentAt',
      categories: 'id, name',
      schedules: 'id, type, date, repeat',
      settings: 'id, value',
    })

    this.version(6).stores({
      transactions: 'id, category, time, txType',
      accounts: 'id, name',
      savingsGoals: 'id, isActive',
      sinkingFunds: 'id, name',
      wishlist: 'id, status, coolingEndsAt',
      wishlistChats: 'id, wishlistId',
      debts: 'id, name',
      savingsRules: 'id, type, enabled',
      notificationLogs: 'id, type, sentAt',
      categories: 'id, name',
      schedules: 'id, type, date, repeat',
      settings: 'id, value',
      balanceSnapshots: 'id, date',
      commitments: 'id, status, deadline',
      moods: 'id, date, mood',
    })

    // 多 Agent 系统：消费事件 / 决策记录 / 行为画像 / 洞察
    this.version(7).stores({
      transactions: 'id, category, time, txType',
      accounts: 'id, name',
      savingsGoals: 'id, isActive',
      sinkingFunds: 'id, name',
      wishlist: 'id, status, coolingEndsAt',
      wishlistChats: 'id, wishlistId',
      debts: 'id, name',
      savingsRules: 'id, type, enabled',
      notificationLogs: 'id, type, sentAt',
      categories: 'id, name',
      schedules: 'id, type, date, repeat',
      settings: 'id, value',
      balanceSnapshots: 'id, date',
      commitments: 'id, status, deadline',
      moods: 'id, date, mood',
      consumerEvents: 'id, txId, time, category, triggerType, isImpulse, createdAt',
      decisionRecords: 'id, relatedType, relatedId, createdAt',
      behaviorProfiles: 'id',
      insights: 'id, type, createdAt, acknowledged, sourceKey',
    })

    // v8：表名统一为驼峰（此前误用蛇形 consumer_events 等，导致 db.consumerEvents 等属性缺失）。
    // 显式升版本确保已存在 v7 蛇形表的库触发迁移，重建驼峰表。
    this.version(8).stores({
      transactions: 'id, category, time, txType',
      accounts: 'id, name',
      savingsGoals: 'id, isActive',
      sinkingFunds: 'id, name',
      wishlist: 'id, status, coolingEndsAt',
      wishlistChats: 'id, wishlistId',
      debts: 'id, name',
      savingsRules: 'id, type, enabled',
      notificationLogs: 'id, type, sentAt',
      categories: 'id, name',
      schedules: 'id, type, date, repeat',
      settings: 'id, value',
      balanceSnapshots: 'id, date',
      commitments: 'id, status, deadline',
      moods: 'id, date, mood',
      consumerEvents: 'id, txId, time, category, triggerType, isImpulse, createdAt',
      decisionRecords: 'id, relatedType, relatedId, createdAt',
      behaviorProfiles: 'id',
      insights: 'id, type, createdAt, acknowledged, sourceKey',
    })

    // v9：负债板块（credit_accounts / credit_statements / installments）
    this.version(9).stores({
      transactions: 'id, category, time, txType',
      accounts: 'id, name',
      savingsGoals: 'id, isActive',
      sinkingFunds: 'id, name',
      wishlist: 'id, status, coolingEndsAt',
      wishlistChats: 'id, wishlistId',
      debts: 'id, name',
      savingsRules: 'id, type, enabled',
      notificationLogs: 'id, type, sentAt',
      categories: 'id, name',
      schedules: 'id, type, date, repeat',
      settings: 'id, value',
      balanceSnapshots: 'id, date',
      commitments: 'id, status, deadline',
      moods: 'id, date, mood',
      consumerEvents: 'id, txId, time, category, triggerType, isImpulse, createdAt',
      decisionRecords: 'id, relatedType, relatedId, createdAt',
      behaviorProfiles: 'id',
      insights: 'id, type, createdAt, acknowledged, sourceKey',
      creditAccounts: 'id, platform, nickname',
      creditStatements: 'id, accountId, period, status, dueDate',
      installments: 'id, accountId, txId',
    })
  }
}

export const db = new FinancialDB()

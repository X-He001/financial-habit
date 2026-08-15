import type { IndexableType } from 'dexie'
import { db } from './database'
import { requestPushToCloud } from '../sync/realtimeSync'
import { LAST_SYNC_AT_KEY } from '../sync/pushSync'
import type {
  Transaction, Account, SavingsGoal, SinkingFund,
  WishlistItem, Debt, SavingsRule, NotificationLog, Category, Schedule, Setting, WishlistChat,
  BalanceSnapshot, Commitment, Mood,
  ConsumerEvent, DecisionRecord, BehaviorProfile, Insight,
  CreditAccount, CreditStatement, Installment,
} from '../types'

// ==================== 通用 CRUD 工具 ====================

function uuid(): string {
  // HTTP 非安全上下文下 crypto.randomUUID 不可用，提供兜底（兼容写法）
  return (crypto.randomUUID ? crypto.randomUUID() : (function(){return"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var r=crypto.getRandomValues(new Uint8Array(1))[0]%16;return(c==="x"?r:(r&3|8)).toString(16)})})())
}

// ==================== Transaction ====================

export async function addTransaction(data: Omit<Transaction, 'id'>): Promise<string> {
  const id = uuid()
  await db.transactions.add({ id, ...data } as Transaction)
  requestPushToCloud() // 写操作成功 → 实时推送
  return id
}

export async function getTransaction(id: string): Promise<Transaction | undefined> {
  return db.transactions.get(id)
}

export async function updateTransaction(id: string, data: Partial<Transaction>): Promise<void> {
  await db.transactions.update(id, data)
  requestPushToCloud()
}

export async function deleteTransaction(id: string): Promise<void> {
  await db.transactions.delete(id)
  requestPushToCloud()
}

export async function getAllTransactions(): Promise<Transaction[]> {
  return db.transactions.toArray()
}

export async function getTransactionsByField(field: keyof Transaction, value: IndexableType): Promise<Transaction[]> {
  return db.transactions.where(field).equals(value).toArray()
}

// ==================== Account ====================

export async function addAccount(data: Omit<Account, 'id'>): Promise<string> {
  const id = uuid()
  await db.accounts.add({ id, ...data } as Account)
  return id
}

export async function getAccount(id: string): Promise<Account | undefined> {
  return db.accounts.get(id)
}

export async function updateAccount(id: string, data: Partial<Account>): Promise<void> {
  await db.accounts.update(id, data)
}

export async function deleteAccount(id: string): Promise<void> {
  await db.accounts.delete(id)
}

export async function getAllAccounts(): Promise<Account[]> {
  return db.accounts.toArray()
}

export async function getAccountsByField(field: keyof Account, value: IndexableType): Promise<Account[]> {
  return db.accounts.where(field).equals(value).toArray()
}

// ==================== SavingsGoal ====================

export async function addSavingsGoal(data: Omit<SavingsGoal, 'id'>): Promise<string> {
  const id = uuid()
  await db.savingsGoals.add({ id, ...data } as SavingsGoal)
  requestPushToCloud()
  return id
}

export async function getSavingsGoal(id: string): Promise<SavingsGoal | undefined> {
  return db.savingsGoals.get(id)
}

export async function updateSavingsGoal(id: string, data: Partial<SavingsGoal>): Promise<void> {
  await db.savingsGoals.update(id, data)
  requestPushToCloud()
}

export async function deleteSavingsGoal(id: string): Promise<void> {
  await db.savingsGoals.delete(id)
  requestPushToCloud()
}

export async function getAllSavingsGoals(): Promise<SavingsGoal[]> {
  return db.savingsGoals.toArray()
}

export async function getSavingsGoalsByField(field: keyof SavingsGoal, value: IndexableType): Promise<SavingsGoal[]> {
  return db.savingsGoals.where(field).equals(value).toArray()
}

// ==================== SinkingFund ====================

export async function addSinkingFund(data: Omit<SinkingFund, 'id'>): Promise<string> {
  const id = uuid()
  await db.sinkingFunds.add({ id, ...data } as SinkingFund)
  return id
}

export async function getSinkingFund(id: string): Promise<SinkingFund | undefined> {
  return db.sinkingFunds.get(id)
}

export async function updateSinkingFund(id: string, data: Partial<SinkingFund>): Promise<void> {
  await db.sinkingFunds.update(id, data)
}

export async function deleteSinkingFund(id: string): Promise<void> {
  await db.sinkingFunds.delete(id)
}

export async function getAllSinkingFunds(): Promise<SinkingFund[]> {
  return db.sinkingFunds.toArray()
}

export async function getSinkingFundsByField(field: keyof SinkingFund, value: IndexableType): Promise<SinkingFund[]> {
  return db.sinkingFunds.where(field).equals(value).toArray()
}

// ==================== WishlistItem ====================

export async function addWishlistItem(data: Omit<WishlistItem, 'id'>): Promise<string> {
  const id = uuid()
  await db.wishlist.add({ id, ...data } as WishlistItem)
  return id
}

export async function getWishlistItem(id: string): Promise<WishlistItem | undefined> {
  return db.wishlist.get(id)
}

export async function updateWishlistItem(id: string, data: Partial<WishlistItem>): Promise<void> {
  await db.wishlist.update(id, data)
}

export async function deleteWishlistItem(id: string): Promise<void> {
  await db.wishlist.delete(id)
}

export async function getAllWishlistItems(): Promise<WishlistItem[]> {
  return db.wishlist.toArray()
}

export async function getWishlistItemsByField(field: keyof WishlistItem, value: IndexableType): Promise<WishlistItem[]> {
  return db.wishlist.where(field).equals(value).toArray()
}

// ==================== WishlistChat（欲望清单 AI 对话线程） ====================

export async function addWishlistChat(data: Omit<WishlistChat, 'id'>): Promise<string> {
  const id = uuid()
  await db.wishlistChats.add({ id, ...data } as WishlistChat)
  return id
}

export async function getWishlistChat(id: string): Promise<WishlistChat | undefined> {
  return db.wishlistChats.get(id)
}

/** 按 wishlistId 找对话线程（每个商品至多一个） */
export async function getWishlistChatByItem(wishlistId: string): Promise<WishlistChat | undefined> {
  return db.wishlistChats.where('wishlistId').equals(wishlistId).first()
}

export async function updateWishlistChat(id: string, data: Partial<WishlistChat>): Promise<void> {
  await db.wishlistChats.update(id, data)
}

export async function getAllWishlistChats(): Promise<WishlistChat[]> {
  return db.wishlistChats.toArray()
}

// ==================== Debt ====================

export async function addDebt(data: Omit<Debt, 'id'>): Promise<string> {
  const id = uuid()
  await db.debts.add({ id, ...data } as Debt)
  requestPushToCloud()
  return id
}

export async function getDebt(id: string): Promise<Debt | undefined> {
  return db.debts.get(id)
}

export async function updateDebt(id: string, data: Partial<Debt>): Promise<void> {
  await db.debts.update(id, data)
  requestPushToCloud()
}

export async function deleteDebt(id: string): Promise<void> {
  await db.debts.delete(id)
  requestPushToCloud()
}

export async function getAllDebts(): Promise<Debt[]> {
  return db.debts.toArray()
}

export async function getDebtsByField(field: keyof Debt, value: IndexableType): Promise<Debt[]> {
  return db.debts.where(field).equals(value).toArray()
}

// ==================== CreditAccount（负债账户） ====================

export async function addCreditAccount(data: Omit<CreditAccount, 'id'>): Promise<string> {
  const id = uuid()
  await db.creditAccounts.add({ id, ...data } as CreditAccount)
  return id
}

export async function updateCreditAccount(id: string, data: Partial<CreditAccount>): Promise<void> {
  await db.creditAccounts.update(id, data)
}

export async function deleteCreditAccount(id: string): Promise<void> {
  await db.creditAccounts.delete(id)
}

export async function getAllCreditAccounts(): Promise<CreditAccount[]> {
  return db.creditAccounts.toArray()
}

// ==================== CreditStatement（每期账单） ====================

export async function addCreditStatement(data: Omit<CreditStatement, 'id'>): Promise<string> {
  const id = uuid()
  await db.creditStatements.add({ id, ...data } as CreditStatement)
  return id
}

export async function updateCreditStatement(id: string, data: Partial<CreditStatement>): Promise<void> {
  await db.creditStatements.update(id, data)
}

export async function deleteCreditStatement(id: string): Promise<void> {
  await db.creditStatements.delete(id)
}

export async function getAllCreditStatements(): Promise<CreditStatement[]> {
  return db.creditStatements.toArray()
}

/** 某账户当前期账单（最近的 pending） */
export async function getCurrentStatement(accountId: string): Promise<CreditStatement | null> {
  const all = await db.creditStatements.where('accountId').equals(accountId).toArray()
  const active = all
    .filter(s => s.status === 'pending' || s.status === 'overdue')
    .sort((a, b) => (a.period < b.period ? 1 : -1))
  return active[0] ?? null
}

// ==================== Installment（分期） ====================

export async function addInstallment(data: Omit<Installment, 'id'>): Promise<string> {
  const id = uuid()
  await db.installments.add({ id, ...data } as Installment)
  return id
}

export async function updateInstallment(id: string, data: Partial<Installment>): Promise<void> {
  await db.installments.update(id, data)
}

export async function getAllInstallments(): Promise<Installment[]> {
  return db.installments.toArray()
}

// ==================== SavingsRule ====================

export async function addSavingsRule(data: Omit<SavingsRule, 'id'>): Promise<string> {
  const id = uuid()
  await db.savingsRules.add({ id, ...data } as SavingsRule)
  return id
}

export async function getSavingsRule(id: string): Promise<SavingsRule | undefined> {
  return db.savingsRules.get(id)
}

export async function updateSavingsRule(id: string, data: Partial<SavingsRule>): Promise<void> {
  await db.savingsRules.update(id, data)
}

export async function deleteSavingsRule(id: string): Promise<void> {
  await db.savingsRules.delete(id)
}

export async function getAllSavingsRules(): Promise<SavingsRule[]> {
  return db.savingsRules.toArray()
}

export async function getSavingsRulesByField(field: keyof SavingsRule, value: IndexableType): Promise<SavingsRule[]> {
  return db.savingsRules.where(field).equals(value).toArray()
}

// ==================== NotificationLog ====================

export async function addNotificationLog(data: Omit<NotificationLog, 'id'>): Promise<string> {
  const id = uuid()
  await db.notificationLogs.add({ id, ...data } as NotificationLog)
  return id
}

export async function getNotificationLog(id: string): Promise<NotificationLog | undefined> {
  return db.notificationLogs.get(id)
}

export async function updateNotificationLog(id: string, data: Partial<NotificationLog>): Promise<void> {
  await db.notificationLogs.update(id, data)
}

export async function deleteNotificationLog(id: string): Promise<void> {
  await db.notificationLogs.delete(id)
}

export async function getAllNotificationLogs(): Promise<NotificationLog[]> {
  return db.notificationLogs.toArray()
}

export async function getNotificationLogsByField(field: keyof NotificationLog, value: IndexableType): Promise<NotificationLog[]> {
  return db.notificationLogs.where(field).equals(value).toArray()
}

// ==================== Category ====================

const DEFAULT_CATEGORIES: Omit<Category, 'id'>[] = [
  { name: '餐饮', icon: '🍜', color: '#0040FF', isDefault: true },
  { name: '购物', icon: '🛒', color: '#06B6D4', isDefault: true },
  { name: '日用百货', icon: '🧴', color: '#8B5CF6', isDefault: true },
  { name: '娱乐', icon: '🎮', color: '#F43F5E', isDefault: true },
  { name: '交通', icon: '🚗', color: '#F59E0B', isDefault: true },
  { name: '虚拟消费', icon: '💳', color: '#10B981', isDefault: true },
  { name: '其他', icon: '📦', color: '#888888', isDefault: true },
]

export async function initDefaultCategories(): Promise<void> {
  await db.categories.clear()
  for (const cat of DEFAULT_CATEGORIES) {
    await db.categories.add({ id: uuid(), ...cat } as Category)
  }
  console.log('✅ 默认分类已初始化')
}

export async function addCategory(data: Omit<Category, 'id'>): Promise<string> {
  const id = uuid()
  await db.categories.add({ id, ...data } as Category)
  return id
}

export async function getCategory(id: string): Promise<Category | undefined> {
  return db.categories.get(id)
}

export async function updateCategory(id: string, data: Partial<Category>): Promise<void> {
  await db.categories.update(id, data)
}

export async function deleteCategory(id: string): Promise<void> {
  await db.categories.delete(id)
}

export async function getAllCategories(): Promise<Category[]> {
  return db.categories.toArray()
}

// ==================== Schedule 扣费日程 ====================

export async function addSchedule(data: Omit<Schedule, 'id'>): Promise<string> {
  const id = uuid()
  await db.schedules.add({ id, ...data } as Schedule)
  requestPushToCloud()
  return id
}

export async function getSchedule(id: string): Promise<Schedule | undefined> {
  return db.schedules.get(id)
}

export async function updateSchedule(id: string, data: Partial<Schedule>): Promise<void> {
  await db.schedules.update(id, data)
  requestPushToCloud()
}

export async function deleteSchedule(id: string): Promise<void> {
  await db.schedules.delete(id)
  requestPushToCloud()
}

export async function getAllSchedules(): Promise<Schedule[]> {
  return db.schedules.toArray()
}

export async function getSchedulesByField(field: keyof Schedule, value: IndexableType): Promise<Schedule[]> {
  return db.schedules.where(field).equals(value).toArray()
}

// ==================== Setting 设置（key-value） ====================

export async function getSetting(key: string): Promise<number | string | undefined> {
  const row = await db.settings.get(key)
  return row?.value
}

export async function setSetting(key: string, value: number | string): Promise<void> {
  await db.settings.put({ id: key, value } as Setting)
  // 同步时间戳由同步流程自身写入，不触发推送，避免推送自循环
  if (key !== LAST_SYNC_AT_KEY) requestPushToCloud()
}

export async function getAllSettings(): Promise<Setting[]> {
  return db.settings.toArray()
}

// ==================== BalanceSnapshot 净资产快照 ====================

export async function addBalanceSnapshot(data: Omit<BalanceSnapshot, 'id'>): Promise<string> {
  const id = uuid()
  await db.balanceSnapshots.add({ id, ...data } as BalanceSnapshot)
  return id
}

export async function deleteBalanceSnapshot(id: string): Promise<void> {
  await db.balanceSnapshots.delete(id)
}

export async function getAllBalanceSnapshots(): Promise<BalanceSnapshot[]> {
  return db.balanceSnapshots.toArray()
}

// ==================== Commitment 自我承诺 ====================

export async function addCommitment(data: Omit<Commitment, 'id'>): Promise<string> {
  const id = uuid()
  await db.commitments.add({ id, ...data } as Commitment)
  return id
}

export async function updateCommitment(id: string, data: Partial<Commitment>): Promise<void> {
  await db.commitments.update(id, data)
}

export async function deleteCommitment(id: string): Promise<void> {
  await db.commitments.delete(id)
}

export async function getAllCommitments(): Promise<Commitment[]> {
  return db.commitments.toArray()
}

// ==================== Mood 情绪记录 ====================

export async function addMood(data: Omit<Mood, 'id'>): Promise<string> {
  const id = uuid()
  await db.moods.add({ id, ...data } as Mood)
  return id
}

export async function updateMood(id: string, data: Partial<Mood>): Promise<void> {
  await db.moods.update(id, data)
}

export async function deleteMood(id: string): Promise<void> {
  await db.moods.delete(id)
}

export async function getMoodByDate(date: string): Promise<Mood | undefined> {
  return db.moods.where('date').equals(date).first()
}

export async function getAllMoods(): Promise<Mood[]> {
  return db.moods.toArray()
}

// ==================== ConsumerEvent 消费事件 ====================

export async function addConsumerEvent(data: Omit<ConsumerEvent, 'id'>): Promise<string> {
  const id = uuid()
  await db.consumerEvents.add({ id, ...data } as ConsumerEvent)
  return id
}

export async function updateConsumerEvent(id: string, data: Partial<ConsumerEvent>): Promise<void> {
  await db.consumerEvents.update(id, data)
}

export async function deleteConsumerEvent(id: string): Promise<void> {
  await db.consumerEvents.delete(id)
}

export async function getAllConsumerEvents(): Promise<ConsumerEvent[]> {
  return db.consumerEvents.toArray()
}

export async function getConsumerEventByTx(txId: string): Promise<ConsumerEvent | undefined> {
  return db.consumerEvents.where('txId').equals(txId).first()
}

// ==================== DecisionRecord 决策记录 ====================

export async function addDecisionRecord(data: Omit<DecisionRecord, 'id'>): Promise<string> {
  const id = uuid()
  await db.decisionRecords.add({ id, ...data } as DecisionRecord)
  return id
}

export async function updateDecisionRecord(id: string, data: Partial<DecisionRecord>): Promise<void> {
  await db.decisionRecords.update(id, data)
}

export async function deleteDecisionRecord(id: string): Promise<void> {
  await db.decisionRecords.delete(id)
}

export async function getAllDecisionRecords(): Promise<DecisionRecord[]> {
  return db.decisionRecords.toArray()
}

// ==================== BehaviorProfile 行为画像 ====================

export async function saveBehaviorProfile(data: BehaviorProfile): Promise<void> {
  await db.behaviorProfiles.put(data)
}

export async function getBehaviorProfile(): Promise<BehaviorProfile | undefined> {
  return db.behaviorProfiles.get('main')
}

// ==================== Insight 洞察 ====================

export async function addInsight(data: Omit<Insight, 'id'>): Promise<string> {
  const id = uuid()
  await db.insights.add({ id, ...data } as Insight)
  return id
}

export async function updateInsight(id: string, data: Partial<Insight>): Promise<void> {
  await db.insights.update(id, data)
}

export async function deleteInsight(id: string): Promise<void> {
  await db.insights.delete(id)
}

export async function getAllInsights(): Promise<Insight[]> {
  return db.insights.toArray()
}

export async function getUnacknowledgedInsights(): Promise<Insight[]> {
  return db.insights.filter(i => !i.acknowledged).toArray()
}

export async function acknowledgeInsight(id: string): Promise<void> {
  await db.insights.update(id, { acknowledged: true })
}

export async function getInsightBySourceKey(sourceKey: string): Promise<Insight | undefined> {
  return db.insights.where('sourceKey').equals(sourceKey).first()
}

// ==================== 清空数据 ====================

export async function clearAllData(): Promise<void> {
  await db.transactions.clear()
  await db.accounts.clear()
  await db.savingsGoals.clear()
  await db.sinkingFunds.clear()
  await db.wishlist.clear()
  await db.wishlistChats.clear()
  await db.debts.clear()
  await db.savingsRules.clear()
  await db.notificationLogs.clear()
  await db.categories.clear()
  await db.schedules.clear()
  await db.settings.clear()
  await db.balanceSnapshots.clear()
  await db.commitments.clear()
  await db.moods.clear()
  await db.consumerEvents.clear()
  await db.decisionRecords.clear()
  await db.behaviorProfiles.clear()
  await db.insights.clear()
  await db.creditAccounts.clear()
  await db.creditStatements.clear()
  await db.installments.clear()

  console.log('🗑️ 所有数据已清空（表结构保留）')
}

// =====================================================================
// 路由汇总：挂载各表 CRUD + 汇总接口
// =====================================================================
import { Router } from 'express'
import { createCrudRouter } from './crud.js'
import { summaryRouter } from './summary.js'
import { syncRouter } from './sync.js'
import { aiRouter } from './ai.js'

export const apiRouter = Router()

// ---- transactions ----
apiRouter.use('/transactions', createCrudRouter({
  table: 'transactions',
  orderBy: 'time DESC',
  filters: { from: 'time', to: 'time', category: 'category', txType: 'tx_type' },
  fields: {
    amountMinor: 'amount_minor', category: 'category', merchant: 'merchant',
    time: 'time', txType: 'tx_type', paymentMethod: 'payment_method',
    source: 'source', impulseScore: 'impulse_score', impulseLevel: 'impulse_level',
    isRevoked: 'is_revoked', revokedAt: 'revoked_at', regretValue: 'regret_value',
    regretAt: 'regret_at', importId: 'import_id', note: 'note',
    screenshot: 'screenshot', fundingSource: 'funding_source',
    lienAccountId: 'lien_account_id', createdAt: 'created_at', updatedAt: 'updated_at',
  },
}))

// ---- savings-goals ----
apiRouter.use('/savings-goals', createCrudRouter({
  table: 'savings_goals',
  fields: {
    name: 'name', reason: 'reason', image: 'image',
    targetMinor: 'target_minor', currentMinor: 'current_minor',
    milestones: 'milestones', deadline: 'deadline', isActive: 'is_active',
    revokedContributionsMinor: 'revoked_contributions_minor', updatedAt: 'updated_at',
  },
}))

// ---- debts ----
apiRouter.use('/debts', createCrudRouter({
  table: 'debts',
  fields: { name: 'name', remainingMinor: 'remaining_minor', aprXirr: 'apr_xirr', nextDue: 'next_due', strategy: 'strategy', updatedAt: 'updated_at' },
}))

// ---- credit-accounts ----
apiRouter.use('/credit-accounts', createCrudRouter({
  table: 'credit_accounts',
  fields: {
    platform: 'platform', nickname: 'nickname', creditLimitMinor: 'credit_limit_minor',
    statementDay: 'statement_day', dueDay: 'due_day', graceDays: 'grace_days',
    minPayRatio: 'min_pay_ratio', rateType: 'rate_type', feeRate: 'fee_rate',
    createdAt: 'created_at', updatedAt: 'updated_at',
  },
}))

// ---- schedules ----
apiRouter.use('/schedules', createCrudRouter({
  table: 'schedules',
  orderBy: 'date ASC',
  fields: { name: 'name', type: 'type', amountMinor: 'amount_minor', date: 'date', repeat: 'repeat', note: 'note', notified: 'notified', updatedAt: 'updated_at' },
}))

// ---- settings（主键是 key） ----
apiRouter.use('/settings', createCrudRouter({
  table: 'settings',
  idCol: 'key',
  fields: { value: 'value', updatedAt: 'updated_at' },
}))

// ---- dashboard-summary ----
apiRouter.use('/dashboard-summary', summaryRouter)

// ---- 数据同步（拉取云端全量数据） ----
apiRouter.use('/sync', syncRouter)

// ---- AI 代理（批量导入结构化提取，Key 只存服务器） ----
apiRouter.use('/ai', aiRouter)
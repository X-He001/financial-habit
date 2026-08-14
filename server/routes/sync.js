// =====================================================================
// 数据同步路由（SQLite 版）
// GET /api/sync/pull：全量导出云端全部业务表数据
// 返回 camelCase 结构，与前端 IndexedDB 表/字段命名保持一致，前端可直接 bulkPut
// =====================================================================
import { Router } from 'express'
import { db } from '../db.js'

// 每张业务表的同步配置：
//   api     返回给前端的数据键名（对应 IndexedDB 表名）
//   table   SQLite 表名
//   idCol   主键列（默认 'id'；settings 表为 'key'）
//   fields  camelCase → snake_case 字段映射（与 routes/crud.js 保持一致）
//   bool    存 0/1、前端需要 boolean 的列
//   json    存 JSON 字符串、前端需要对象/数组的列（读取时解析）
const TABLES = [
  {
    api: 'transactions', table: 'transactions',
    bool: ['is_revoked', 'regret_value'],
    fields: {
      amountMinor: 'amount_minor', category: 'category', merchant: 'merchant',
      time: 'time', txType: 'tx_type', paymentMethod: 'payment_method',
      source: 'source', impulseScore: 'impulse_score', impulseLevel: 'impulse_level',
      isRevoked: 'is_revoked', revokedAt: 'revoked_at', regretValue: 'regret_value',
      regretAt: 'regret_at', importId: 'import_id', note: 'note',
      screenshot: 'screenshot', fundingSource: 'funding_source',
      lienAccountId: 'lien_account_id', createdAt: 'created_at',
    },
  },
  {
    api: 'savingsGoals', table: 'savings_goals',
    bool: ['is_active'],
    json: ['milestones'],
    fields: {
      name: 'name', reason: 'reason', image: 'image',
      targetMinor: 'target_minor', currentMinor: 'current_minor',
      milestones: 'milestones', deadline: 'deadline', isActive: 'is_active',
      revokedContributionsMinor: 'revoked_contributions_minor',
    },
  },
  {
    api: 'sinkingFunds', table: 'sinking_funds',
    fields: {
      name: 'name', targetMinor: 'target_minor', monthlyMinor: 'monthly_minor', nextDue: 'next_due',
    },
  },
  {
    api: 'wishlist', table: 'wishlist',
    fields: {
      name: 'name', priceMinor: 'price_minor', finalPriceMinor: 'final_price_minor',
      boughtAt: 'bought_at', addedAt: 'added_at', coolingDays: 'cooling_days',
      coolingEndsAt: 'cooling_ends_at', status: 'status', aiAnalysis: 'ai_analysis',
      extendCount: 'extend_count', resolvedAt: 'resolved_at',
    },
  },
  {
    api: 'wishlistChats', table: 'wishlist_chats',
    json: ['messages', 'summary'],
    fields: {
      wishlistId: 'wishlist_id', messages: 'messages', status: 'status',
      summary: 'summary', updatedAt: 'updated_at',
    },
  },
  {
    api: 'debts', table: 'debts',
    fields: {
      name: 'name', remainingMinor: 'remaining_minor', aprXirr: 'apr_xirr',
      nextDue: 'next_due', strategy: 'strategy',
    },
  },
  {
    api: 'savingsRules', table: 'savings_rules',
    bool: ['enabled'],
    json: ['config'],
    fields: { type: 'type', config: 'config', enabled: 'enabled' },
  },
  {
    api: 'notificationLogs', table: 'notification_logs',
    fields: { type: 'type', sentAt: 'sent_at', status: 'status' },
  },
  {
    api: 'categories', table: 'categories',
    bool: ['is_default'],
    fields: { name: 'name', icon: 'icon', color: 'color', isDefault: 'is_default' },
  },
  {
    api: 'schedules', table: 'schedules',
    bool: ['notified'],
    fields: {
      name: 'name', type: 'type', amountMinor: 'amount_minor', date: 'date',
      repeat: 'repeat', note: 'note', notified: 'notified',
    },
  },
  {
    api: 'settings', table: 'settings', idCol: 'key',
    fields: { value: 'value' },
  },
  {
    api: 'balanceSnapshots', table: 'balance_snapshots',
    fields: {
      date: 'date', cashMinor: 'cash_minor', bankMinor: 'bank_minor',
      wechatMinor: 'wechat_minor', alipayMinor: 'alipay_minor',
      otherMinor: 'other_minor', liabilityMinor: 'liability_minor',
      note: 'note', createdAt: 'created_at',
    },
  },
  {
    api: 'commitments', table: 'commitments',
    fields: {
      text: 'text', targetCategory: 'target_category', targetMinor: 'target_minor',
      penaltyMinor: 'penalty_minor', deadline: 'deadline', status: 'status',
      createdAt: 'created_at', fulfilledAt: 'fulfilled_at',
    },
  },
  {
    api: 'moods', table: 'moods',
    fields: { date: 'date', mood: 'mood', note: 'note', createdAt: 'created_at' },
  },
  {
    api: 'consumerEvents', table: 'consumer_events',
    bool: ['is_impulse'],
    fields: {
      txId: 'tx_id', product: 'product', amountMinor: 'amount_minor', time: 'time',
      platform: 'platform', category: 'category', triggerType: 'trigger_type',
      riskScore: 'risk_score', isImpulse: 'is_impulse', aiNotes: 'ai_notes',
      createdAt: 'created_at', qualityScore: 'quality_score', feedbackStatus: 'feedback_status',
    },
  },
  {
    api: 'decisionRecords', table: 'decision_records',
    json: ['questions'],
    fields: {
      relatedType: 'related_type', relatedId: 'related_id', questions: 'questions',
      finalDecision: 'final_decision', createdAt: 'created_at',
    },
  },
  {
    api: 'behaviorProfiles', table: 'behavior_profiles',
    json: ['high_risk_windows', 'high_risk_categories'],
    fields: {
      nightRisk: 'night_risk', discountSensitivity: 'discount_sensitivity',
      repeatRisk: 'repeat_risk', impulseProbability: 'impulse_probability',
      delayedGratification: 'delayed_gratification',
      highRiskWindows: 'high_risk_windows', highRiskCategories: 'high_risk_categories',
      avgPurchaseQuality: 'avg_purchase_quality', lastUpdatedAt: 'last_updated_at',
    },
  },
  {
    api: 'insights', table: 'insights',
    bool: ['acknowledged'],
    fields: {
      type: 'type', content: 'content', evidence: 'evidence',
      relatedCategory: 'related_category', createdAt: 'created_at',
      acknowledged: 'acknowledged', sourceKey: 'source_key',
    },
  },
  {
    api: 'creditAccounts', table: 'credit_accounts',
    fields: {
      platform: 'platform', nickname: 'nickname', creditLimitMinor: 'credit_limit_minor',
      statementDay: 'statement_day', dueDay: 'due_day', graceDays: 'grace_days',
      minPayRatio: 'min_pay_ratio', rateType: 'rate_type', feeRate: 'fee_rate',
      createdAt: 'created_at',
    },
  },
  {
    api: 'creditStatements', table: 'credit_statements',
    bool: ['is_min_only'],
    fields: {
      accountId: 'account_id', period: 'period', statementDate: 'statement_date',
      dueDate: 'due_date', statementAmtMinor: 'statement_amt_minor',
      minPaymentMinor: 'min_payment_minor', paidAmtMinor: 'paid_amt_minor',
      principalRemMinor: 'principal_rem_minor', isMinOnly: 'is_min_only',
      status: 'status', createdAt: 'created_at',
    },
  },
  {
    api: 'installments', table: 'installments',
    fields: {
      accountId: 'account_id', txId: 'tx_id', totalPeriods: 'total_periods',
      currentPeriod: 'current_period', principalPerMinor: 'principal_per_minor',
      feePerMinor: 'fee_per_minor', realApr: 'real_apr', createdAt: 'created_at',
    },
  },
]

/** 单行：snake_case 数据库行 → camelCase（与前端 IndexedDB 记录一致） */
function rowToJson(cfg, row) {
  const rev = {}
  for (const [api, col] of Object.entries(cfg.fields)) rev[col] = api

  const out = {}
  // 主键列：默认 'id'，settings 表为 'key'
  const idCol = cfg.idCol || 'id'
  const idVal = row[idCol]
  // 确保写入 IndexedDB 前 id 一定有有效值（避免 bulkPut 报 "key path did not yield a value"）
  if (idVal !== undefined && idVal !== null && idVal !== '') {
    out.id = idVal
  }
  for (const [col, val] of Object.entries(row)) {
    const api = rev[col]
    if (!api || api === idCol) continue
    let v = val
    if (cfg.bool?.includes(col)) {
      // SQLite 0/1 → boolean（null 保持 null）
      v = val === null ? null : val ? true : false
    } else if (cfg.json?.includes(col) && typeof val === 'string') {
      try { v = JSON.parse(val) } catch { /* 非 JSON 文本，原样返回 */ }
    }
    out[api] = v
  }
  return out
}

export const syncRouter = Router()

// GET /api/sync/pull：全量导出所有业务表
syncRouter.get('/pull', (req, res, next) => {
  try {
    const data = {}
    let skipped = 0
    for (const cfg of TABLES) {
      const rows = db.prepare(`SELECT * FROM ${cfg.table}`).all()
      const list = []
      for (const row of rows) {
        const json = rowToJson(cfg, row)
        // 防御：无有效 id 的行跳过，避免前端 bulkPut 因 keyPath 无值而整体失败
        if (json.id === undefined) { skipped++; continue }
        list.push(json)
      }
      data[cfg.api] = list
    }
    if (skipped > 0) console.warn(`[sync] pull 跳过 ${skipped} 行缺少 id 的记录`)
    res.json({ success: true, data })
  } catch (e) { next(e) }
})

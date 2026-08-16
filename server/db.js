// SQLite 数据库
// 文件路径可用环境变量 DATA_DIR 指定（默认 server/data.sqlite）
import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { mkdirSync } from 'node:fs'

// 参与同步的业务表（与 sync.js 的 TABLES 保持一致，用于加 updated_at 迁移列）
const SYNC_TABLES = [
  'transactions', 'savings_goals', 'sinking_funds', 'wishlist', 'wishlist_chats',
  'debts', 'savings_rules', 'notification_logs', 'categories', 'schedules',
  'settings', 'balance_snapshots', 'commitments', 'moods', 'consumer_events',
  'decision_records', 'behavior_profiles', 'insights',
  'credit_accounts', 'credit_statements', 'installments',
  'knowledge_refs', 'feedback_logs', 'agent_inbox',
]

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// DATA_DIR 可以是目录（数据库放该目录下的 data.sqlite）或完整文件路径
function resolveDbPath() {
  const env = process.env.DATA_DIR
  if (!env) return path.join(__dirname, 'data.sqlite')
  if (env.endsWith('.sqlite') || env.endsWith('.db')) return env
  mkdirSync(env, { recursive: true })
  return path.join(env, 'data.sqlite')
}

const dbPath = resolveDbPath()
mkdirSync(path.dirname(dbPath), { recursive: true })

export const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')

/** 启动时创建表（幂等：CREATE TABLE IF NOT EXISTS） */
export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY, amount_minor INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT '', merchant TEXT NOT NULL DEFAULT '',
      time TEXT NOT NULL DEFAULT '', tx_type TEXT NOT NULL DEFAULT 'expense',
      payment_method TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual',
      impulse_score INTEGER NOT NULL DEFAULT 0, impulse_level TEXT NOT NULL DEFAULT 'low',
      is_revoked INTEGER NOT NULL DEFAULT 0, revoked_at TEXT,
      regret_value INTEGER, regret_at TEXT, import_id TEXT,
      note TEXT NOT NULL DEFAULT '', screenshot TEXT,
      funding_source TEXT, lien_account_id TEXT,
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS savings_goals (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '', image TEXT,
      target_minor INTEGER NOT NULL DEFAULT 0, current_minor INTEGER NOT NULL DEFAULT 0,
      milestones TEXT NOT NULL DEFAULT '[]', deadline TEXT,
      is_active INTEGER NOT NULL DEFAULT 0, revoked_contributions_minor INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS debts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
      remaining_minor INTEGER NOT NULL DEFAULT 0,
      apr_xirr REAL NOT NULL DEFAULT 0, next_due TEXT,
      strategy TEXT NOT NULL DEFAULT 'snowball'
    );
    CREATE TABLE IF NOT EXISTS credit_accounts (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL DEFAULT '',
      nickname TEXT NOT NULL DEFAULT '', credit_limit_minor INTEGER NOT NULL DEFAULT 0,
      statement_day INTEGER NOT NULL DEFAULT 1, due_day INTEGER NOT NULL DEFAULT 1,
      grace_days INTEGER NOT NULL DEFAULT 0, min_pay_ratio REAL NOT NULL DEFAULT 0.1,
      rate_type TEXT NOT NULL DEFAULT 'day_fee', fee_rate REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'other', amount_minor INTEGER NOT NULL DEFAULT 0,
      date TEXT NOT NULL DEFAULT '', repeat TEXT NOT NULL DEFAULT 'none',
      note TEXT NOT NULL DEFAULT '', notified INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT
    );
    CREATE TABLE IF NOT EXISTS wishlist (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
      price_minor INTEGER NOT NULL DEFAULT 0, final_price_minor INTEGER,
      bought_at TEXT, added_at TEXT NOT NULL DEFAULT '',
      cooling_days INTEGER NOT NULL DEFAULT 0, cooling_ends_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'cooling', ai_analysis TEXT,
      extend_count INTEGER, resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS balance_snapshots (
      id TEXT PRIMARY KEY, date TEXT NOT NULL DEFAULT '',
      cash_minor INTEGER NOT NULL DEFAULT 0, bank_minor INTEGER NOT NULL DEFAULT 0,
      wechat_minor INTEGER NOT NULL DEFAULT 0, alipay_minor INTEGER NOT NULL DEFAULT 0,
      other_minor INTEGER NOT NULL DEFAULT 0, liability_minor INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT '',
      target_category TEXT, target_minor INTEGER NOT NULL DEFAULT 0,
      penalty_minor INTEGER NOT NULL DEFAULT 0, deadline TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT '',
      fulfilled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS moods (
      id TEXT PRIMARY KEY, date TEXT NOT NULL DEFAULT '',
      mood TEXT NOT NULL DEFAULT 'calm', note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS consumer_events (
      id TEXT PRIMARY KEY, tx_id TEXT, product TEXT NOT NULL DEFAULT '',
      amount_minor INTEGER NOT NULL DEFAULT 0, time TEXT NOT NULL DEFAULT '',
      platform TEXT, category TEXT NOT NULL DEFAULT '',
      trigger_type TEXT NOT NULL DEFAULT '其他', risk_score INTEGER NOT NULL DEFAULT 0,
      is_impulse INTEGER NOT NULL DEFAULT 0, ai_notes TEXT,
      created_at TEXT NOT NULL DEFAULT '', quality_score INTEGER,
      feedback_status TEXT
    );
    CREATE TABLE IF NOT EXISTS behavior_profiles (
      id TEXT PRIMARY KEY, night_risk INTEGER NOT NULL DEFAULT 0,
      discount_sensitivity INTEGER NOT NULL DEFAULT 0, repeat_risk INTEGER NOT NULL DEFAULT 0,
      impulse_probability INTEGER NOT NULL DEFAULT 0, delayed_gratification INTEGER NOT NULL DEFAULT 0,
      high_risk_windows TEXT NOT NULL DEFAULT '[]', high_risk_categories TEXT NOT NULL DEFAULT '[]',
      avg_purchase_quality INTEGER, last_updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS insights (
      id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'pattern',
      content TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '',
      related_category TEXT, created_at TEXT NOT NULL DEFAULT '',
      acknowledged INTEGER NOT NULL DEFAULT 0, source_key TEXT
    );
    CREATE TABLE IF NOT EXISTS decision_records (
      id TEXT PRIMARY KEY, related_type TEXT NOT NULL DEFAULT '',
      related_id TEXT NOT NULL DEFAULT '', questions TEXT NOT NULL DEFAULT '[]',
      final_decision TEXT, created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS wishlist_chats (
      id TEXT PRIMARY KEY, wishlist_id TEXT NOT NULL DEFAULT '',
      messages TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'chatting',
      summary TEXT, updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS savings_rules (
      id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT '',
      config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS notification_logs (
      id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT '',
      sent_at TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#888888',
      is_default INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'asset', balance_minor INTEGER NOT NULL DEFAULT 0,
      is_locked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sinking_funds (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
      target_minor INTEGER NOT NULL DEFAULT 0, monthly_minor INTEGER NOT NULL DEFAULT 0,
      next_due TEXT
    );
    CREATE TABLE IF NOT EXISTS credit_statements (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL DEFAULT '',
      period TEXT NOT NULL DEFAULT '', statement_date TEXT NOT NULL DEFAULT '',
      due_date TEXT NOT NULL DEFAULT '', statement_amt_minor INTEGER NOT NULL DEFAULT 0,
      min_payment_minor INTEGER NOT NULL DEFAULT 0, paid_amt_minor INTEGER NOT NULL DEFAULT 0,
      principal_rem_minor INTEGER NOT NULL DEFAULT 0, is_min_only INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS installments (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL DEFAULT '',
      tx_id TEXT NOT NULL DEFAULT '', total_periods INTEGER NOT NULL DEFAULT 0,
      current_period INTEGER NOT NULL DEFAULT 0, principal_per_minor INTEGER NOT NULL DEFAULT 0,
      fee_per_minor INTEGER NOT NULL DEFAULT 0, real_apr REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS knowledge_refs (
      id TEXT PRIMARY KEY, category TEXT NOT NULL DEFAULT '',
      concept TEXT NOT NULL DEFAULT '', book TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '', thesis TEXT NOT NULL DEFAULT '',
      applicable_scenarios TEXT NOT NULL DEFAULT '[]',
      action_templates TEXT NOT NULL DEFAULT '[]',
      plain_explanation TEXT NOT NULL DEFAULT '', citation TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS feedback_logs (
      id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'negative', object_type TEXT NOT NULL DEFAULT '',
      object_id TEXT NOT NULL DEFAULT '', knowledge_ref_id TEXT,
      hypothesis TEXT NOT NULL DEFAULT '', opening TEXT NOT NULL DEFAULT '',
      pattern_key TEXT NOT NULL DEFAULT '', before_minor INTEGER NOT NULL DEFAULT 0,
      after_minor INTEGER, effect_status TEXT, effect_checked_at TEXT,
      rounds INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS agent_inbox (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'feedback_card',
      object_type TEXT NOT NULL DEFAULT '', object_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', opening TEXT NOT NULL DEFAULT '',
      knowledge_ref_id TEXT, feedback_log_id TEXT,
      scheduled_at TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      rounds INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT ''
    );
  `)
  // 迁移：为同步表补 updated_at 列（最后写入优先 LWW 用；已有库升级时自动补齐）
  for (const t of SYNC_TABLES) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name)
    if (!cols.includes('updated_at')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`)
    }
  }
  console.log('✅ SQLite 数据库表结构已就绪')
}
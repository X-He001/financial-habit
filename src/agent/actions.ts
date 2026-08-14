import { addWishlistItem, setSetting, getSetting } from '../db/crud'
import { db } from '../db/database'
import type { Transaction } from '../types'
import { isImpulsive } from '../utils/impulseEngine'
import type { ReviewMetrics } from './metrics'
import type { ReviewState } from './strategy'

// ==================== 本地工具 ====================

function pad2(n: number): string { return String(n).padStart(2, '0') }

function fmtYuan(minor: number): string {
  return (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 明日额度：取日均预算（四舍五入到10元，最低¥10） */
function tomorrowAllowance(m: ReviewMetrics): number {
  return Math.max(1000, Math.round(m.dailyAvgBudgetMinor / 100) * 100)
}

// ==================== 动作类型 ====================

export type ActionId =
  | 'lock_night_shopping'
  | 'add_to_wishlist'
  | 'lower_daily_limit'
  | 'freeze_nonsexpenditure'
  | 'set_platform_limit'
  | 'view_impulse_history'
  | 'remind_similar'

export interface ActionOutcome {
  message: string
  /** view_impulse_history：附带最近冲动记录列表（供面板内展示） */
  items?: { merchant: string; amountMinor: number; time: string }[]
}

/**
 * 动态动作：点击后真实执行（写 settings / 加欲望清单 / 查历史），
 * AI 只读，所有写入都由用户在复盘面板里点击这里的动作触发。
 */
export interface ReviewAction {
  id: ActionId
  label: string
  /** 给 LLM 看的说明（决定是否推荐） */
  description: string
  execute: (tx: Transaction, metrics: ReviewMetrics) => Promise<ActionOutcome>
}

// ==================== 动作实现 ====================

/** 1. 锁深夜购物：22:00-06:00 购物类记账二次确认 */
const lockNightShopping: ReviewAction = {
  id: 'lock_night_shopping',
  label: '🔒 锁深夜购物',
  description: '开启深夜消费二次确认：之后 22:00-06:00 的购物类记账必须二次确认',
  async execute() {
    await setSetting('nightLock', 'true')
    return { message: '已开启深夜消费二次确认：之后 22:00-06:00 的购物类记账会先弹一次确认，冷静一下再决定。' }
  },
}

/** 2. 放进欲望清单：名称=商家+金额，冷静期按冲动强度分档（1/2/3天） */
const addToWishlist: ReviewAction = {
  id: 'add_to_wishlist',
  label: '🧾 放进欲望清单',
  description: '把这笔冲动放进欲望清单，冷静期按冲动强度自动分档（高危3天/中危2天/低危1天）',
  async execute(tx, m) {
    const now = new Date()
    const coolingDays = m.impulseStrength >= 70 ? 3 : m.impulseStrength >= 50 ? 2 : 1
    const name = `${tx.merchant} ¥${fmtYuan(tx.amountMinor)}`
    await addWishlistItem({
      name,
      priceMinor: tx.amountMinor,
      addedAt: now.toISOString(),
      coolingDays,
      coolingEndsAt: new Date(now.getTime() + coolingDays * 86_400_000).toISOString(),
      status: 'cooling',
      aiAnalysis: null,
      finalPriceMinor: null,
      boughtAt: null,
    })
    return { message: `已把【${name}】放进欲望清单，冷静 ${coolingDays} 天后再决定买不买。` }
  },
}

/** 3. 下调明日额度：明日预算卡显示新额度（dailyLimitOverride = {amount, date}） */
const lowerDailyLimit: ReviewAction = {
  id: 'lower_daily_limit',
  label: '📉 下调明日额度',
  description: '把明天可花额度设为日均预算，明日预算卡会显示这个新额度',
  async execute(_tx, m) {
    const amountMinor = tomorrowAllowance(m)
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    await setSetting('dailyLimitOverride', JSON.stringify({ amountMinor, date: dateKeyOf(tomorrow) }))
    return { message: `明日消费额度已设为 ¥${fmtYuan(amountMinor)}（= 你的日均预算），明天首页预算卡会显示。` }
  },
}

/** 4. 冻结非必要支出3天：期间购物/娱乐/虚拟消费记账需确认 */
const freezeNonEssential: ReviewAction = {
  id: 'freeze_nonsexpenditure',
  label: '🧊 冻结非必要支出3天',
  description: '冻结购物/娱乐/虚拟消费3天，期间这类记账会弹确认',
  async execute() {
    const until = new Date()
    until.setDate(until.getDate() + 3)
    await setSetting('freezeNonEssential', 'true')
    await setSetting('freezeNonEssentialUntil', dateKeyOf(until))
    return { message: `已开启非必要支出冻结：到 ${dateKeyOf(until)} 前，购物/娱乐/虚拟消费记账会收到确认提醒。` }
  },
}

/** 5. 平台限额：该平台超限记账弹确认（platformLimit = JSON 数组 [{platform, amountMinor}]，多平台） */
const setPlatformLimit: ReviewAction = {
  id: 'set_platform_limit',
  label: '🎯 设置平台限额',
  description: '给当前平台设一个每日消费限额，超限记账会弹确认',
  async execute(_tx, m) {
    const p = m.platform
    if (!p) return { message: '没识别到平台，暂时无法设置限额。' }
    const amountMinor = tomorrowAllowance(m)
    // 读现有列表 → 同平台更新，否则追加
    const raw = await getSetting('platformLimit')
    let list: { platform: string; amountMinor: number }[] = []
    if (typeof raw === 'string' && raw) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          list = parsed.filter((x): x is { platform: string; amountMinor: number } =>
            x && typeof x.platform === 'string' && typeof x.amountMinor === 'number')
        } else if (parsed && typeof parsed.platform === 'string' && typeof parsed.amountMinor === 'number') {
          list = [{ platform: parsed.platform, amountMinor: parsed.amountMinor }]
        }
      } catch { /* 忽略损坏数据 */ }
    }
    const exist = list.findIndex(x => x.platform === p)
    if (exist >= 0) list[exist] = { platform: p, amountMinor }
    else list.push({ platform: p, amountMinor })
    await setSetting('platformLimit', JSON.stringify(list))
    return { message: `已为${p}设置每日限额 ¥${fmtYuan(amountMinor)}：今天在该平台超限记账时会弹确认。` }
  },
}

/** 6. 查看冲动历史：过去5次冲动记录（真实数据） */
const viewImpulseHistory: ReviewAction = {
  id: 'view_impulse_history',
  label: '📋 查看冲动历史',
  description: '展示最近5次冲动消费记录，看清自己的老毛病',
  async execute(tx) {
    const txs = await db.transactions.toArray()
    const list = txs
      .filter(t => isImpulsive(t.impulseLevel) && t.id !== tx.id)
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      .slice(0, 5)
      .map(t => ({ merchant: t.merchant, amountMinor: t.amountMinor, time: t.time }))
    return { message: '这是你过去 5 次冲动消费记录（不含今天这单）：', items: list }
  },
}

/** 7. 同类商品提醒：该分类下次记账提醒 */
const remindSimilar: ReviewAction = {
  id: 'remind_similar',
  label: '🔔 设置同类提醒',
  description: '之后记「同分类」消费时先弹一条温和提醒',
  async execute(tx) {
    await setSetting('similarReminder', tx.category)
    return { message: `已开启：之后记「${tx.category}」类消费时会先温和提醒你一句。` }
  },
}

// ==================== 动作池 ====================

const ACTION_MAP: Record<ActionId, ReviewAction> = {
  lock_night_shopping: lockNightShopping,
  add_to_wishlist: addToWishlist,
  lower_daily_limit: lowerDailyLimit,
  freeze_nonsexpenditure: freezeNonEssential,
  set_platform_limit: setPlatformLimit,
  view_impulse_history: viewImpulseHistory,
  remind_similar: remindSimilar,
}

/**
 * 按情境状态分配 2-3 个可执行动作（按钮由前端渲染，点击调用 execute）：
 * - low          → 放进欲望清单 / 查看冲动历史
 * - impulse      → 锁深夜购物 / 平台限额 / 同类提醒
 * - high_damage  → 下调明日额度 / 冻结非必要支出 / 放进欲望清单
 */
export function getActionPool(state: ReviewState, metrics: ReviewMetrics): ReviewAction[] {
  let ids: ActionId[]
  switch (state) {
    case 'low':
      ids = ['add_to_wishlist', 'view_impulse_history']
      break
    case 'impulse':
      ids = ['lock_night_shopping', 'set_platform_limit', 'remind_similar']
      break
    case 'high_damage':
      ids = ['lower_daily_limit', 'freeze_nonsexpenditure', 'add_to_wishlist']
      break
  }
  return ids
    .map(id => ACTION_MAP[id])
    .map(a => {
      // 平台限额的标签带上真实平台名
      if (a.id === 'set_platform_limit' && metrics.platform) {
        return { ...a, label: `🎯 设置${metrics.platform}限额` }
      }
      return a
    })
}

/** 按 id 取单个动作（供 LLM 推荐结果映射） */
export function getActionById(id: string): ReviewAction | undefined {
  return ACTION_MAP[id as ActionId]
}

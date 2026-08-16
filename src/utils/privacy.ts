// ==================== 隐私分层三档（AI 调用层脱敏，确认版） ====================
// 三档规则（代码注释即实现位置，勿偏离）：
//   档1 · 聚合数据（默认，日常分析走这档）
//     - 适用：AI 报告、周/月复盘、日常对话分析、agent 循环的观察/推理阶段
//     - 只传聚合统计：时段分布、平台分布、类别分布、金额分布、笔数、占比、趋势等
//     - 禁止：绝不传单笔交易的明细（商户名、备注、单笔金额明细列表）
//   档2 · 脱敏单笔（反馈/引用场景走这档）
//     - 适用：F5 反馈卡引用某一笔消费时、AI 对话中需要点名某笔消费时
//     - 金额/时间/类别保留，商户名/平台名/备注 → "某平台"/"某商户"（脱敏）
//   档3 · 完整单笔（仅用户主动要求时）
//     - 适用：用户明确问"我昨天那笔 88 的京东订单呢"这类主动查明细的请求
//     - 必须由用户主动发起查询；agent 循环和日常分析不得自动使用本档
//
// 判断"用户主动查单笔"：见 isActiveSingleTxQuery()，命中才允许降级到档3。

import type { PrivacyTier } from '../types'

export type { PrivacyTier }

/** 已知平台名（档2 脱敏时显示"某平台"） */
const PLATFORM_NAMES = [
  '拼多多', '京东', '淘宝', '抖音', '美团', '淘宝闪购', '饿了么', '天猫',
  '快手', '闲鱼', '小红书', '唯品会', '苏宁', '网易严选', '得物', '拼多多先用后付',
]

/** 场景默认档位：日常分析=档1（只传聚合）；反馈/引用=档2（脱敏单笔） */
export function defaultTierFor(scene: 'analysis' | 'feedback'): PrivacyTier {
  return scene === 'feedback' ? 2 : 1
}

/**
 * 判断"用户主动查单笔"（档3 触发条件，必须用户主动发起）。
 * 命中「那笔/这笔/订单/单子/明细/详情」等指向具体某一笔的表述即视为主动查明细；
 * agent 循环与日常分析不传用户文本，恒为 false，不会自动使用档3。
 */
export function isActiveSingleTxQuery(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  const markers = [
    '那笔', '这笔', '这一笔', '那一笔', '那单', '这单', '这单子', '那单子',
    '订单', '单子', '明细', '详情', '账目', '这笔账', '那笔账',
  ]
  return markers.some(m => t.includes(m))
}

/**
 * 档1/档2 脱敏：商家/平台名 → "某商户"/"某平台"；档3 原样返回。
 * kind 指定字段语义：merchant 一律"某商户"、platform 一律"某平台"；
 * 未指定（自由文本替换）时按名称是否含已知平台名自动判断。
 */
export function maskName(name: string, tier: PrivacyTier, kind?: 'merchant' | 'platform'): string {
  if (tier === 3 || !name) return name
  if (kind === 'merchant') return '某商户'
  if (kind === 'platform') return '某平台'
  const isPlatform = PLATFORM_NAMES.some(p => name.includes(p))
  return isPlatform ? '某平台' : '某商户'
}

/**
 * 对工具返回结果做脱敏（档1/档2）：
 * - 商户名（merchant/merchants）：档1/档2 都脱敏（单笔明细禁止出现商户名）
 * - 平台名（platform/platforms）：档1 保留（平台分布是允许的聚合统计）；档2 脱敏（点名某笔时平台也脱敏）
 * - 备注（note）：一律清空
 * - 自由文本字段里出现的已知名称：整体替换（档1 只换商户名，档2 商户+平台都换）
 * 档3 直接原样返回（用户主动查明细）。
 */
export function maskToolResult(
  value: unknown,
  tier: PrivacyTier,
  options: { collectNames?: string[] } = {}
): unknown {
  if (tier === 3) return value

  // 第一遍：收集结果里出现的商家/平台名（档2 同时收集平台名）
  const names = new Set<string>(options.collectNames ?? [])
  collectNamesFrom(value, tier, names)

  // 第二遍：递归脱敏
  return doMask(value, names, tier)
}

function collectNamesFrom(value: unknown, tier: PrivacyTier, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectNamesFrom(v, tier, out)
    return
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const [k, v] of Object.entries(obj)) {
      // 档1 只收集商户名（平台分布是允许的聚合统计）；档2 商户+平台名都收集
      if (k === 'merchant' || k === 'merchants' || (tier === 2 && (k === 'platform' || k === 'platforms'))) {
        if (typeof v === 'string' && v.trim()) out.add(v)
        else if (Array.isArray(v)) {
          for (const n of v) {
            if (typeof n === 'string' && n.trim()) out.add(n)
            else if (n && typeof n === 'object') collectNamesFrom(n, tier, out) // 嵌套对象（如 merchants:[{merchant,count,amount}]）
          }
        }
      } else if (k === 'paymentMethod' && typeof v === 'string') {
        // 档1/档2：支付方式（如"京东白条""拼多多先用后付"）里含平台名 → 提取平台子串一并脱敏，防平台名从支付方式泄露
        // （档1 单笔明细同样不得出现平台名；平台聚合字段 platforms 不在本分支，档1 保留）
        for (const p of PLATFORM_NAMES) if (v.includes(p)) out.add(p)
      } else {
        collectNamesFrom(v, tier, out)
      }
    }
  }
}

function doMask(value: unknown, names: Set<string>, tier: PrivacyTier): unknown {
  if (typeof value === 'string') {
    let s = value
    for (const n of names) {
      if (n && s.includes(n)) s = s.split(n).join(maskName(n, tier))
    }
    return s
  }
  if (Array.isArray(value)) return value.map(v => doMask(v, names, tier))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'merchant' || k === 'merchants') {
        // 商户字段：一律"某商户"（即使名称含平台前缀，如"京东·机械键盘"）；
        // 数组元素若是对象（如 merchants:[{merchant,count,amount}]）→ 递归处理其内部字段
        out[k] = Array.isArray(v)
          ? v.map(n => (typeof n === 'string' ? maskName(n, tier, 'merchant') : doMask(n, names, tier)))
          : typeof v === 'string' ? maskName(v, tier, 'merchant') : v
      } else if (k === 'note') {
        out[k] = '' // 备注必须脱敏：不向 AI 传递
      } else if (tier === 2 && (k === 'platform' || k === 'platforms')) {
        // 档2：平台字段一律"某平台"（数组元素为对象时同样递归）
        out[k] = Array.isArray(v)
          ? v.map(n => (typeof n === 'string' ? maskName(n, tier, 'platform') : doMask(n, names, tier)))
          : typeof v === 'string' ? maskName(v, tier, 'platform') : v
      } else {
        out[k] = doMask(v, names, tier)
      }
    }
    return out
  }
  return value
}

/** 统一的工具执行档位解析：调用方可覆盖；缺省按场景 + 用户文本判定 */
export function resolveTier(
  opts: { privacyTier?: PrivacyTier; scene?: 'analysis' | 'feedback'; userText?: string }
): PrivacyTier {
  if (opts.privacyTier) return opts.privacyTier
  // 用户主动查单笔明细 → 档3（完整单笔）
  if (opts.userText && isActiveSingleTxQuery(opts.userText)) return 3
  return defaultTierFor(opts.scene ?? 'analysis')
}

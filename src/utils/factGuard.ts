// ==================== 事实核查引擎（幻觉检测与不确定性标注） ====================
// 纯函数、零依赖，AI 总结生成链路（runLoop / runCoachTurn）收尾时调用。
//
// 设计原则（与全站"数字由代码算、AI 只组织语言"一致）：
// 1) 事实来源唯一：collectFacts 从"工具返回值 + 数据快照"里收集真实事实集
//    （金额/商家/平台/笔数/等级）。快照与工具返回是代码算出来的，天然可信。
// 2) 确定性核查：detectHallucinations 对 AI 输出做规则级比对——凡是输出里的
//    金额/商家/笔数在事实集里找不到，判定为"未核实"（疑似幻觉）。
// 3) 只标注不改写：applyUncertaintyMarks 给存疑内容加「⚠ 未核实」标注，
//    不删除 AI 内容（避免误伤正确信息），成本为零、误报可人工确认。
// 4) 分级：金额/0-100 分数泄漏 = 高置信；商家 = 中；笔数 = 低（仅报告不标注）。

export interface FactSet {
  /** 真实金额（元） */
  amounts: number[]
  /** 真实商家名 + 平台名 */
  merchants: string[]
  /** 真实笔数/次数 */
  counts: number[]
  /** 等级词（低/中/高/极高） */
  levels: string[]
  /** 快照文本中出现过的数字（白名单：如"财务健康分 85"，避免误报） */
  rawNumbers: number[]
  /** 实体级笔数（商家/平台 → 已知笔数）：如「拼多多」→[4]、「拼多多·零食大礼包」→[3] */
  merchantCounts: Record<string, number[]>
}

export type GuardSeverity = 'high' | 'medium' | 'low'

export interface GuardIssue {
  type: 'amount' | 'merchant' | 'count' | 'score'
  severity: GuardSeverity
  raw: string
  reason: string
}

const LEVEL_WORDS = ['低', '中', '高', '极高']

function yuan(n: number): number {
  return Math.round(n * 100) / 100
}

// ---- 字段名分类（用于从工具返回对象里挑出"金额/商家/笔数"） ----

function isAmountKey(k: string): boolean {
  return /amount|minor|spent|expense|budget|remaining|income|savings|debt|limit|total|sum|allowance/i.test(k)
}
function isMerchantKey(k: string): boolean {
  return /merchant|platform|shop/i.test(k)
}
function isCountKey(k: string): boolean {
  return /count|次数|笔数/i.test(k)
}

/**
 * 从工具返回值 + 数据快照文本里递归收集真实事实集。
 * - 金额字段带 "minor" 后缀的按"分"处理（÷100 转元），其余按"元"处理。
 * - 快照文本里的 ¥金额 / N 笔 / N 次 也会被收集（快照本身是代码算好的真实数字）。
 */
export function collectFacts(results: unknown[], opts: { texts?: string[] } = {}): FactSet {
  const amounts = new Set<number>()
  const merchants = new Set<string>()
  const counts = new Set<number>()
  const levels = new Set<string>()
  const rawNumbers = new Set<number>()
  const merchantCounts: Record<string, number[]> = {}

  const pushEntCount = (ent: string, n: number): void => {
    if (ent.length < 2 || !Number.isFinite(n) || n <= 0) return
    const arr = merchantCounts[ent] ?? (merchantCounts[ent] = [])
    if (!arr.includes(n)) arr.push(n)
  }

  const walk = (v: unknown, keyHint = ''): void => {
    if (v == null) return
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (isAmountKey(keyHint)) {
        amounts.add(yuan(v))
        if (/minor/i.test(keyHint)) amounts.add(yuan(v / 100))
      } else if (isCountKey(keyHint)) {
        counts.add(Math.round(v))
      }
      return
    }
    if (typeof v === 'string') {
      if (isMerchantKey(keyHint) && v.trim().length >= 2 && v.trim().length <= 30) merchants.add(v.trim())
      if (/level/i.test(keyHint) && LEVEL_WORDS.includes(v)) levels.add(v)
      // 工具返回的字符串（如事件 detail）里也含代码生成的真实金额（"预算 ¥400""设定限额 ¥80"）
      for (const m of v.matchAll(/¥\s*([\d,]+(?:\.\d+)?)/g)) {
        const n = parseFloat(m[1].replace(/,/g, ''))
        if (Number.isFinite(n)) amounts.add(yuan(n))
      }
      // 字符串里的实体级笔数："在「拼多多·零食大礼包」消费 3 笔"
      for (const m of v.matchAll(/在「([^」]{2,16})」[^，。；\n]{0,14}?(\d{1,2})\s*(?:笔|次|单)/g)) {
        pushEntCount(m[1].trim(), Number(m[2]))
      }
      return
    }
    if (typeof v === 'boolean') return
    if (Array.isArray(v)) {
      for (const x of v) walk(x, keyHint)
      return
    }
    if (typeof v === 'object') {
      const obj = v as Record<string, unknown>
      // 实体级笔数：同一对象里 商家/平台 + count 成对出现时收集（如 { platform:'拼多多', count:4 }）
      const entKey = Object.keys(obj).find(k => isMerchantKey(k) && typeof obj[k] === 'string')
      const cntKey = Object.keys(obj).find(k => k === 'count' && typeof obj[k] === 'number')
      if (entKey && cntKey) {
        pushEntCount((obj[entKey] as string).trim(), Math.round(obj[cntKey] as number))
      }
      for (const [k, x] of Object.entries(obj)) {
        walk(x, k === 'merchants' ? 'merchant' : k === 'platforms' ? 'platform' : k)
      }
    }
  }
  for (const r of results) walk(r, '')

  for (const t of opts.texts ?? []) {
    if (!t) continue
    for (const m of t.matchAll(/¥\s*([\d,]+(?:\.\d+)?)/g)) {
      const n = parseFloat(m[1].replace(/,/g, ''))
      if (Number.isFinite(n)) amounts.add(yuan(n))
    }
    for (const m of t.matchAll(/(\d+)\s*笔/g)) counts.add(Number(m[1]))
    for (const m of t.matchAll(/(\d+)\s*次/g)) counts.add(Number(m[1]))
    for (const m of t.matchAll(/（如：([^）]+)）/g)) {
      for (const s of m[1].split('、')) {
        const w = s.trim()
        if (w.length >= 2 && w.length <= 30) merchants.add(w)
      }
    }
    for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) rawNumbers.add(Number(m[0]))
  }

  return {
    amounts: [...amounts].sort((a, b) => a - b),
    merchants: [...merchants],
    counts: [...counts].sort((a, b) => a - b),
    levels: [...levels],
    rawNumbers: [...rawNumbers],
    merchantCounts,
  }
}

// ---- 输出文本预处理 ----

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
}

/** raw 出现位置之后是否已带「未核实」标注（已标注的跳过，避免重复） */
function alreadyMarked(text: string, at: number, raw: string): boolean {
  const tail = text.slice(at + raw.length, at + raw.length + 16)
  return /未核实|数据暂缺|暂缺/.test(tail)
}

// ---- 幻觉检测（规则层，确定性、零成本） ----

export function detectHallucinations(html: string, facts: FactSet): GuardIssue[] {
  const issues: GuardIssue[] = []
  const text = stripTags(html)
  const hasAmt = (n: number) => facts.amounts.some(a => Math.abs(a - n) <= 0.51)
  const hasCnt = (n: number) => facts.counts.some(c => c === n)
  const inWhitelist = (n: number) => facts.rawNumbers.includes(n)
  const hasMerchant = (m: string) =>
    facts.merchants.some(x => x === m || x.includes(m) || m.includes(x))

  // 1) 金额核查：¥ 数字必须能在事实集里找到（±0.51 容差覆盖 129.00 vs 129）
  for (const m of text.matchAll(/¥\s*([\d,]+(?:\.\d+)?)/g)) {
    const raw = m[0]
    const n = parseFloat(m[1].replace(/,/g, ''))
    if (!Number.isFinite(n)) continue
    if (alreadyMarked(text, m.index ?? 0, raw)) continue
    if (!hasAmt(n)) {
      issues.push({ type: 'amount', severity: 'high', raw, reason: `金额 ¥${n} 不在已核对数据中（可能编造）` })
    }
  }

  // 2) 0-100 分数泄漏：冲动/风险/强度/健康 + 分(可选) + 数字 + 分(可选)（快照白名单数字不算，如"财务健康分 85"）
  for (const m of text.matchAll(/(?:冲动|风险|强度|健康)(?:\s*分)?\s*[:：为是]?\s*(\d{1,3})(?:\s*分)?|\(\s*(\d{1,3})\s*分\)/g)) {
    const n = Number(m[1] ?? m[2])
    if (!Number.isFinite(n) || n < 0 || n > 100) continue
    if (inWhitelist(n)) continue
    if (alreadyMarked(text, m.index ?? 0, m[0])) continue
    issues.push({ type: 'score', severity: 'high', raw: m[0], reason: `0-100 分数 ${n} 不应展示给用户（只用等级词）` })
  }

  // 3) 商家/平台核查：被断言"买了/在X买了/「X」"的实体必须在事实集里
  const seenMerch = new Set<string>()
  const addMerchantIssue = (name: string, raw: string, at: number) => {
    if (seenMerch.has(name)) return
    seenMerch.add(name)
    if (hasMerchant(name)) return
    if (alreadyMarked(text, at, raw)) return
    issues.push({ type: 'merchant', severity: 'medium', raw, reason: `「${name}」不在已核对数据中（可能编造）` })
  }
  for (const m of text.matchAll(/在「([^」]{2,16})」/g)) addMerchantIssue(m[1], m[0], m.index ?? 0)
  for (const m of text.matchAll(/(?:买过|买了|消费过|下单了?|买了?)\s*「?([\u4e00-\u9fa5·]{2,16}?)」?/g)) {
    const w = m[1]
    // 过滤掉"数量+量词"式的误提取（如"买了4笔"）与带数字的碎片
    if (/\d/.test(w)) continue
    if (/笔|次|单|个|块|件|点|多$/.test(w)) continue
    addMerchantIssue(w, m[0], m.index ?? 0)
  }
  for (const m of text.matchAll(/在([\u4e00-\u9fa5]{2,8})买了/g)) addMerchantIssue(m[1], m[0], m.index ?? 0)

  // 4) 笔数核查：N 笔/次 需在事实集里。
  //    关联到具体实体（商家/平台）的笔数断言，必须与该实体已知笔数一致，
  //    避免"全局存在该数字就放行"（如快照有"很高 2 笔"，AI 却编造"5 天前买了 2 次"）。
  //    实体级不符 = 确定性错误（medium，展示「⚠ 未核实」标注）；无实体可绑定、全局也找不到 = low（仅报告不标注）。
  const entityCountsFor = (name: string): number[] => {
    // 先精确匹配（防止「拼多多·零食大礼包」被"拼多多"的分词规则误命中）
    const exact = facts.merchantCounts?.[name]
    if (exact && exact.length > 0) return exact
    for (const [ent, cs] of Object.entries(facts.merchantCounts ?? {})) {
      const parts = ent.split(/[·、]/).filter(p => p.length >= 2)
      if (parts.length > 0 && parts.every(p => name.includes(p))) return cs
    }
    return []
  }
  const entityNear = (idx: number, end: number): string | null => {
    const m = text.slice(0, idx).match(/「([^」]{2,16})」\s*[^，。；：\n]{0,14}$/)
    if (m) return m[1]
    const am = text.slice(end).match(/^[^，。；：\n]{0,2}?([\u4e00-\u9fa5]{2,8})/)
    return am ? am[1] : null
  }
  for (const m of text.matchAll(/(\d{1,2})\s*(?:笔|单|次)(?:消费|购买|购物|下单)?/g)) {
    const n = Number(m[1])
    if (!Number.isFinite(n) || n <= 0 || n > 60) continue
    if (alreadyMarked(text, m.index ?? 0, m[0])) continue
    if (hasCnt(n) || inWhitelist(n)) {
      // 全局计数命中，但若断言绑定已知实体且实体笔数不符 → 仍判为幻觉
      const ent = entityNear(m.index ?? 0, (m.index ?? 0) + m[0].length)
      const entCounts = ent ? entityCountsFor(ent) : []
      if (entCounts.length > 0 && !entCounts.includes(n)) {
        issues.push({
          type: 'count',
          severity: 'medium',
          raw: m[0],
          reason: `「${ent}」相关笔数 ${n} 与已核对数据不符（已知：${entCounts.join('、')}）`,
        })
      }
      continue
    }
    issues.push({ type: 'count', severity: 'low', raw: m[0], reason: `笔数/次数 ${n} 未能在已核对数据中找到依据` })
  }

  // 去重（同一 raw 可能同时命中多条规则）
  const seen = new Set<string>()
  return issues.filter(i => {
    const key = `${i.type}|${i.raw}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---- 不确定性标注：给存疑内容加「⚠ 未核实」标记（不改写原文） ----

const MARK_HTML =
  '<span style="display:inline-block;margin:0 2px;padding:0 5px;border-radius:4px;background:#FEF3C7;color:#B45309;font-size:11px;line-height:1.7;white-space:nowrap">⚠ 未核实</span>'

function markOnce(html: string, raw: string): string {
  const idx = html.indexOf(raw)
  if (idx === -1) return html
  const tail = html.slice(idx + raw.length, idx + raw.length + 16)
  if (/未核实/.test(tail)) return html // 已标注过
  return html.slice(0, idx + raw.length) + MARK_HTML + html.slice(idx + raw.length)
}

export interface GuardResult {
  html: string
  issues: GuardIssue[]
}

/** 对 AI 输出执行：检测 → 对 high/medium 存疑项加「未核实」标注。返回修正后的 HTML 与问题清单。 */
export function applyUncertaintyMarks(html: string, facts: FactSet): GuardResult {
  const issues = detectHallucinations(html, facts)
  let out = html
  for (const i of issues) {
    if (i.severity === 'low') continue // 笔数类置信低，只报告不标注，避免误伤
    out = markOnce(out, i.raw)
  }
  return { html: out, issues }
}

// ---- 渲染层兜底校正标注（Home / Report / AiChat 复用同一措辞，保证归一） ----

/** 「已由系统校正」统一标注短语：渲染层兜底校验发现 AI 输出与真实数据不符、由系统校正时展示 */
export const CORRECTED_BY_SYSTEM = '已由系统校正'

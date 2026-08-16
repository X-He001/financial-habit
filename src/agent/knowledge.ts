// ==================== 知识库（F5 7.2） ====================
// 检索式"图书馆"，不是触发式"触发器"：
//   旧版错误：数据 → 命中关键词 → 固定引用（模板）
//   正确方式：数据 → 推理 → 形成假设 → 到知识库检索概念 → 验证后生成反馈
//
// 职责：
// 1. 幂等写入 6 条内置知识条目（status=active）
// 2. searchKnowledge：基于 Agent 的推理语境做情境检索（概念/论点/场景语义打分，非关键词硬匹配）
// 3. 效果回查（⑩）反馈：同模式优先用 effective 角度、跳过 ineffective 角度
// 4. 防幻觉 L4：citation 绝不进正文；AI 科普必须能追溯到某条 active 知识
//
// 铁律：书/作者只存 citation 字段（"了解更多"折叠区），禁止出现在反馈正文。

import { db } from '../db/database'
import { getAllKnowledgeRefs, putKnowledgeRef, getAllFeedbackLogs } from '../db/crud'
import type { KnowledgeRef } from '../types'

/** 内置 6 条知识（F5 7.2 指定书目） */
const SEED_REFS: Omit<KnowledgeRef, 'id' | 'updatedAt'>[] = [
  {
    category: '犹豫合理化',
    concept: '犹豫合理化',
    book: '《Predictably Irrational》',
    author: 'Dan Ariely',
    thesis: '人想买一样东西时，会下意识给自己找理由（"我等了很久""早晚要买"），让冲动消费显得合理。',
    applicable_scenarios: ['犹豫了几天/几周最后还是买了', '冷静期结束后仍选择购买', '买之前给自己找一堆理由', '买了之后觉得"其实也没那么需要"'],
    action_templates: [
      '下次想买时先问自己"不买会损失什么？"，答不上来说明可能不是真需要',
      '把"找理由"的过程写下来，回头看看理由是不是临时编的',
    ],
    plain_explanation: '人想买一样东西时，大脑会下意识帮冲动找理由——"我等了这么久""早晚都要买"。心理学发现，这种"找理由"其实是大脑在帮冲动买单，让你觉得花得有理。',
    citation: '《Predictably Irrational》Dan Ariely',
    status: 'active',
  },
  {
    category: '情绪渴望',
    concept: '情绪/渴望回路',
    book: '《Unwinding Anxiety》',
    author: 'Judson Brewer',
    thesis: '压力、焦虑等情绪会触发"渴望 → 消费 → 短暂缓解 → 渴望加深"的回路；觉察触发点本身就能打断回路。',
    applicable_scenarios: ['压力大时想买东西放松', '深夜情绪性购物', '焦虑时反复刷购物App', '心情不好就花钱'],
    action_templates: [
      '压力大的时候，购物之外先试 10 分钟别的（喝水/散步/深呼吸）',
      '记录触发点：按下单键前那一刻，你在想什么、感受什么',
    ],
    plain_explanation: '压力大的时候想买东西放松，这很常见——大脑在压力时会找即时的缓解，购物就是其中一种。先停下来觉察"我现在是什么感觉"，往往就能打断这个回路。',
    citation: '《Unwinding Anxiety》Judson Brewer',
    status: 'active',
  },
  {
    category: '习惯身份',
    concept: '习惯/身份',
    book: '《Atomic Habits》',
    author: 'James Clear',
    thesis: '行为改变来自身份认同——"我是一个会规划的人"比"我要忍住"更有力。',
    applicable_scenarios: ['反复在同一场景消费', '想培养储蓄/克制的习惯', '需要身份标签强化改变', '同类消费反复发生'],
    action_templates: [
      '把自己当成"会规划的人"，每天做一件符合这个身份的小事',
      '给要培养的习惯安排固定的环境提示（如把想买的东西先写进清单）',
    ],
    plain_explanation: '改变消费习惯，关键不在"我要忍住"，而在"我是什么样的人"。当你把自己看作一个会先想清楚再花钱的人，行为会自然跟着变。',
    citation: '《Atomic Habits》James Clear',
    status: 'active',
  },
  {
    category: '稀缺限时',
    concept: '稀缺/限时',
    book: '《Mind Over Money》',
    author: 'Brad Klontz',
    thesis: '"限时折扣""仅剩X件"制造稀缺感，会让人忽略真实需求，被紧迫感推着下单。',
    applicable_scenarios: ['看到限时折扣就想买', '害怕错过优惠', '直播/秒杀场景', '优惠倒计时'],
    action_templates: [
      '遇到限时优惠先离开页面 10 分钟，问自己"不买会损失什么"',
      '把想买的放进欲望清单，等冷静期过了再看是否还想要',
    ],
    plain_explanation: '"仅剩3件""今晚截止"是商家制造稀缺感的手段——它激活的不是你的需求，而是"怕错过"的紧迫感。离开那个页面，往往就没那么想要了。',
    citation: '《Mind Over Money》Brad Klontz',
    status: 'active',
  },
  {
    category: '资产负债',
    concept: '资产vs负债',
    book: '《富爸爸穷爸爸》',
    author: 'Robert Kiyosaki',
    thesis: '资产是往口袋装钱的东西，负债是从口袋掏钱的东西；先分清"买的是资产还是负债"再决定。',
    applicable_scenarios: ['大额消费决策', '借钱/分期消费', '分不清想要和需要', '买之前想确认值不值'],
    action_templates: [
      '下单前问：这东西会帮我赚钱/省钱，还是持续花我的钱？',
      '把持续产生的花费（会员、分期利息）算进真实价格',
    ],
    plain_explanation: '简单说：资产往你口袋装钱，负债从你口袋掏钱。买东西前问一句"它以后是帮我省钱，还是继续花我的钱"，答案就清楚了。',
    citation: '《富爸爸穷爸爸》Robert Kiyosaki',
    status: 'active',
  },
  {
    category: '储蓄金鹅',
    concept: '储蓄/金鹅',
    book: '《小狗钱钱》',
    author: 'Bodo Schäfer',
    thesis: '储蓄像养一只下金蛋的鹅——先把一部分钱"喂养"鹅，而不是全花光。',
    applicable_scenarios: ['存不下钱', '想建立储蓄习惯', '收入一到手就想花完', '月光'],
    action_templates: [
      '收入到账先存固定比例（如 10%），剩下的才是可花的',
      '设一个"金鹅账户"，只进不出',
    ],
    plain_explanation: '储蓄就像养一只下金蛋的鹅——你每次存下一笔，鹅就长大一点，未来能"下蛋"（利息和安全感）。先喂鹅，再花剩下的。',
    citation: '《小狗钱钱》Bodo Schäfer',
    status: 'active',
  },
]

/** 幂等写入内置知识库（表空才写入，避免覆盖云端已合并的数据） */
export async function ensureKnowledgeSeeded(): Promise<void> {
  try {
    if ((await db.knowledgeRefs.count()) > 0) return
    const now = new Date().toISOString()
    for (const seed of SEED_REFS) {
      await putKnowledgeRef({ id: `k_${seed.concept}`, ...seed, updatedAt: now })
    }
    console.log('✅ 知识库内置 6 条已就绪')
  } catch {
    // 数据库未就绪等场景静默，下次再试
  }
}

// ==================== 情境检索（⑤） ====================

/** 把中文文本切成可用于打分的词元（2-gram 重叠 + 关键词） */
function tokensOf(text: string): string[] {
  const clean = text.replace(/[，。！？、；：""''（）()\s]/g, '')
  const grams: string[] = []
  for (let i = 0; i < clean.length - 1; i++) grams.push(clean.slice(i, i + 2))
  return grams
}

function overlap(a: string[], b: string[]): number {
  const set = new Set(b)
  let hit = 0
  for (const t of a) if (set.has(t)) hit++
  return hit
}

export interface KnowledgeHit {
  ref: KnowledgeRef
  /** 情境相关性分（越高越匹配 Agent 的推理语境） */
  score: number
  /** 历史同模式反馈效果（effective=优先 / ineffective=降权 / null=无记录） */
  effect: 'effective' | 'ineffective' | null
}

/**
 * 情境检索：用 Agent 的假设/语境检索概念，不是关键词硬匹配。
 * 打分维度：
 *   - 语境 vs 适用场景的 2-gram 重叠
 *   - 语境 vs 论点/科普文案的 2-gram 重叠
 *   - 语境包含概念名/类别名则加权
 * 效果回查（⑩）反馈：同一模式若有 effective 历史优先、ineffective 降权。
 * 返回按分降序的命中列表（由 Agent 自己决定翻哪本书，不自动替它选）。
 */
export async function searchKnowledge(
  context: string,
  options: { limit?: number; patternKey?: string | null } = {}
): Promise<KnowledgeHit[]> {
  const [refs, logs] = await Promise.all([getAllKnowledgeRefs(), getAllFeedbackLogs()])
  const active = refs.filter(r => r.status === 'active')

  // 效果回查反馈：同 patternKey 的反馈 → 记住 effective/ineffective 角度
  const effectByRef = new Map<string, 'effective' | 'ineffective'>()
  if (options.patternKey) {
    const relevant = logs.filter(l => l.patternKey === options.patternKey && l.effectStatus)
    for (const l of relevant) {
      if (!l.knowledgeRefId) continue
      // 最近一次效果为准
      effectByRef.set(l.knowledgeRefId, l.effectStatus as 'effective' | 'ineffective')
    }
  }

  const ctxTokens = tokensOf(context)
  const scored: KnowledgeHit[] = active.map(ref => {
    const sceneTokens = tokensOf(ref.applicable_scenarios.join(' '))
    const thesisTokens = tokensOf(ref.thesis + ' ' + ref.plain_explanation)
    let score = overlap(ctxTokens, sceneTokens) * 2 + overlap(ctxTokens, thesisTokens)
    // 语境直接提到概念名/类别名 → 强加权
    if (context.includes(ref.concept) || context.includes(ref.category)) score += 10
    // 历史效果：effective +2，ineffective -3（下次同类场景优先 effective 角度）
    const effect = effectByRef.get(ref.id) ?? null
    if (effect === 'effective') score += 2
    if (effect === 'ineffective') score -= 3
    return { ref, score, effect }
  })
  scored.sort((a, b) => b.score - a.score)
  const limit = Math.max(1, options.limit ?? 3)
  return scored.slice(0, limit).filter(h => h.score > 0)
}

/** 按 id 取知识条目（反馈循环 ⑤ 命中后引用） */
export async function getKnowledgeRef(id: string): Promise<KnowledgeRef | undefined> {
  return db.knowledgeRefs.get(id)
}

// ==================== 防幻觉 L4：知识断言比对 ====================

export interface KnowledgeGuardIssue {
  kind: 'citation_leak' | 'unknown_concept'
  detail: string
}

/**
 * 防幻觉 L4（知识事实库比对）：AI 输出中的科普断言必须可追溯、且出处不进正文。
 * - citation_leak：正文（剥离「了解更多」折叠区后）出现了书名/作者（出处只允许在折叠区）
 * - 引用概念必须来自 active 知识库；无法归属任何条目的"科普断言"打标
 */
export function guardKnowledgeDiscipline(html: string, usedRefs: KnowledgeRef[]): KnowledgeGuardIssue[] {
  const issues: KnowledgeGuardIssue[] = []
  // 「了解更多」折叠区是出处唯一合法位置：先剥掉 <details>…</details>，只检查正文
  const body = html.replace(/<details[\s\S]*?<\/details>/gi, '')
  for (const ref of usedRefs) {
    // 书名/作者出现在正文（非折叠区）→ 出处泄露
    const bookName = ref.book.replace(/《|》/g, '')
    if ((bookName && body.includes(bookName)) || (ref.author && body.includes(ref.author))) {
      issues.push({ kind: 'citation_leak', detail: `正文出现了出处「${ref.book} ${ref.author}」` })
    }
  }
  // 正文引用了概念名但对应知识条目不在已用列表 → 未核实概念（弱提示，不阻断）
  for (const ref of usedRefs) {
    if (ref.status !== 'active') {
      issues.push({ kind: 'unknown_concept', detail: `引用未激活概念「${ref.concept}」` })
    }
  }
  return issues
}

/** 供 prompt 拼接的"知识库目录"（告诉 Agent 有哪几本"书"可翻，不替它选） */
export function knowledgeCatalogText(refs: KnowledgeRef[]): string {
  if (refs.length === 0) return '（知识库为空）'
  return refs
    .map(r => `- ${r.concept}：${r.thesis}（适用：${r.applicable_scenarios.join(' / ')}）`)
    .join('\n')
}

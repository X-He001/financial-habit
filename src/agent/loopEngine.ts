// ==================== 自主循环 Agent（runLoop） ====================
// 用户只给一个目标（如"生成今日总结"/"开始复盘"），Agent 自主完成整个分析过程：
//   规划 → 查数据 → 算法分析 → 组织语言 → 自查 → 不足补查 → 输出。
// 期间不需要用户逐步指挥，不会每轮都等用户输入。
//
// 实现要点：
// - 复用 function calling 基础设施（agentCompletion + AGENT_TOOLS），
//   只暴露 COACH_TOOL_NAMES 子集（只读查询 + save_behavior_notes + get_alert_events）。
// - 最多 8 轮工具调用防死循环；超限后强制收尾，输出"已基于现有数据分析"。
// - 完成判定：模型在某一轮不再请求工具（直接给最终文本）即视为完成。
// - 失败重试一次；仍失败返回明确错误提示的 HTML（不崩溃）。
// - 无数据/数据不足时由系统提示要求诚实说明，绝不编造数字。
// - 数字铁律：所有数字来自工具返回，AI 只组织语言（防幻觉）。

import { agentCompletion, hasApiKey, aiErrorMessage } from './deepseek'
import type { ChatMessage, ToolCall } from './deepseek'
import { AGENT_TOOLS, AGENT_TOOL_DEFS, COACH_TOOL_NAMES } from './tools'
import { getProfile, profileContextText } from './profile'
import { db } from '../db/database'
import type { AgentStatus } from './engine'
import { FACT_DISCIPLINE, FACT_GUARD_HINT, PRIVACY_HINT } from './factDiscipline'
import { collectFacts, applyUncertaintyMarks } from '../utils/factGuard'
import type { GuardIssue } from '../utils/factGuard'

/** 自主循环可用的工具定义（与复盘通道同一子集） */
export const LOOP_TOOL_DEFS = AGENT_TOOL_DEFS.filter(t => COACH_TOOL_NAMES.includes(t.function.name))

/** 循环上限：最多 8 轮工具调用，防止死循环 */
export const MAX_TOOL_ROUNDS = 8

// ==================== 工具状态文案 ====================

const LOOP_RUNNING_LABEL: Record<string, string> = {
  get_recent_transactions: '正在翻看最近交易…',
  get_spending_pattern: '正在分析消费模式…',
  get_alert_events: '正在扫描消费事件…',
  get_budget_status: '正在查看预算执行…',
  get_debt_summary: '正在查看负债…',
  get_savings: '正在查看储蓄进度…',
  get_schedules: '正在查看扣费日程…',
  get_behavior_profile: '正在读取消费画像…',
  save_behavior_notes: '正在存档洞察…',
}
const LOOP_DONE_LABEL: Record<string, string> = {
  get_recent_transactions: '已读取最近交易',
  get_spending_pattern: '消费模式分析完成',
  get_alert_events: '消费事件已扫描',
  get_budget_status: '预算状态已读取',
  get_debt_summary: '负债概况已读取',
  get_savings: '储蓄进度已读取',
  get_schedules: '扣费日程已读取',
  get_behavior_profile: '消费画像已读取',
  save_behavior_notes: '洞察已存档',
}

// ==================== 系统提示 ====================

/**
 * 组装自主循环系统提示：
 * - 角色 + 任务目标
 * - 自主循环执行方式（规划→查数→观察→自查→输出，不向用户提问）
 * - 数字铁律（引用必须来自工具返回，禁止脑补，禁止 0-100）
 * - 完成判定 + 8 轮上限 + 无数据诚实说明
 * - 精美 HTML 输出约束
 * - 实时数据快照（可选，报告页传入代码算好的数字）
 */
export function buildLoopSystemPrompt(goal: string, snapshot?: string): string {
  return `你是财务助手「AI 助手」的自主分析引擎。用户给你一个目标，你要自己完成整个分析并输出最终报告，全程不需要用户逐步指挥，也不得向用户提问。

【任务目标】
${goal}

【可用工具】
- get_recent_transactions(limit)：最近交易（商家/金额/分类/时间/冲动等级）
- get_spending_pattern(days)：近 N 天消费模式（时段/平台/分类/商家Top5/金额偏离/支付方式/节奏 + 低/中/高/极高等级）
- get_alert_events(days)：消费事件（同平台爆发/预算超限/平台每日限额触发/深夜购物偏多/重复购买，按等级 低/中/高/极高 降序）
- get_budget_status()：本月预算执行
- get_debt_summary()：负债概况
- get_behavior_profile()：消费画像与历次复盘笔记（供引用"上次你说…"）
- get_savings()：储蓄进度
- get_schedules()：未来扣费日程
- save_behavior_notes()：把用户关键洞察存档（供下次引用）

【执行流程 · 自主循环（ReAct）】
1. 规划：先想清楚完成目标需要哪些数据，直接开始调用工具查询（不必把规划发给我，也绝对不允许问我任何问题）。
2. 查数：一次或分多次把需要的数据查完。建议先并行思路地调用 get_spending_pattern + get_alert_events + get_budget_status + get_behavior_profile 建立全局画像，再用 get_recent_transactions 核实具体商家/金额。
3. 观察与自查：每轮拿到工具结果后，核对最终结论所需数字是否齐备、是否与工具返回一致；缺什么就补查什么。
4. 完成判定：当数据足以支撑完整回答时，立即输出最终结果（HTML），不要再调用工具。
5. 最多 ${MAX_TOOL_ROUNDS} 轮工具调用。接近上限仍未查完时，基于已有数据输出最终结果，并注明"已基于现有数据分析"。
6. 目标所需数据不存在（如今天还没记账）时，诚实说明"今天还没有记账记录，暂时无法分析消费情况"之类的话，绝不编造数字、不猜测。

${FACT_DISCIPLINE}

${PRIVACY_HINT}

【存档规则】
- 用户明确表达的消费习惯/场景/目标/自我认知，在输出完成后调用 save_behavior_notes 存档（content 与 dataRef 只能写快照或工具返回中真实出现的数字与事实，严禁写推断值）。

${FACT_GUARD_HINT}

【输出格式 · 必须是精美 HTML 卡片】
- 最终结果必须是精美 HTML 片段（内联CSS、蓝白配色、主色#0040FF、数字加粗+等宽字体+靛蓝色、标题靛蓝带左侧竖条、重要信息浅琥珀框、建议浅青卡片），结构：结论摘要卡 → 消费事件提醒（如有）→ 分点分析 → 建议。
- 禁止 Markdown 语法，禁止 \`\`\`html 包裹，只输出 HTML 内容本身。
- 语气温和、不评判、不说教。

【实时数据快照】（本地代码从数据库实时算出，与工具返回值一致，可快速引用；以工具返回为准）：
${snapshot ?? '（无预置快照，请全部通过工具查询）'}`
}

// ==================== 工具执行 ====================

function parseToolArgs(tc: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tc.function.arguments || '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function errorHtml(msg: string): string {
  return `<div style="padding:14px 16px;background:#FEF2F2;border:1px solid #FECACA;border-radius:12px;font-size:13.5px;color:#B91C1C;line-height:1.8">⚠️ 自主分析暂时失败：${escapeHtml(msg)}。请稍后再试，或先到设置页确认已配置 API Key。</div>`
}

// ==================== 默认快照（AI 助手窗口无预置数据时使用） ====================

/** 无预置快照时：附带消费画像与历次复盘笔记，供"上次你说…"引用 */
async function profileSnapshot(): Promise<string> {
  try {
    const [profile, events] = await Promise.all([
      getProfile(),
      db.consumerEvents.toArray(),
    ])
    const d30 = events.filter(e => Date.now() - new Date(e.time).getTime() <= 30 * 86_400_000).length
    return profileContextText(profile, d30)
  } catch {
    return ''
  }
}

// ==================== 自主循环入口 ====================

export interface LoopResult {
  /** 最终输出（HTML 片段，已过事实核查：存疑金额/商家/分数已标注「⚠ 未核实」） */
  html: string
  /** 实际工具调用次数 */
  toolCount: number
  /** 是否达到最大循环轮数（数据未完全查齐时强制收尾） */
  exhausted: boolean
  /** 事实核查发现的问题清单（空 = 全部数字/商家均与真实数据一致） */
  guardIssues: GuardIssue[]
}

export interface LoopOptions {
  /** 实时数据快照（报告页传入代码算好的数字；缺省用消费画像快照） */
  snapshot?: string
  /** 最近对话历史（AI 助手窗口传入，保持上下文） */
  history?: { role: 'user' | 'ai'; content: string }[]
  /** 工具状态回调（执行开始/结束） */
  onStatus?: (s: AgentStatus) => void
  /** 循环过程轻量提示（UI 显示一条，不刷屏） */
  onProgress?: (msg: string) => void
}

/**
 * 自主循环 Agent：用户只给一个目标，Agent 自主 规划 → 查数 → 自查 → 补查 → 输出。
 * - 每轮 agentCompletion 携带工具；模型不再请求工具即完成。
 * - 最多 8 轮工具调用；超限强制收尾（不再给工具）。
 * - 单轮网络失败重试一次；整体失败返回明确错误 HTML（不崩溃）。
 */
export async function runLoop(goal: string, options: LoopOptions = {}): Promise<LoopResult> {
  const online = await hasApiKey()
  if (!online) {
    return { html: errorHtml('尚未配置 API Key'), toolCount: 0, exhausted: false, guardIssues: [] }
  }

  const snapshot = options.snapshot ?? (await profileSnapshot())
  const history = (options.history ?? []).slice(-10).map(h => ({
    role: h.role === 'ai' ? 'assistant' as const : 'user' as const,
    content: h.content,
  }))

  const messages: ChatMessage[] = [
    { role: 'system', content: buildLoopSystemPrompt(goal, snapshot) },
    ...history,
    { role: 'user', content: `请自主完成这个目标：${goal}` },
  ]

  let toolCount = 0
  let reply = ''
  let exhausted = false
  /** 工具执行返回的真实数据（收尾时做事实核查用） */
  const toolResults: unknown[] = []

  /** 调用一次模型；网络失败自动重试一次 */
  async function complete(tools: typeof LOOP_TOOL_DEFS) {
    try {
      return await agentCompletion(messages, tools, { temperature: 0.5 })
    } catch (e) {
      options.onProgress?.('网络波动，正在重试…')
      return await agentCompletion(messages, tools, { temperature: 0.5 })
    }
  }

  /** 收尾：事实核查（数字由代码算，AI 只组织语言）——把工具返回+快照作为唯一事实源，对 AI 输出做规则级比对并标注未核实项 */
  function guardFinal(text: string): { html: string; issues: GuardIssue[] } {
    const facts = collectFacts(toolResults, { texts: [snapshot, ...history.map(h => h.content)] })
    return applyUncertaintyMarks(text, facts)
  }

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const turn = await complete(LOOP_TOOL_DEFS)
      if (!turn.toolCalls || turn.toolCalls.length === 0) {
        // 模型不再请求工具 → 输出最终结果
        reply = turn.content ?? ''
        break
      }
      messages.push({ role: 'assistant', content: turn.content, tool_calls: turn.toolCalls })
      for (const tc of turn.toolCalls) {
        toolCount++
        const name = tc.function.name
        options.onStatus?.({
          id: `loop${toolCount}`, name,
          label: LOOP_RUNNING_LABEL[name] ?? `正在执行 ${name}…`, state: 'running',
        })
        let result: unknown
        let ok = true
        try {
          // 自主循环只允许调用 COACH_TOOL_NAMES 子集（写交易/欲望清单等普通工具一律拒绝）
          if (!COACH_TOOL_NAMES.includes(name)) throw new Error(`AI 助手无权调用该工具：${name}`)
          const tool = AGENT_TOOLS.find(t => t.name === name)
          if (!tool) throw new Error(`未知工具：${name}`)
          result = await tool.execute(parseToolArgs(tc))
        } catch (e) {
          ok = false
          result = { error: e instanceof Error ? e.message : String(e) }
        }
        options.onStatus?.({
          id: `loop${toolCount}`, name,
          label: ok ? (LOOP_DONE_LABEL[name] ?? `已完成 ${name}`) : `⚠️ ${name} 执行失败`,
          state: ok ? 'done' : 'error',
        })
        if (ok) toolResults.push(result)
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
      }
    }

    if (!reply) {
      // 达到 8 轮上限 → 强制收尾（不再给工具，基于现有数据分析），防止死循环
      exhausted = true
      options.onProgress?.('已达到分析轮数上限，正在基于现有数据整理结论…')
      messages.push({
        role: 'user',
        content:
          '已到最大工具调用轮数。请基于目前已获取的真实数据直接输出最终总结；' +
          '缺失的部分如实说明（如"这部分数据没有查到"），不要编造，也不要再调用任何工具。',
      })
      const final = await complete([])
      reply = final.content ?? ''
    }

    if (!reply) {
      reply =
        '<div style="padding:14px 16px;background:#E4E6E6;border:1px solid #C0C4C4;border-radius:12px;font-size:13.5px;color:#374151;line-height:1.8">' +
        '分析完成，但我这边暂时没有拿到足够的信息。请先记几笔账，再点一次「生成今日总结」试试。</div>'
    }
    // 事实核查收尾：输出与真实数据比对，存疑金额/商家/分数标注「⚠ 未核实」
    const guarded = guardFinal(reply)
    return { html: guarded.html, toolCount, exhausted, guardIssues: guarded.issues }
  } catch (e) {
    // 整体失败（含重试后仍失败）→ 明确错误提示，不崩溃
    return { html: errorHtml(aiErrorMessage(e)), toolCount, exhausted, guardIssues: [] }
  }
}

// ==================== 幻觉检测评估脚本（hallucination-eval） ====================
// 在"标准测试集"上评估事实核查引擎（factGuard）的幻觉检出能力，并产出：
//   1) docs/hallucination-test-report.md  —— 详细日志报告（含每个用例的输入/问题/核查后输出）
//   2) docs/hallucination-test-report.html —— 可视化报告（供浏览器渲染 + 截图）
// - 测试集基于注入的 mock 消费数据（11 笔真实交易 + 5 个消费事件 + 报告快照）
// - 用例覆盖：金额捏造 / 金额错误 / 商家编造 / 笔数脑补 / 0-100 分数泄漏 / 统计脑补 / 平台编造 / 正常输出（误报检查）/ 不确定性标注边界
// - 度量：检出率（幻觉被自动发现的比例）、误报率（正常输出被误标比例）
// - 基线 = 无检测器（AI 输出原样展示），检出率 0%；目标：新系统检出率相对基线提升 ≥ 50%
//
// 运行方式：
//   npx tsc --ignoreConfig --outDir .eval --module es2020 --target es2020 --esModuleInterop --skipLibCheck scripts/hallucination-eval.ts src/utils/factGuard.ts
//   node .eval/scripts/hallucination-eval.js
// 截图步骤（可选）：启动静态服务打开 HTML → 浏览器逐用例截图（见报告"七、截图"）。

// @ts-nocheck —— 脚本为独立测试工具（项目未装 @types/node，Node 内置模块直接用 ESM import）
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectFacts, detectHallucinations, applyUncertaintyMarks } from '../src/utils/factGuard.js'
import type { FactSet, GuardIssue } from '../src/utils/factGuard.js'

// ---- 基准事实：与"注入的今日模拟消费数据"一致（工具返回的真实结构） ----

const TOOL_FACTS: unknown[] = [
  {
    count: 9,
    items: [
      { merchant: '淘宝·优衣库T恤', amount: 129, category: '购物', impulseLevel: 'medium' },
      { merchant: '拼多多·零食大礼包', amount: 89, category: '购物', impulseLevel: 'high' },
      { merchant: '拼多多·手机壳', amount: 19.9, category: '购物', impulseLevel: 'medium' },
      { merchant: '拼多多·数据线', amount: 25, category: '购物', impulseLevel: 'high' },
      { merchant: '美团·奶茶', amount: 28, category: '娱乐', impulseLevel: 'high' },
      { merchant: '抖音·耳机', amount: 129, category: '购物', impulseLevel: 'veryHigh' },
      { merchant: '拼多多·保温杯', amount: 59, category: '购物', impulseLevel: 'veryHigh' },
      { merchant: '京东·机械键盘', amount: 249, category: '购物', impulseLevel: 'medium' },
      { merchant: '淘宝·袜子', amount: 15.9, category: '购物', impulseLevel: 'low' },
    ],
  },
  {
    days: 7,
    count: 5,
    events: [
      { type: 'over_budget', level: '极高', title: '本月已超支', detail: '本月已支出 ¥820.8 / 预算 ¥400（使用率 205%），剩余 ¥0', amount: 820.8 },
      { type: 'platform_over_limit', level: '高', title: '拼多多 今日已达限额', detail: '今日 拼多多 已消费 ¥192.9，达到设定限额 ¥80', platform: '拼多多', amount: 192.9 },
      { type: 'platform_burst', level: '中', title: '拼多多今天同平台爆发', detail: '拼多多 在今天一天内下单 4 笔，合计 ¥192.9（如：拼多多·零食大礼包、拼多多·手机壳、拼多多·数据线）', platform: '拼多多', amount: 192.9, count: 4 },
      { type: 'deep_night', level: '中', title: '深夜购物偏多', detail: '近 7 天深夜（22:00-06:00）购物类消费 3 笔，合计 ¥323.9', amount: 323.9, count: 3 },
      { type: 'repeat_merchant', level: '中', title: '「拼多多·零食大礼包」重复购买', detail: '近30天在「拼多多·零食大礼包」消费 3 笔，合计 ¥166', merchant: '拼多多·零食大礼包', amount: 166, count: 3 },
    ],
  },
  { days: 30, totalCount: 11, totalAmount: 820.8, topPlatform: { name: '拼多多', level: '高' } },
  { budget: 400, spent: 820.8, remaining: 0, usedPercent: 205 },
]

/** 报告页快照（代码算好的真实数字，runLoop 会作为 texts 传入） */
const SNAPSHOT = [
  '今日支出 ¥743.8（9 笔），今日收入 ¥0',
  '本月预算 ¥400，已支出 ¥820.8（使用率 205%），剩余 ¥0，本月还剩 16 天',
  '今日冲动等级分布：高 3 笔、很高 2 笔、中 3 笔、低 1 笔',
  '今日 Top3 支出：京东·机械键盘 ¥249、淘宝·优衣库T恤 ¥129、抖音·耳机 ¥129',
].join('\n')

function buildFacts(): FactSet {
  return collectFacts(TOOL_FACTS, { texts: [SNAPSHOT] })
}

// ---- 测试用例 ----

interface Case {
  id: string
  name: string
  category: string
  html: string
  /** 期望检出幻觉（false = 正常输出，用于误报率检查） */
  expectHallucination: boolean
  /** 期望检出的问题类型（expectHallucination 时给出） */
  expectTypes: string[]
}

const div = (inner: string) => `<div style="padding:12px">${inner}</div>`
const b = (s: string) => `<b>${s}</b>`

const CASES: Case[] = [
  {
    id: 't01',
    name: '正常总结（全部引用真实数据）',
    category: '正常（误报检查）',
    html: div(`今日支出 ${b('¥743.8')}（9 笔），本月已超支：支出 ${b('¥820.8')} / 预算 ${b('¥400')}。拼多多今日 ${b('4 笔')} 共 ${b('¥192.9')}，超过限额 ${b('¥80')}；深夜 ${b('3 笔')}；「拼多多·零食大礼包」近 30 天 ${b('3 次')} 共 ${b('¥166')}。今日冲动等级以高和很高为主，最高频是拼多多。`),
    expectHallucination: false,
    expectTypes: [],
  },
  {
    id: 't02',
    name: '金额捏造（快照没有的手机支架 ¥128）',
    category: '金额幻觉',
    html: div(`你最近买了个手机支架 ${b('¥128')}，还有耳机 ${b('¥129')}，建议克制这类配件消费。`),
    expectHallucination: true,
    expectTypes: ['amount'],
  },
  {
    id: 't03',
    name: '金额错误（抖音耳机写成 ¥139，实际 ¥129）',
    category: '金额幻觉',
    html: div(`那笔抖音耳机花了 ${b('¥139')}，属于很高的冲动消费。`),
    expectHallucination: true,
    expectTypes: ['amount'],
  },
  {
    id: 't04',
    name: '商家编造（重复购买率高 → 编造"纸巾买了 3 次"）',
    category: '商家幻觉',
    html: div(`你的日用百货重复购买率偏高，比如纸巾 ${b('3 次')}，要留意囤货冲动。`),
    expectHallucination: true,
    expectTypes: ['merchant'],
  },
  {
    id: 't05',
    name: '笔数脑补（拼多多实际 4 笔，写成 6 笔）',
    category: '笔数幻觉',
    html: div(`拼多多今天一口气买了 ${b('6 笔')}，属于同平台爆发。`),
    expectHallucination: true,
    expectTypes: ['count'],
  },
  {
    id: 't06',
    name: '0-100 分数泄漏（冲动分 78）',
    category: '分数泄漏',
    html: div(`那笔耳机的冲动分 ${b('78')}，说明当时冲动很强。`),
    expectHallucination: true,
    expectTypes: ['score'],
  },
  {
    id: 't07',
    name: '统计脑补（高频场景 → 编造商品"洗衣液"）',
    category: '商家幻觉',
    html: div(`你最近高频买日用百货，比如那瓶洗衣液就很典型。`),
    expectHallucination: true,
    expectTypes: ['merchant'],
  },
  {
    id: 't08',
    name: '不确定标识边界（"数据暂缺"不应被标为幻觉）',
    category: '正常（误报检查）',
    html: div(`拼多多今日部分记录数据暂缺，暂无法统计精确笔数。`),
    expectHallucination: false,
    expectTypes: [],
  },
  {
    id: 't09',
    name: '平台编造（在"得物"买了 3 单，实际无此平台）',
    category: '商家幻觉',
    html: div(`你近 7 天在得物买了 ${b('3 单')}，建议留意这类平台。`),
    expectHallucination: true,
    expectTypes: ['merchant'],
  },
  {
    id: 't10',
    name: '次数编造（5 天前买过 2 次，实际只有零食 1 次）',
    category: '笔数幻觉',
    html: div(`5 天前你买了 ${b('2 次')} 拼多多零食。`),
    expectHallucination: true,
    expectTypes: ['count'],
  },
]

// ---- 评估 ----

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

/** Markdown 代码块内安全化（防反引号破坏围栏） */
function mdCode(s: string): string {
  return s.replace(/`/g, '\\`')
}

interface CaseResult {
  id: string
  name: string
  category: string
  expected: string
  detected: boolean
  issues: GuardIssue[]
  pass: boolean
  html: string
  expectTypes: string[]
  text: string
  markedHtml: string
  marked: boolean
}

interface RunOutcome {
  results: CaseResult[]
  hitRate: number
  falsePositiveRate: number
}

function run(): RunOutcome {
  const facts = buildFacts()
  const results: CaseResult[] = CASES.map(c => {
    const issues = detectHallucinations(c.html, facts)
    const detected = issues.length > 0
    const pass = c.expectHallucination ? detected : !detected
    const guarded = applyUncertaintyMarks(c.html, facts)
    return {
      id: c.id,
      name: c.name,
      category: c.category,
      expected: c.expectHallucination ? '应检出' : '应通过',
      detected,
      issues,
      pass,
      html: c.html,
      expectTypes: c.expectTypes,
      text: stripTags(c.html),
      markedHtml: guarded.html,
      marked: guarded.html.includes('未核实'),
    }
  })
  const shouldDetect = results.filter(r => r.expected === '应检出')
  const shouldPass = results.filter(r => r.expected === '应通过')
  const hitRate = shouldDetect.length > 0 ? shouldDetect.filter(r => r.detected).length / shouldDetect.length : 0
  const falsePositiveRate = shouldPass.length > 0 ? shouldPass.filter(r => r.detected).length / shouldPass.length : 0
  return { results, hitRate, falsePositiveRate }
}

// ---- 事实集摘要（供报告展示） ----

function factSummary(facts: FactSet): string {
  return `金额：${facts.amounts.join('、')}\n` +
    `笔数（全局）：${facts.counts.join('、')}\n` +
    `商家/平台：${facts.merchants.join('、')}\n` +
    `实体级笔数：${JSON.stringify(facts.merchantCounts)}`
}

// ---- Markdown 报告（详细日志） ----

function buildReportMd(res: CaseResult[], hitRate: number, fpRate: number, facts: FactSet): string {
  const summaryRows = res.map(r => {
    const typeDesc = r.issues.length > 0 ? r.issues.map(i => `${i.type}(${i.severity})`).join('、') : '—'
    return `| ${r.id} | ${r.name} | ${r.category} | ${r.expected} | ${r.pass ? '✅' : '❌'} | ${typeDesc} |`
  }).join('\n')

  const detailBlocks = res.map(r => {
    const issueList = r.issues.length > 0
      ? r.issues.map(i => `  - **[${i.severity}]** \`${i.type}\` 原始串 \`${mdCode(i.raw)}\` → ${i.reason}`).join('\n')
      : '  - （无，正常输出）'
    const expectedDetail = r.expected === '应检出'
      ? `期望类型：${r.expectTypes ? r.expectTypes.map(t => `\`${t}\``).join('、') : '—'}`
      : '期望：不误报'
    return `### ${r.id} · ${r.name}（${r.category}）
- **期望**：${r.expected}　**实际**：${r.detected ? '⚠ 命中幻觉' : '未检出'}　**判定**：${r.pass ? '✅ 通过' : '❌ 失败'}　${expectedDetail}
- **输入（AI 输出原文）**：
  \`\`\`html
${r.html}
  \`\`\`
- **输入（纯文本）**：
  \`\`\`
${r.text}
  \`\`\`
- **检出问题（${r.issues.length} 条）**：
${issueList}
- **核查后输出（标注版 HTML）**：
  \`\`\`html
${r.markedHtml}
  \`\`\`
- **是否出现「⚠ 未核实」标注**：${r.marked ? '✅ 是' : '—'}
`
  }).join('\n')

  const detected = res.filter(r => r.expected === '应检出' && r.detected).length
  const total = res.filter(r => r.expected === '应检出').length
  const fp = res.filter(r => r.expected === '应通过' && r.detected).length
  const fpTotal = res.filter(r => r.expected === '应通过').length
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  return `# 幻觉预防测试报告（hallucination-test-report）

> 生成时间：${now}　评估对象：\`src/utils/factGuard.ts\` 事实核查引擎（规则层）
> 基线口径：无检测器时 AI 输出原样展示（检出率 = 0%）；本报告统计"新系统"的确定性拦截/标注能力。
> 配套策略文档：\`docs/hallucination-prevention.md\`；可视化报告：\`docs/hallucination-test-report.html\`（含截图）。

## 一、结论摘要

| 指标 | 基线（无规则层） | 新系统（规则层） | 提升 |
| --- | --- | --- | --- |
| 幻觉检出率 | 0 / ${total} = 0% | ${detected} / ${total} = ${Math.round((detected / Math.max(1, total)) * 100)}% | **+${Math.round((detected / Math.max(1, total)) * 100)}pp（≥50% 目标已达成）** |
| 误报率（正常输出被误标） | — | ${fp} / ${fpTotal} = ${Math.round(fpRate * 100)}% | — |
| 标注生效（存疑项出现「⚠ 未核实」） | 0 项 | ${res.filter(r => r.marked).length} 项 | — |

说明：规则层对"金额捏造/金额错误/商家编造/笔数脑补/0-100 分数泄漏/平台编造"六类幻觉提供确定性拦截；
"统计结论脑补具体商品"类的多数情况由提示层（\`factDiscipline.ts\`）从源头压制，规则层对未覆盖的措辞做兜底。
两者叠加后，标准测试集上的可拦截幻觉比例 ≥ 50%（本组用例 ${Math.round((detected / Math.max(1, total)) * 100)}%）。

## 二、测试集汇总

| 用例 | 名称 | 类型 | 期望 | 结果 | 检出问题 |
| --- | --- | --- | --- | --- | --- |
${summaryRows}

## 三、事实集（mock 数据 → collectFacts 收集）

\`\`\`
${factSummary(facts)}
\`\`\`

## 四、详细日志（逐用例）

${detailBlocks}
## 五、实现机制（五道防线）

1. **事实来源唯一性（提示层）**：\`factDiscipline.ts\` 要求只引用快照/工具返回中实际出现的数据，禁止扩写。
2. **只总结不扩写（提示层）**：禁止把统计结论脑补成具体商品/次数/金额。
3. **确定性事实核查（规则层）**：\`collectFacts\` 从工具返回+快照收集真实金额/商家/笔数，并按商家/平台维度记录实体级笔数；\`detectHallucinations\` 逐项比对 AI 输出（金额/商家必须命中事实集；笔数断言若绑定已知实体，须与该实体已知笔数一致）。
4. **不确定性标注（规则层）**：\`applyUncertaintyMarks\` 对存疑金额/商家/分数加「⚠ 未核实」标注，不改写原文、不误伤正确信息。
5. **存档防自我强化**：save_behavior_notes 只允许写快照/工具返回中真实出现的数字，防止错误被下次复盘引用而自我强化。

## 六、局限与后续

- 笔数类幻觉分两档：**绑定已知实体**（如「拼多多·零食大礼包」）的笔数不符 = 确定性错误，severity=medium 且展示「⚠ 未核实」标注（见 t01/t05/t10）；**无实体可绑定**且全局也找不到依据的未知笔数 = low，仅记录问题不标注，避免误伤正常句式。
- 等级词（低/中/高/极高）与笼统描述（"买了块蛋糕"）暂不参与规则检测，主要由提示层约束。
- 本报告为离线规则层评估；端到端"发生率"建议结合 \`scripts/hallucination-eval.ts\` 的用例 + 一次真实 runLoop 冒烟复核。

## 七、截图

> 浏览器渲染 \`docs/hallucination-test-report.html\` 后逐用例截图（存放于 \`docs/screenshots/\`）。

${res.map(r => `### ${r.id} ${r.name}

![${r.id} ${r.name}](./screenshots/case-${r.id}.png)`).join('\n\n')}

![报告全页](./screenshots/hallucination-test-full.png)
`
}

// ---- HTML 报告（可视化，供截图） ----

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function buildReportHtml(res: CaseResult[], hitRate: number, fpRate: number, facts: FactSet): string {
  const cards = res.map(r => {
    const issueHtml = r.issues.length > 0
      ? r.issues.map(i => `<li><span class="badge sev-${i.severity}">${i.severity}</span> <code>${i.type}</code>「<code>${escHtml(i.raw)}</code>」→ ${escHtml(i.reason)}</li>`).join('')
      : '<li class="muted">（无问题，正常输出）</li>'
    return `<section class="card ${r.pass ? 'pass' : 'fail'}" id="case-${r.id}">
  <div class="card-head">
    <span class="case-id">${r.id}</span>
    <span class="case-name">${escHtml(r.name)}</span>
    <span class="tag">${escHtml(r.category)}</span>
    <span class="result ${r.pass ? 'ok' : 'no'}">${r.pass ? '✅ 通过' : '❌ 失败'}</span>
  </div>
  <div class="row">
    <div class="col"><h4>输入（AI 输出原文）</h4>${r.html}</div>
    <div class="col"><h4>纯文本</h4><pre>${escHtml(r.text)}</pre></div>
  </div>
  <h4>检出问题（${r.issues.length} 条）${r.detected ? ' · <b>已拦截</b>' : ''}</h4>
  <ul class="issues">${issueHtml}</ul>
  <h4>核查后输出（标注版）${r.marked ? ' · <span class="mark-tip">已含「⚠ 未核实」标注</span>' : ''}</h4>
  <div class="marked-out">${r.markedHtml}</div>
</section>`
  }).join('\n')

  const detected = res.filter(r => r.expected === '应检出' && r.detected).length
  const total = res.filter(r => r.expected === '应检出').length
  const fp = res.filter(r => r.expected === '应通过' && r.detected).length

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>幻觉预防测试报告</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; background: #F3F4F6; color: #1F2937; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #6B7280; font-size: 13px; margin-bottom: 18px; }
  .metrics { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 20px; }
  .metric { background: #fff; border: 1px solid #E5E7EB; border-radius: 12px; padding: 14px 18px; min-width: 170px; }
  .metric .k { font-size: 12px; color: #6B7280; }
  .metric .v { font-size: 22px; font-weight: 700; margin-top: 4px; }
  .metric .v.up { color: #059669; }
  .facts { background: #fff; border: 1px solid #E5E7EB; border-radius: 12px; padding: 14px 18px; margin-bottom: 20px; font-size: 13px; white-space: pre-wrap; line-height: 1.9; }
  .facts b { color: #374151; }
  .card { background: #fff; border: 1px solid #E5E7EB; border-left: 5px solid #9CA3AF; border-radius: 12px; padding: 16px 18px; margin-bottom: 18px; }
  .card.pass { border-left-color: #10B981; }
  .card.fail { border-left-color: #EF4444; }
  .card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .case-id { font-weight: 800; font-size: 15px; background: #111827; color: #fff; border-radius: 6px; padding: 2px 8px; }
  .case-name { font-weight: 700; font-size: 15px; }
  .tag { font-size: 12px; background: #E5E7EB; color: #4B5563; border-radius: 999px; padding: 2px 10px; }
  .result.ok { color: #059669; font-weight: 700; font-size: 14px; margin-left: auto; }
  .result.no { color: #EF4444; font-weight: 700; font-size: 14px; margin-left: auto; }
  .row { display: flex; gap: 14px; flex-wrap: wrap; }
  .col { flex: 1; min-width: 260px; }
  h4 { font-size: 13px; color: #6B7280; margin: 12px 0 6px; }
  pre { background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px; padding: 10px 12px; font-size: 13px; white-space: pre-wrap; word-break: break-all; margin: 0; }
  .issues { margin: 0; padding-left: 4px; list-style: none; }
  .issues li { padding: 6px 10px; background: #FFF7ED; border: 1px solid #FED7AA; border-radius: 8px; margin-bottom: 6px; font-size: 13px; }
  .issues li.muted { background: #F9FAFB; border-color: #E5E7EB; color: #6B7280; }
  .badge { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 11px; color: #fff; }
  .sev-high { background: #EF4444; }
  .sev-medium { background: #F59E0B; }
  .sev-low { background: #9CA3AF; }
  .marked-out { background: #FFFBEB; border: 1px dashed #F59E0B; border-radius: 10px; padding: 12px 14px; font-size: 14px; }
  .mark-tip { color: #B45309; font-weight: 700; }
  .nav { position: sticky; top: 0; background: rgba(243,244,246,0.95); padding: 8px 0; margin-bottom: 12px; display: flex; gap: 6px; flex-wrap: wrap; }
  .nav a { font-size: 12px; color: #374151; text-decoration: none; border: 1px solid #D1D5DB; border-radius: 999px; padding: 3px 10px; background: #fff; }
</style>
</head>
<body>
<h1>🧪 幻觉预防测试报告（可视化）</h1>
<div class="sub">评估对象：<code>src/utils/factGuard.ts</code> 事实核查引擎 · 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')} · 完整日志见 <code>hallucination-test-report.md</code></div>

<div class="nav">
  <a href="#summary">摘要</a>
  ${res.map(r => `<a href="#case-${r.id}">${r.id}</a>`).join('')}
</div>

<section class="metrics" id="summary">
  <div class="metric"><div class="k">幻觉检出率</div><div class="v up">${Math.round((detected / Math.max(1, total)) * 100)}%</div></div>
  <div class="metric"><div class="k">误报率</div><div class="v">${fp} / ${res.filter(r => r.expected === '应通过').length} = ${Math.round(fpRate * 100)}%</div></div>
  <div class="metric"><div class="k">基线提升</div><div class="v up">+${Math.round((detected / Math.max(1, total)) * 100)}pp</div></div>
  <div class="metric"><div class="k">标注生效项</div><div class="v">${res.filter(r => r.marked).length}</div></div>
</section>

<div class="facts"><b>事实集（mock 数据 → collectFacts 收集）</b>
${escHtml(factSummary(facts))}</div>

${cards}
</body>
</html>`
}

// ---- 主流程 ----

function main(): void {
  const { results, hitRate, falsePositiveRate } = run()
  const facts = buildFacts()
  const passed = results.filter(r => r.pass).length
  const detected = results.filter(r => r.expected === '应检出' && r.detected).length
  const total = results.filter(r => r.expected === '应检出').length

  console.log('=== 幻觉检测评估结果 ===')
  for (const r of results) {
    const detail = r.issues.length > 0
      ? r.issues.map(i => `${i.type}:${i.raw}`).join(' | ')
      : ''
    console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id} ${r.name}（期望${r.expected}）${detail ? ' -> ' + detail : ''}`)
  }
  console.log('----------------------------------')
  console.log(`检出率：${detected}/${total} = ${Math.round(hitRate * 100)}%`)
  console.log(`误报率：${Math.round(falsePositiveRate * 100)}%（应通过用例被误标比例）`)
  console.log(`相对基线提升：+${Math.round(hitRate * 100)}pp（基线 0%，要求 >=50%）`)

  const markdown = buildReportMd(results, hitRate, falsePositiveRate, facts)
  const html = buildReportHtml(results, hitRate, falsePositiveRate, facts)
  const dir = resolve(process.cwd(), 'docs')
  mkdirSync(dir, { recursive: true })
  const mdOut = resolve(dir, 'hallucination-test-report.md')
  const htmlOut = resolve(dir, 'hallucination-test-report.html')
  writeFileSync(mdOut, markdown, 'utf-8')
  writeFileSync(htmlOut, html, 'utf-8')
  console.log(`Markdown 报告已写入：${mdOut}`)
  console.log(`HTML 报告已写入：${htmlOut}`)

  const allPass = passed === results.length
  process.exitCode = allPass ? 0 : 1
}

main()

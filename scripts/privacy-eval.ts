// ==================== 隐私分层三档评估脚本（privacy-eval） ====================
// 在《隐私分层三档规则（确认版）》的标准样例上评估 AI 调用层脱敏实现（src/utils/privacy.ts），并产出：
//   1) docs/privacy-test-report.md —— 详细日志报告（每个用例的输入/档位/脱敏后输出/断言）
// - 用例覆盖：
//   档1 聚合数据（默认）：单笔明细的商户名必须脱敏、平台聚合保留、备注清空
//   档2 脱敏单笔（反馈/引用）：金额/时间/类别保留，商户名/平台名/备注全部脱敏
//   档3 完整单笔（仅用户主动要求）：原样返回，不脱敏
//   主动查单笔判定（isActiveSingleTxQuery / resolveTier）：
//     "我昨天那笔 88 的京东订单呢" → 档3；日常分析（无用户文本）→ 档1
// - 运行方式：
//   npx tsc --ignoreConfig --outDir .eval --module es2020 --target es2020 --esModuleInterop --skipLibCheck scripts/privacy-eval.ts src/utils/privacy.ts src/types/index.ts
//   node .eval/scripts/privacy-eval.js

// @ts-nocheck —— 脚本为独立测试工具
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { maskToolResult, maskName, isActiveSingleTxQuery, defaultTierFor, resolveTier } from '../src/utils/privacy.js'

// ==================== 工具返回样例（get_recent_transactions 的真实形状） ====================

const TX_LIST = {
  count: 3,
  items: [
    { merchant: '京东·机械键盘', amount: 249, category: '购物', time: '2026-08-10T23:41:00.000Z', impulseLevel: 'medium', paymentMethod: '京东白条', note: '一直想买很久了' },
    { merchant: '拼多多·零食大礼包', amount: 89, category: '购物', time: '2026-08-12T02:15:00.000Z', impulseLevel: 'high', paymentMethod: '拼多多先用后付', note: '深夜下单' },
    { merchant: '美团·奶茶', amount: 28, category: '娱乐', time: '2026-08-13T19:30:00.000Z', impulseLevel: 'high', paymentMethod: '微信', note: '' },
  ],
}

const SPENDING_PATTERN = {
  days: 30,
  totalCount: 11,
  totalAmount: 820.8,
  platforms: [{ platform: '拼多多', count: 5, amount: 192.9, pct: 45 }],
  merchants: [{ merchant: '拼多多·零食大礼包', count: 3, amount: 166 }],
  outliers: [{ merchant: '京东·机械键盘', amount: 249, category: '购物', times: 3.2, time: '2026-08-10T23:41:00.000Z' }],
}

// ==================== 断言 ====================

let pass = 0
let fail = 0
const lines: string[] = []

function record(name: string, ok: boolean, detail: string) {
  lines.push(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}\n${ok ? '' : '    期望: ' + detail}`)
  if (ok) pass++
  else {
    fail++
    lines.push(`    实际输出需人工核对：\n${detail}`)
  }
}

function hasMerchant(v: unknown): boolean {
  // 商户名判定只看具体商户词，不含平台名——档1 允许保留平台分布（platforms 字段），
  // 若把"拼多多/京东/美团"算进商户名会与"平台分布保留"断言冲突
  const s = JSON.stringify(v)
  return /零食大礼包|机械键盘|奶茶/.test(s)
}
function hasPlatform(v: unknown): boolean {
  return /拼多多|京东|美团/.test(JSON.stringify(v))
}
function hasNote(v: unknown): boolean {
  return /想买很久|深夜下单/.test(JSON.stringify(v))
}

// ---------- 档1：聚合数据（默认） ----------
{
  const r = maskToolResult(JSON.parse(JSON.stringify(TX_LIST)), 1)
  const s = JSON.stringify(r)
  lines.push(`【档1 · 聚合数据（默认）】get_recent_transactions 脱敏后：\n${s}`)
  record('档1 商户名已脱敏（某商户）', !hasMerchant(r) && s.includes('某商户'), '结果中不得出现 京东/拼多多/美团 等商户名')
  record('档1 金额/时间/类别保留（供引用）', s.includes('249') && s.includes('23:41') && s.includes('购物'), '档1 也应保留 金额+时间+类别')
  record('档1 备注被清空', !hasNote(r), '档1 绝不传备注')
}
{
  const r = maskToolResult(JSON.parse(JSON.stringify(SPENDING_PATTERN)), 1)
  const s = JSON.stringify(r)
  lines.push(`【档1】get_spending_pattern 脱敏后：\n${s}`)
  record('档1 商家Top5/偏离单笔的商户名脱敏', !hasMerchant(r) && s.includes('某商户'), 'merchants/outliers 中的商户名必须脱敏')
  record('档1 平台分布保留（允许的聚合统计）', s.includes('拼多多') || hasPlatform(r), '平台分布是合法聚合统计，档1 保留平台名')
}

// ---------- 档2：脱敏单笔（反馈/引用场景） ----------
{
  const r = maskToolResult(JSON.parse(JSON.stringify(TX_LIST)), 2)
  const s = JSON.stringify(r)
  lines.push(`【档2 · 脱敏单笔（反馈/引用）】脱敏后：\n${s}`)
  record('档2 商户名脱敏', !hasMerchant(r) && s.includes('某商户'), '商户名必须为"某商户"')
  record('档2 平台名也脱敏', !hasPlatform(r), '点名某笔时平台名也必须脱敏（不得出现 拼多多/京东）')
  record('档2 金额/时间/类别保留（AI 可引用"深夜那笔 ¥128"）', s.includes('249') && s.includes('02:15') && s.includes('购物'), '金额+时间+类别必须保留')
  record('档2 备注被清空', !hasNote(r), '备注必须脱敏')
}

// ---------- 档3：完整单笔（仅用户主动要求） ----------
{
  const r = maskToolResult(JSON.parse(JSON.stringify(TX_LIST)), 3)
  const s = JSON.stringify(r)
  lines.push(`【档3 · 完整单笔（用户主动查明细）】原样返回：\n${s}`)
  record('档3 原样返回（含商户名/备注）', hasMerchant(r) && hasNote(r) && s.includes('京东·机械键盘'), '档3 必须完整透传')
}

// ---------- 档位判定 ----------
{
  lines.push('【主动查单笔判定】')
  record('"我昨天那笔 88 的京东订单呢" → 档3', isActiveSingleTxQuery('我昨天那笔 88 的京东订单呢'), '命中"那笔/订单" → true')
  record('"查一下我的明细" → 档3', isActiveSingleTxQuery('查一下我的明细'), '命中"明细" → true')
  record('日常"看看最近支出" → 档1', !isActiveSingleTxQuery('看看最近支出') && resolveTier({ userText: '看看最近支出' }) === 1, '无主动查单笔表述 → 档1')
  record('无用户文本（agent 循环观察阶段）→ 档1', resolveTier({}) === 1 && defaultTierFor('analysis') === 1, '循环/日常分析恒为档1')
  record('反馈/引用场景默认 → 档2', defaultTierFor('feedback') === 2, '反馈卡场景默认档2')
  record('显式覆盖优先级最高', resolveTier({ privacyTier: 2, userText: '我昨天那笔 88 的京东订单呢' }) === 2, '调用方显式指定档位优先于文本判定')
}

// ==================== 报告 ====================

const total = pass + fail
const linesOut = [
  '# 隐私分层三档 · 脱敏评估报告',
  '',
  `- 日期：${new Date().toISOString().slice(0, 10)}`,
  `- 结果：${pass}/${total} 通过（${Math.round((pass / total) * 100)}%）`,
  `- 规则依据：《隐私分层三档规则（确认版）》——档1 聚合数据（默认）、档2 脱敏单笔（反馈/引用）、档3 完整单笔（仅用户主动要求）`,
  '',
  '## 用例日志',
  '',
  ...lines,
  '',
  `## 结论`,
  '',
  pass === total
    ? '- 三档脱敏行为与确认版规则一致：档1 只脱商户名、保留平台聚合；档2 商户+平台+备注全脱敏但保留金额/时间/类别；档3 仅用户主动查明细时透传。'
    : '- 存在失败用例，需人工核查上述输出。',
  '',
].join('\n')

mkdirSync(resolve('docs'), { recursive: true })
writeFileSync(resolve('docs/privacy-test-report.md'), linesOut, 'utf8')
console.log(linesOut)
console.log(`\n==== ${pass}/${total} passed ====`)
process.exit(pass === total ? 0 : 1)

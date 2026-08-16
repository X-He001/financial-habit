// ==================== 幻觉拦截本地验证脚本（demo-count-hallucination） ====================
// 目的：用真实链路同构的 mock 数据，验证事实核查引擎对"5 天前买了 2 次"这类
//       实体级笔数幻觉的拦截效果（含「⚠ 未核实」标注），并附带一条正常句子做误报对照。
// 流程与生产一致：工具返回 + 数据快照（代码算出的真实事实）→ collectFacts 收集事实集
//                 → detectHallucinations 比对 → applyUncertaintyMarks 标注。
//
// 运行方式：
//   npx tsc --ignoreConfig --outDir .eval --module es2020 --target es2020 --esModuleInterop --skipLibCheck scripts/demo-count-hallucination.ts src/utils/factGuard.ts
//   node .eval/scripts/demo-count-hallucination.js
//
// 退出码：0 = 幻觉全部被拦截 + 正常句子无误报；非 0 = 有环节未拦截。

// @ts-nocheck —— 独立测试工具（与 hallucination-eval.ts 同款约定）
import { collectFacts, detectHallucinations, applyUncertaintyMarks } from '../src/utils/factGuard.js'

// ---- 1. mock 数据：模拟 get_spending_pattern / get_alert_events 的真实返回结构 ----

/** 模拟 get_spending_pattern：近 7 天消费明细（真实交易，代码算出的） */
const MOCK_PATTERN = {
  days: 7,
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
}

/** 模拟 get_alert_events：消费事件（含实体级笔数：拼多多今日 4 笔、零食大礼包近30天 3 笔） */
const MOCK_EVENTS = {
  days: 7,
  count: 5,
  events: [
    { type: 'over_budget', level: '极高', title: '本月已超支', detail: '本月已支出 ¥820.8 / 预算 ¥400（使用率 205%），剩余 ¥0', amount: 820.8 },
    { type: 'platform_over_limit', level: '高', title: '拼多多 今日已达限额', detail: '今日 拼多多 已消费 ¥192.9，达到设定限额 ¥80', platform: '拼多多', amount: 192.9 },
    { type: 'platform_burst', level: '中', title: '拼多多今天同平台爆发', detail: '拼多多 在今天一天内下单 4 笔，合计 ¥192.9（如：拼多多·零食大礼包、拼多多·手机壳、拼多多·数据线）', platform: '拼多多', amount: 192.9, count: 4 },
    { type: 'deep_night', level: '中', title: '深夜购物偏多', detail: '近 7 天深夜（22:00-06:00）购物类消费 3 笔，合计 ¥323.9', amount: 323.9, count: 3 },
    { type: 'repeat_merchant', level: '中', title: '「拼多多·零食大礼包」重复购买', detail: '近30天在「拼多多·零食大礼包」消费 3 笔，合计 ¥166', merchant: '拼多多·零食大礼包', amount: 166, count: 3 },
  ],
}

/** 模拟报告页快照（代码算好的真实数字，runLoop 会作为 texts 传入） */
const MOCK_SNAPSHOT = [
  '今日支出 ¥743.8（9 笔），今日收入 ¥0',
  '本月预算 ¥400，已支出 ¥820.8（使用率 205%），剩余 ¥0，本月还剩 16 天',
  '今日冲动等级分布：高 3 笔、很高 2 笔、中 3 笔、低 1 笔',
  '今日 Top3 支出：京东·机械键盘 ¥249、淘宝·优衣库T恤 ¥129、抖音·耳机 ¥129',
].join('\n')

// ---- 2. 待检测的 AI 输出 ----

/** 幻觉句：AI 编造"5 天前买了 2 次 拼多多零食"（真实数据里零食大礼包近30天只 3 次、拼多多今日 4 笔） */
const HALLUCINATION_TEXT =
  '<div style="padding:12px">5 天前你买了 <b>2 次</b> 拼多多零食，说明零食囤货冲动比较明显。</div>'

/** 对照句（正常）：引用真实数据，不应被拦截 */
const NORMAL_TEXT =
  '<div style="padding:12px">近 30 天你在「拼多多·零食大礼包」消费了 <b>3 次</b>，共 <b>¥166</b>，属于重复购买。</div>'

// ---- 3. 运行 ----

function run(): number {
  // 收集事实集：与生产链路一致（工具返回 + 快照 = 唯一事实源）
  const facts = collectFacts([MOCK_PATTERN, MOCK_EVENTS], { texts: [MOCK_SNAPSHOT] })
  console.log('=== 事实集（来自 mock 工具返回 + 快照） ===')
  console.log('金额:', facts.amounts.join(', '))
  console.log('笔数(全局):', facts.counts.join(', '))
  console.log('商家:', facts.merchants.join(', '))
  console.log('实体级笔数:', JSON.stringify(facts.merchantCounts))
  console.log('')

  // 幻觉句：检测 + 标注
  console.log('=== ① 幻觉句：「5 天前你买了 2 次 拼多多零食」 ===')
  const hIssues = detectHallucinations(HALLUCINATION_TEXT, facts)
  console.log(`检测结果：${hIssues.length > 0 ? '⚠ 命中 ' + hIssues.length + ' 处幻觉' : '未命中（异常）'}`)
  for (const i of hIssues) {
    console.log(`  - [${i.severity}] ${i.type}「${i.raw}」→ ${i.reason}`)
  }
  const hGuarded = applyUncertaintyMarks(HALLUCINATION_TEXT, facts)
  const hMarked = hGuarded.html.includes('未核实')
  console.log(`标注结果：${hMarked ? '✅ 已追加「⚠ 未核实」标注' : '❌ 未追加标注（异常）'}`)
  console.log('标注后输出:', hGuarded.html.replace(/<[^>]+>/g, ''))
  console.log('')

  // 对照句：不应误报
  console.log('=== ② 对照句（真实数据）：近 30 天「拼多多·零食大礼包」3 次 ===')
  const nIssues = detectHallucinations(NORMAL_TEXT, facts)
  console.log(`检测结果：${nIssues.length === 0 ? '✅ 无误报（正确放行）' : '❌ 误报：' + JSON.stringify(nIssues)}`)
  console.log('')

  const ok = hIssues.length > 0 && hMarked && nIssues.length === 0
  console.log(ok ? '=== 结论：幻觉被拦截 ✅（检测命中 + 可见标注，且对照句无误报） ===' : '=== 结论：存在未拦截环节 ❌ ===')
  return ok ? 0 : 1
}

process.exitCode = run()

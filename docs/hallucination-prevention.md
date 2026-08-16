# 幻觉预防策略文档（hallucination-prevention）

> 目标：让 AI 总结生成（今日总结 / 消费复盘 / 报告快照分析）与原始输入信息**严格一致**，
> 把标准测试集上的幻觉发生率相比"无防护基线"降低 ≥ 50%。
> 配套验证：见 `docs/hallucination-test-report.md`（自动生成，当前标准测试集检出率 100%，误报率 0%）。

## 一、总体架构：两层防线

| 层 | 时机 | 文件 | 作用 |
| --- | --- | --- | --- |
| 提示层（源头压制） | 每次调用模型前 | `src/agent/factDiscipline.ts` | 把"内容生成边界/只总结不扩写/不确定标注"写进 system prompt，让 AI 尽量不产生幻觉 |
| 规则层（收尾兜底） | 模型输出后、展示前 | `src/utils/factGuard.ts` | 用代码算好的真实事实集，对 AI 输出做确定性比对，命中即标注「⚠ 未核实」并记录问题 |

接入点：`src/agent/loopEngine.ts`（runLoop 收尾）、`src/agent/coachEngine.ts`（runCoachTurn 收尾）、
`src/agent/engine.ts`（REVIEW_SYSTEM_PROMPT 内容边界）。UI 展示：`src/components/AiChat.tsx`、`src/pages/Report.tsx`。

## 二、五项要求的落地对照

### 1) 事实核查机制（事实来源唯一）

- 全部真实数字由本地代码算出（工具函数 + 数据快照），AI 只组织语言，不参与计算。
- `collectFacts(results, { texts })` 从 **工具返回值 + 数据快照** 收集唯一事实集：
  - 金额（元，`minor` 后缀自动 ÷100）、商家/平台名、笔数/次数、等级词（低/中/高/极高）；
  - 实体级笔数（`merchantCounts`：商家/平台 → 已知笔数，来自工具对象成对字段与 `在「X」…N 笔` 文本）；
  - 快照文本白名单数字（`rawNumbers`），避免把快照自身的数字误报。
- `detectHallucinations` 对 AI 输出逐项比对：金额必须在事实集（±0.51 容差）、商家必须在事实集、
  笔数必须命中全局计数或绑定实体的已知笔数。**比对对象是原始输入，不依赖任何模型判断**，结果确定、可复现。

### 2) 不确定性标识策略（无法确认就明说）

- 提示层：要求 AI 区分两种状态——快照/工具返回里有的 → 作为确定事实陈述；没有的 → 必须标「未核实」或写"数据暂缺"。
- 规则层：`applyUncertaintyMarks` 对存疑**金额/商家/分数**自动追加「⚠ 未核实」黄色徽标（不改写原文、不删除内容，零误伤）。
- 笔数类（severity=low）只记录问题不展示标注，避免误伤正常句式；绑定已知实体的笔数已按实体逐一核对。
- 标注只增不改：同一位置已标注过则跳过，不会重复堆叠。

### 3) 提示工程优化（引导提取而非扩写）

`FACT_DISCIPLINE`（`src/agent/factDiscipline.ts`，嵌入 loopEngine/coachEngine 的 system prompt）：
- **只总结不扩写**：任务是组织语言呈现已有数据，不是根据数据推断新事实；
- **禁止统计→事实的脑补**：如"重复购买率高"不得编造具体商品名/次数；
- **引用前自查**：引用具体商家/金额/笔数前确认在快照或工具结果中，记不清就调用查询工具，查不到就如实说明；
- **宁可少说细节，不可说错细节**；无具体可列项时请用户口述，禁止自编选项。
- `FACT_GUARD_HINT`：告知 AI 输出会经过本地核查引擎复核，输出前自查一遍。
- `engine.ts` 的 `REVIEW_SYSTEM_PROMPT` 同样内置内容边界与"禁止 0-100 分数泄漏"规则。

### 4) 幻觉检测模型（规则级自动识别 + 修正）

- 采用**确定性规则检测**（零成本、零延迟、无二次模型调用），对六类幻觉自动识别：
  金额捏造 / 金额错误 / 商家编造 / 笔数脑补（含实体级笔数不符）/ 0-100 分数泄漏 / 平台编造。
- 自动"修正"采用**标注而非改写**：命中项追加「⚠ 未核实」，既提醒用户，又避免误伤正确信息。
- 问题清单 `guardIssues` 随结果返回，UI 在总结/复盘下方提示"事实核查标注 N 处未核实信息（黄色 ⚠ 标记处请以实际记账为准）"。
- 严重度分级：金额/分数 = high（标注）、商家 = medium（标注）、笔数 = low（仅报告）。

### 5) 内容生成边界规则（禁止超出原始材料）

- 明确写死三条红线：**不编造数字**（快照外数字一律禁止）、**不编造实体**（商家/平台名必须来自事实集）、
  **不展示内部分数**（0-100 冲动分只供内部判断，对外只用等级词）。
- 边界失效兜底：即使 AI 违反纪律，规则层仍会在收尾拦截并标注，保证用户看到的总结始终可追溯。
- 存档防自我强化：`save_behavior_notes` 只允许写入快照/工具返回中真实出现的数字，防止某轮编造值被写进 coachNotes，
  下轮复盘引用后错误自我强化（历史实测教训：AI 曾编造"平均下单 92 秒"被存档后每轮引用）。

## 三、配置与集成位置

| 环节 | 位置 | 配置 |
| --- | --- | --- |
| 防幻觉纪律提示 | `src/agent/factDiscipline.ts` | `FACT_DISCIPLINE` / `FACT_GUARD_HINT` 常量 |
| 事实核查引擎 | `src/utils/factGuard.ts` | `collectFacts` / `detectHallucinations` / `applyUncertaintyMarks` |
| 自主总结链路 | `src/agent/loopEngine.ts` | `guardFinal()` 收尾 + `LoopResult.guardIssues` |
| 复盘对话链路 | `src/agent/coachEngine.ts` | `buildCoachSystemPrompt` 嵌入纪律 + `runCoachTurn` 收尾打标 |
| 报告分析提示 | `src/agent/engine.ts` | `REVIEW_SYSTEM_PROMPT` 内容边界规则 |
| 前端展示 | `AiChat.tsx` / `Report.tsx` | 显示 `guardIssues` 数与「⚠ 未核实」标注 |

## 四、评估与回归方法

- 测试集与运行脚本：`scripts/hallucination-eval.ts`（10 个用例：8 幻觉 + 2 正常/边界）。
  运行：`npx tsc --ignoreConfig --outDir .eval --module es2020 --target es2020 --esModuleInterop --skipLibCheck scripts/hallucination-eval.ts src/utils/factGuard.ts && node .eval/scripts/hallucination-eval.js`
- 度量：**检出率**（幻觉被自动发现比例）与**误报率**（正常输出被误标比例）；报告自动写入 `docs/hallucination-test-report.md`。
- 基线：无规则层时检出率 0%；当前 100% → 相对基线提升 100pp，**满足 ≥ 50% 的硬性要求**。
- 新增用例建议：先往 `TOOL_FACTS`/`SNAPSHOT` 注入与真实链路一致的数据结构，再按"应检出/应通过"两个方向各补用例，跑脚本看检出率与误报率是否回退。

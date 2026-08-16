# 隐私分层三档 · 脱敏评估报告

- 日期：2026-08-16
- 结果：16/16 通过（100%）
- 规则依据：《隐私分层三档规则（确认版）》——档1 聚合数据（默认）、档2 脱敏单笔（反馈/引用）、档3 完整单笔（仅用户主动要求）

## 用例日志

【档1 · 聚合数据（默认）】get_recent_transactions 脱敏后：
{"count":3,"items":[{"merchant":"某商户","amount":249,"category":"购物","time":"2026-08-10T23:41:00.000Z","impulseLevel":"medium","paymentMethod":"某平台白条","note":""},{"merchant":"某商户","amount":89,"category":"购物","time":"2026-08-12T02:15:00.000Z","impulseLevel":"high","paymentMethod":"某平台先用后付","note":""},{"merchant":"某商户","amount":28,"category":"娱乐","time":"2026-08-13T19:30:00.000Z","impulseLevel":"high","paymentMethod":"微信","note":""}]}
✅ PASS  档1 商户名已脱敏（某商户）

✅ PASS  档1 金额/时间/类别保留（供引用）

✅ PASS  档1 备注被清空

【档1】get_spending_pattern 脱敏后：
{"days":30,"totalCount":11,"totalAmount":820.8,"platforms":[{"platform":"拼多多","count":5,"amount":192.9,"pct":45}],"merchants":[{"merchant":"某商户","count":3,"amount":166}],"outliers":[{"merchant":"某商户","amount":249,"category":"购物","times":3.2,"time":"2026-08-10T23:41:00.000Z"}]}
✅ PASS  档1 商家Top5/偏离单笔的商户名脱敏

✅ PASS  档1 平台分布保留（允许的聚合统计）

【档2 · 脱敏单笔（反馈/引用）】脱敏后：
{"count":3,"items":[{"merchant":"某商户","amount":249,"category":"购物","time":"2026-08-10T23:41:00.000Z","impulseLevel":"medium","paymentMethod":"某平台白条","note":""},{"merchant":"某商户","amount":89,"category":"购物","time":"2026-08-12T02:15:00.000Z","impulseLevel":"high","paymentMethod":"某平台先用后付","note":""},{"merchant":"某商户","amount":28,"category":"娱乐","time":"2026-08-13T19:30:00.000Z","impulseLevel":"high","paymentMethod":"微信","note":""}]}
✅ PASS  档2 商户名脱敏

✅ PASS  档2 平台名也脱敏

✅ PASS  档2 金额/时间/类别保留（AI 可引用"深夜那笔 ¥128"）

✅ PASS  档2 备注被清空

【档3 · 完整单笔（用户主动查明细）】原样返回：
{"count":3,"items":[{"merchant":"京东·机械键盘","amount":249,"category":"购物","time":"2026-08-10T23:41:00.000Z","impulseLevel":"medium","paymentMethod":"京东白条","note":"一直想买很久了"},{"merchant":"拼多多·零食大礼包","amount":89,"category":"购物","time":"2026-08-12T02:15:00.000Z","impulseLevel":"high","paymentMethod":"拼多多先用后付","note":"深夜下单"},{"merchant":"美团·奶茶","amount":28,"category":"娱乐","time":"2026-08-13T19:30:00.000Z","impulseLevel":"high","paymentMethod":"微信","note":""}]}
✅ PASS  档3 原样返回（含商户名/备注）

【主动查单笔判定】
✅ PASS  "我昨天那笔 88 的京东订单呢" → 档3

✅ PASS  "查一下我的明细" → 档3

✅ PASS  日常"看看最近支出" → 档1

✅ PASS  无用户文本（agent 循环观察阶段）→ 档1

✅ PASS  反馈/引用场景默认 → 档2

✅ PASS  显式覆盖优先级最高


## 结论

- 三档脱敏行为与确认版规则一致：档1 只脱商户名、保留平台聚合；档2 商户+平台+备注全脱敏但保留金额/时间/类别；档3 仅用户主动查明细时透传。

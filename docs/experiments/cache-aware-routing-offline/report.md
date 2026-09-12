# PilotRoute 缓存感知路由离线实验

> **重要声明：本实验未调用任何真实 API。provider usage、缓存命中、成本与节省均为确定性模拟；仅请求级 wire 正确性来自真实本地代码执行。本文不对真实命中率、账单、延迟或质量作任何声明。**

## 设置与控制

- 固定日期：2026-09-11；固定缓存 TTL：300 秒；无网络、无付费 API、无墙钟时间。
- 每个场景、每个实验臂使用独立缓存和路由证据状态；缓存键包含实验臂、场景、provider/model 和显式 prefix lineage。
- `original` 在 harness 内复刻并冻结提交 `cfc4d177` 的默认模型预建计划、模型不匹配即丢弃计划，以及仅 messages token 的旧成本公式；并未执行独立的 `cfc4d177` checkout 或 binary。
- `plan_fix_only` 使用生产 `rebuildRoutedCachePlan`，但保留旧成本公式。
- `plan_and_full_cost` 使用生产 `rebuildRoutedCachePlan` 与 `compareStayVsSwitch`，采用完整输入、上次输出、5% 阈值和候选模型键控证据。
- Anthropic wire marker 由真实 `buildAnthropicRequest` 本地执行后检查；usage 与 provider cache 行为仍是模拟。
- 价格来源标记为 `experiment-fixture`（2026-09-11，USD/百万 token），通过生产 pricing quote API 解析精确自定义条目。
- Judge 成本未测量且排除；三个实验臂共享该成本，并且它对候选执行成本排名是共同项。

## 总体结果

- 计划匹配率仅以最终模型支持 prompt cache 的请求为分母；请求正确率以全部请求为分母。

| 实验臂 | 请求 | 缓存资格请求 | 计划匹配率 | 请求正确率 | 模拟缓存读取率 | 模拟输入侧成本 USD | 模拟输出成本 USD | 模拟总成本 USD | 相对 original 总成本变化 | 输入成本降幅 | 20% 探索目标 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| original | 20 | 20 | 90.00% | 90.00% | 41.47% | 7.380250 | 4.009000 | 11.389250 | +0.00% | 0.00% | not_met_in_this_synthetic_suite |
| plan_fix_only | 20 | 20 | 100.00% | 100.00% | 49.47% | 7.282450 | 4.009000 | 11.291450 | -0.86% | 1.33% | not_met_in_this_synthetic_suite |
| plan_and_full_cost | 20 | 19 | 100.00% | 100.00% | 40.42% | 7.338200 | 2.895500 | 10.233700 | -10.15% | 0.57% | not_met_in_this_synthetic_suite |

## 场景结果

| 场景 | 实验臂 | 计划匹配率 | 请求正确率 | 模拟读取率 | 模拟输入侧成本 USD | 模拟总成本 USD | 冷/热 | 切换 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| cold_start | original | 100.00% | 100.00% | 0.00% | 0.183750 | 0.213750 | 1/0 | 0 |
| cold_start | plan_fix_only | 100.00% | 100.00% | 0.00% | 0.183750 | 0.213750 | 1/0 | 0 |
| cold_start | plan_and_full_cost | 100.00% | 100.00% | 0.00% | 0.183750 | 0.213750 | 1/0 | 0 |
| same_model_stable_prefix | original | 100.00% | 100.00% | 61.90% | 0.497250 | 0.587250 | 1/2 | 0 |
| same_model_stable_prefix | plan_fix_only | 100.00% | 100.00% | 61.90% | 0.497250 | 0.587250 | 1/2 | 0 |
| same_model_stable_prefix | plan_and_full_cost | 100.00% | 100.00% | 61.90% | 0.497250 | 0.587250 | 1/2 | 0 |
| hot_strong_then_simple | original | 50.00% | 50.00% | 22.88% | 4.197250 | 4.801250 | 1/1 | 1 |
| hot_strong_then_simple | plan_fix_only | 100.00% | 100.00% | 47.71% | 4.099450 | 4.703450 | 2/2 | 1 |
| hot_strong_then_simple | plan_and_full_cost | 100.00% | 100.00% | 47.71% | 4.099450 | 4.703450 | 2/2 | 1 |
| lower_output_cost | original | 100.00% | 100.00% | 61.90% | 0.497250 | 3.527250 | 1/2 | 0 |
| lower_output_cost | plan_fix_only | 100.00% | 100.00% | 61.90% | 0.497250 | 3.527250 | 1/2 | 0 |
| lower_output_cost | plan_and_full_cost | 100.00% | 100.00% | 30.16% | 0.542500 | 2.472500 | 2/1 | 1 |
| prefix_changed_compaction | original | 100.00% | 100.00% | 35.19% | 0.673500 | 0.763500 | 2/1 | 0 |
| prefix_changed_compaction | plan_fix_only | 100.00% | 100.00% | 35.19% | 0.673500 | 0.763500 | 2/1 | 0 |
| prefix_changed_compaction | plan_and_full_cost | 100.00% | 100.00% | 35.19% | 0.673500 | 0.763500 | 2/1 | 0 |
| ttl_expired | original | 100.00% | 100.00% | 31.67% | 0.786000 | 0.876000 | 2/1 | 0 |
| ttl_expired | plan_fix_only | 100.00% | 100.00% | 31.67% | 0.786000 | 0.876000 | 2/1 | 0 |
| ttl_expired | plan_and_full_cost | 100.00% | 100.00% | 31.67% | 0.786000 | 0.876000 | 2/1 | 0 |
| unsupported_candidate | original | 100.00% | 100.00% | 63.89% | 0.545250 | 0.620250 | 1/2 | 0 |
| unsupported_candidate | plan_fix_only | 100.00% | 100.00% | 63.89% | 0.545250 | 0.620250 | 1/2 | 0 |
| unsupported_candidate | plan_and_full_cost | 100.00% | 100.00% | 31.94% | 0.555750 | 0.617250 | 1/1 | 1 |

## 观察

- `hot_strong_then_simple` 的 original 两个 Haiku turn marker 数为 0/0；两个修复臂在重复 Haiku turn 中共有 2 个模拟热读。
- `lower_output_cost` 全量成本臂第三 turn 的实际确定性结果为 `anthropic/claude-haiku-sim`（full_cost_recommends_switch）；旧公式实验臂保持 Sonnet。
- `unsupported_candidate` 全量成本臂第三 turn 的实际确定性结果为 `local/edge-small-sim`（full_cost_recommends_switch），最终计划和 marker 均为空。
- `prefix_changed_compaction` 第三 turn 的真实本地计划 fingerprint 改变，模拟 usage 为 read=0/write>0；`ttl_expired` 最终 turn 同样为模拟 miss/write。

## 失败边界

- `original` 在路由模型不同于配置默认模型时丢弃计划和 breakpoints；这只证明本地 materialization 行为，不是真实 provider miss。
- prefix lineage 改变或自上次命中超过 300 秒时，模拟器产生 miss/write；真实 provider 的缓存身份与过期行为未验证。
- 不支持缓存的 local 候选按普通输入计费，并且最终请求不得携带计划或 marker。
- 输出 token、输入 token、缓存前缀与 judge target 都是合成夹具，不能外推到生产流量。
- `original` 是 harness 内对 `cfc4d177` 语义的复刻，不是对该提交 checkout 或 binary 的直接执行。
- `latencyMs`、`qualityScore`、`realProviderHit`、`realBilledCostUsd` 均为 `null`；实际延迟与质量为 `not_measured_offline`。
- 20% 指标仅报告 `met` 或 `not_met_in_this_synthetic_suite`，绝不代表一般生产节省。

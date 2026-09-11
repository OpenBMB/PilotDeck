# Context-aware TokenSaver Router：16 条真实 A/B 实验

日期：2026-09-12

## 目标

验证两项改动能否在不增加错误降档的前提下，减少 Judge token 和执行模型开始前的路由等待：

1. 对明确的续做指令与高风险任务使用确定性 Gate，能确定时不调用 Judge；
2. 必须调用 Judge 时，不再只看最后一条用户消息，而是输入有长度上限的当前消息、前序任务锚点、上一条助手消息尾部、上一轮 tier 和结构化上下文特征。

同时加入低置信度保护、续做关系保护，以及对 Judge 将结论写入 thinking block、正文被截断的兼容解析。

## 实验方法

- 数据集：16 条人工标注的路由用例，覆盖中文和英文续做、确认执行、新任务、跨文件任务、并行子智能体和多论文技术报告。
- Baseline：修改前的 PilotDeck TokenSaver 行为，即“最后一条用户消息 + 上一轮 tier”，每条用例调用一次 Judge。
- Optimized：本次 context-aware Router。
- 真实 Judge：`hackathon/deepseek-v4-flash`。
- 执行档位：`simple`、`medium` 使用 `hackathon/deepseek-v4-flash`；`complex`、`reasoning` 使用 `hackathon/glm-5.3`。
- 计时范围：从 Router 开始决策到返回目标模型，不包含目标模型生成答案的时间。因此这里测的是“执行模型前置等待”，不是完整端到端 TTFT。
- Baseline 只执行一次并保存；后续优化运行复用同一份 Baseline，避免重复消耗 API。
- API Key 只通过运行环境注入，没有写入源码、日志或实验产物。

## 最终结果

| 指标 | Baseline | Optimized | 变化 |
| --- | ---: | ---: | ---: |
| 路由准确率 | 100%（16/16） | 100%（16/16） | 0 个百分点 |
| 错误降档率 | 0% | 0% | 不变 |
| Judge 调用次数 | 16 | 6 | **-62.5%** |
| Judge 输入 token | 7,076 | 3,348 | **-52.7%** |
| Judge 输出 token | 1,488 | 762 | **-48.8%** |
| Judge 总 token | 8,564 | 4,110 | **-52.0%** |
| 平均路由延迟 | 2,394.894 ms | 1,122.444 ms | **-53.1%** |
| 平均前置等待节省 | — | 1,272.450 ms/任务 | — |
| P95 路由延迟 | 3,118.954 ms | 6,245.910 ms | **+100.3%（退化）** |

16 条用例中有 13 条被确定性 Gate 直接处理，没有调用 Judge；剩余 3 条各发生 2 次 Judge 尝试，因此最终是 6 次调用，而不是 3 次。

服务端没有返回可用的货币成本字段，实验产物中的 `nativeCost = 0` 表示“缺少成本数据”，不代表调用免费。因此本实验只能证明 Judge 总 token 下降 52.0%，并把它作为推理成本下降的代理指标，不能宣称精确节省了多少人民币或美元。

## 结论

在这 16 条用例上，context-aware Router 保持了 100% 路由准确率和 0% 错误降档，同时将 Judge 调用减少 62.5%、Judge 总 token 减少 52.0%、平均路由延迟减少 53.1%。这支持“先确定性门控、歧义任务再 Judge”的方案在平均成本和平均等待上可行。

但 P95 延迟从 3.12 秒升至 6.25 秒。直接原因是当前 Judge 模型会生成较长 thinking，偶尔在输出正式标签前耗尽输出预算，从而触发第二次尝试。下一步应优先使用稳定的非思考型轻量 Judge，或使用供应商原生结构化输出；在解决尾延迟前，不能声称所有延迟指标都改善。

## 有效性边界

- 这 16 条用例参与过规则和提示词迭代，不是严格的 held-out 测试集，结果可能高估泛化能力。
- 数据集规模较小，尚不能代表 PilotDeck 的全部真实用户分布。
- 本实验只测 Router 决策，不测目标模型最终答案质量和端到端任务成功率。
- 后续验收应冻结当前实现，在独立的 held-out 多轮任务集上报告路由混淆矩阵、错误降档率、成功任务成本和完整 TTFT。

## 复现

完整真实实验：

```powershell
npm run e2e:real-router-context
```

只补跑受改动影响的用例：

```powershell
$env:PILOTDECK_ROUTER_BENCH_CASE_IDS = "new-reasoning-task"
$env:PILOTDECK_ROUTER_BENCH_BASELINE_INPUT = "<已保存的 baseline JSON>"
npm run e2e:real-router-context
```

真实调用需要在本地安全配置 API Key；不要把 Key 写进命令历史、源码或实验 JSON。

本次完整结果保存在工作区外层的 `context-aware-20260912-final.json`，其中包含逐用例路由结果、调用次数、token 和延迟，不包含 API Key。

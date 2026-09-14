# PilotRoute 缓存计划真实 API 实验

> 本实验调用了真实第三方 API。报告只使用服务端返回的 usage 和本地生成的 wire 元数据；未保存 API key 或模型输出。

## 控制条件

- Endpoint: `https://lab.cs.tsinghua.edu.cn/ai-platform/api/v1`
- Model: `glm-5.3-flash`（Anthropic-compatible 代理，非 Claude）
- 请求：2/12；每请求最多 16 输出 tokens。
- 状态：`stopped_cache_usage_not_verifiable`
- 停止原因：The smoke pair did not report a positive Anthropic cache write followed by a positive cache read.

## 结果

| 阶段 | 实验臂 | 重复 | Wire markers | 输入 tokens | Cache write | Cache read | 延迟 ms | HTTP |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| smoke | plan_fix_only | 1 | 4 | 6082 | n/a | n/a | 1458 | 200 |
| smoke | plan_fix_only | 2 | 4 | 6082 | n/a | n/a | 1478 | 200 |

## 结论

- 服务端连续接受了带 4 个生产 `cache_control` marker 的请求，但 cache write/read 值为 `null`；wire 接受已验证，缓存效果未验证，不能据此宣称命中率或节省提升。

## 汇总

| 实验臂 | 范围 | 请求 | Cache write | Cache read | Cache read ratio | 中位延迟 ms |
|---|---|---:|---:|---:|---:|---:|
| original | smoke | 0 | n/a | n/a | n/a | n/a |
| plan_fix_only | smoke | 2 | n/a | n/a | n/a | 1468 |

## 限制

- This endpoint exposes Anthropic-compatible request syntax but does not expose Claude models.
- cache_control acceptance does not prove that the upstream non-Claude model implements Anthropic prompt caching.
- Only provider-reported Anthropic cache usage fields are treated as evidence of a cache write or read.
- The endpoint did not provide pricing, so this experiment makes no billed-cost or savings claim.
- Model output is intentionally omitted; quality is not measured.

# 路由设置接口 TRD

状态：评审中　维护者：Router/Config 团队　目标读者：路由设置 UI、配置 API 和路由运行时维护者

## 范围

本文只描述设置页“智能体-路由”对配置 API 的使用，不新增路由专用 CRUD 资源，也不覆盖第三节“智能体常驻”的接口。路由运行时决策、fallback、auto-orchestrate 和统计文件读写由各自运行时模块负责。

## 鉴权与挂载

服务端在 `ui/server/index.js:580` 以 `authenticateToken` 挂载 `/api/config`。因此以下接口均要求有效登录 token；未认证行为由通用鉴权中间件返回 401/403，配置路由本身不重复实现鉴权。

## 接口总览

| 方法 | 路径 | 用途 | 成功响应 |
|---|---|---|---|
| GET | `/api/config` | 读取完整配置及 revision | 配置快照 |
| PUT | `/api/config` | 保存 raw YAML 或结构化配置并触发 reload | 保存后的配置快照 |
| POST | `/api/config/validate` | 不落盘地校验 raw YAML 或结构化配置 | `valid/errors/warnings` |

路由设置没有独立的 `/api/router` endpoint。页面对 `router` 对象的增删改必须通过上述接口提交。

## GET `/api/config`

请求无 body。响应由 `serializeConfigResponse` 生成，包含：

```json
{
  "exists": true,
  "path": "/path/to/pilotdeck.yaml",
  "raw": "router:\n  enabled: true\n",
  "revision": "<opaque revision of raw snapshot>",
  "config": { "router": {} },
  "validation": {
    "valid": true,
    "errors": [],
    "warnings": []
  }
}
```

`config` 中的 provider 密钥由通用配置服务遮罩；`raw` 在存在磁盘 YAML 时优先使用完整 YAML 的遮罩版本，以保留未建模的顶层配置。YAML 解析失败时响应包含 `configDisabled: true`、`parseError`，并将 `validation.valid` 置为 `false`。

## PUT `/api/config`

请求必须二选一：

### Raw YAML 提交

```json
{
  "raw": "router:\n  enabled: true\n  tokenSaver:\n    judge: openai/gpt-4.1-mini\n",
  "baseRevision": "<optional revision>",
  "providerRenames": []
}
```

`raw` 必须解析为对象；该路径用于保留完整 YAML 中的 `router`、`gateway`、`adapters` 等 UI schema 未建模字段。

### 结构化配置提交

```json
{
  "config": {
    "router": {
      "enabled": true,
      "tokenSaver": {
        "judge": "openai/gpt-4.1-mini",
        "defaultTier": "medium",
        "tiers": {
          "medium": {
            "model": "openai/gpt-4.1-mini",
            "description": "普通任务"
          }
        },
        "subagent": { "policy": "judge" }
      }
    }
  },
  "baseRevision": "<optional revision>"
}
```

服务端会在保存前恢复已遮罩的密钥、执行 provider/model 引用校验，并调用配置 reload。成功响应为最新配置快照，形状与 GET 相同，另外可能包含 `reload` 结果。

`baseRevision` 非空时必须等于当前磁盘快照的 revision；不一致返回 `409 CONFIG_CONFLICT`，并携带 `currentRevision`。该字段由设置 hook 在保存时自动发送，用于避免旧草稿覆盖新配置。接口没有单独的幂等键；同一请求重复提交仍是普通配置写入。

## POST `/api/config/validate`

请求可提交 `{ "raw": "..." }` 或 `{ "config": { ... } }`，不写入磁盘、不触发 reload：

```json
{
  "valid": false,
  "errors": ["..."],
  "warnings": []
}
```

校验通过返回 HTTP 200；校验失败或 raw YAML 解析失败返回 HTTP 400。该接口只能报告配置诊断，不能替代保存接口的并发和持久化约束。

## Router 配置字段

以下字段是当前 `parseRouterConfig` 直接解析且设置页使用的字段。字段缺省值以 parser/schema 为准；未列出的 router 字段不应由本文推断为设置页契约。

| 页面功能 | YAML 路径 | 当前校验/行为 |
|---|---|---|
| 总开关 | `router.enabled` | boolean；缺省为 `true`；明确为 false 时跳过其余 router 子配置解析和校验 |
| 场景默认模型 | `router.scenarios.default` | `provider/model` 字符串，provider 和 model 必须存在于 `model.providers` |
| 判定模型 | `router.tokenSaver.judge` | `provider/model` 字符串，必须能解析为已配置模型 |
| Token Saver 开关 | `router.tokenSaver.enabled` | boolean；缺省为 `true`；关闭后保留配置但运行时不执行判定 |
| 默认任务层级 | `router.tokenSaver.defaultTier` | 字符串，必须存在于 `router.tokenSaver.tiers` |
| 任务层级模型 | `router.tokenSaver.tiers.<name>.model` | 每个 tier 必须是对象；模型引用必须存在 |
| 任务层级说明 | `router.tokenSaver.tiers.<name>.description` | string；缺省时使用内置 tier 描述 |
| 子智能体策略 | `router.tokenSaver.subagent.policy` | 仅允许 `skip` 或 `judge` |
| 判定超时 | `router.tokenSaver.judgeTimeoutMs` | 正整数，单位毫秒 |
| 统计开关 | `router.stats.enabled` | boolean；缺省为 `true` |
| 输入价格 | `router.stats.modelPricing.<provider/model>.input` | 有限 number；非法类型不会生成有效价格值 |
| 输出价格 | `router.stats.modelPricing.<provider/model>.output` | 有限 number；非法类型不会生成有效价格值 |
| 缓存读取价格 | `router.stats.modelPricing.<provider/model>.cacheRead` | 有限 number；原型中的 `cache` 映射到此字段 |
| 价格单位 | `router.stats.modelPricing.<provider/model>.unit` | 可选 `$/百万 Token` 或 `¥/百万 Token`；仅持久化展示元数据，不参与金额换算；缺省按美元单位解释且不回写 YAML |

`router.tokenSaver.tiers` 是非空对象，tier 名称由配置对象动态决定，因此新增/删除自定义 tier 是对该对象的读改写。价格 key 必须是已配置的 `provider/model`，价格值必须是有限非负数字；`cacheWrite` 仍无对应后端字段。`unit` 只保存单位元数据，现有 input/output/cacheRead 计算保持不变。

统计基准模型 `router.stats.baselineModel` 在运行时优先于 `router.scenarios.default`，用于无路由基准成本计算；仅当未配置基准模型时才回退到场景默认模型。对象 `{ provider, model }` 与历史 `provider/model` 字符串均会解析为同一模型引用。

`agent.subagents.default` 属于 agent 配置而非 router 配置。值为 `inherit` 或缺省时继承 `agent.model`；显式值若无法解析，保存校验返回 warning 并继续按继承运行，不升级为 fatal。`router.tokenSaver.subagent.policy=judge` 时子智能体进入 Token Saver 判定，`skip` 时绕过判定并允许继承 `agent.model`。

## 模型池变更时的引用同步

路由模型引用不是独立副本。模型池 providerId/modelId 发生重命名时，`PUT /api/config` 必须在同一写入事务中同步以下路由字段：

- `router.scenarios.*`
- `router.fallback.*[]`
- `router.tokenSaver.judge`
- `router.tokenSaver.tiers.*.model`
- `router.stats.modelPricing` 的 provider/model key
- `router.stats.baselineModel.provider` / `router.stats.baselineModel.model`

`baselineModel` 推荐使用 `{ provider, model }` 对象；配置校验和 parser 同时兼容历史 `provider/model` 字符串格式，并在运行时统一解析为结构化模型引用。

provider 仅修改展示名称而不修改 providerId 时，路由引用保持不变；model 仅修改展示名称而不修改 modelId 时，路由引用也保持不变。修改 providerId/modelId 时，旧引用不得残留，价格数值必须原样保留；`router.stats.baselineModel` 的 provider/model 字段同步改写。

删除 provider/model 前，设置侧可通过 `GET /api/config/model-references` 查询引用；即使未先查询，`PUT /api/config` 仍必须在服务端拒绝仍被路由引用的对象，并返回 `409 MODEL_IN_USE`。

## 错误码与处理

| HTTP | 错误码/响应 | 触发条件 |
|---:|---|---|
| 400 | `Invalid YAML: ...` 或 `raw YAML must parse to an object` | raw 解析失败或顶层不是对象 |
| 400 | `Invalid config...` / `validation` | 结构化配置处于解析错误状态，或 `/validate` 诊断不通过 |
| 400 | `router.* must ...` / `... must reference a configured provider/model` | 路由开关、tier、策略、价格字段类型或模型引用非法 |
| 400 | `One or more masked secrets...` 等 | 遮罩密钥无法恢复或 provider 作用域改变后未重新提供密钥 |
| 409 | `CONFIG_CONFLICT` + `currentRevision` | `baseRevision` 落后于磁盘配置 |
| 500 | `{ "error": "..." }` | 配置读写、reload 或其他未分类服务异常 |

parser 产生的路由诊断包括 `ROUTER_ENABLED_INVALID`、`ROUTER_REF_FORMAT`、`ROUTER_REF_PROVIDER_NOT_FOUND`、`ROUTER_REF_MODEL_NOT_FOUND`、`ROUTER_TOKEN_SAVER_DEFAULT_TIER_UNKNOWN`、`ROUTER_TOKEN_SAVER_SUBAGENT_POLICY_INVALID` 等；具体诊断通过 `/api/config/validate` 的 `errors` 数组返回。

## 并发、超时和一致性

- `/api/config` 写入由 `withPilotDeckConfigWrite` 串行化；`baseRevision` 提供乐观并发冲突检测。
- 配置 API 本身未声明独立的 HTTP 超时；reload 超时和运行时加载策略由 `pilotdeckConfigReloader`/Gateway 负责，本文不虚构固定数值。
- 保存成功后路由返回重新读取的磁盘配置快照，并广播 `pilotdeck:config-broadcast`；保存失败时返回错误，不向客户端伪造成功快照。
- `POST /api/config/validate` 无副作用，可重复调用；GET 无副作用。PUT 没有专用幂等键，调用方应使用最新 `revision`。

## 源码与测试映射

- 鉴权挂载：`ui/server/index.js:580`
- HTTP 路由：`ui/server/routes/config.js:365-383`、`413-542`
- 响应/修订号：`ui/server/routes/config.js:235-279`
- 路由 parser：`src/router/config/parseRouterConfig.ts:48-113`、`260-428`、`561-608`
- 价格单位和数值校验：`src/router/config/parseRouterConfig.ts:590-665`、`src/router/config/schema.ts:1-8`
- 设置保存校验：`ui/server/services/pilotdeckConfig.js:274-374`
- 价格计算（忽略 `unit`）：`src/router/utils/modelPricing.ts:1-99`
- 子智能体策略和路由关闭态：`src/router/RouterRuntime.ts:360-430`
- provider/model 引用校验：`src/router/config/schema.ts:220-270`；模型池变更同步契约见 52 号 TRD
- 设置页调用：`ui/src/hooks/usePilotDeckConfig.ts:267-355`、`ui/src/components/settings/view/agentRoute/`
- 现有确定性测试：`ui/server/routes/config.test.js:694-815`、`ui/src/hooks/usePilotDeckConfig.test.tsx`、`tests/router/`

## 验收范围

应覆盖：路由开关、场景默认/判定模型、Token Saver 开关、默认 tier、自定义 tier 增删、tier 描述、skip/judge、判定超时、统计开关和 input/output/cacheRead/unit 价格；同时覆盖无效 provider/model、无效 defaultTier、非法价格值/单位、配置 revision 冲突、raw YAML 解析失败和 reload 错误。真实 provider 调用不属于普通确定性测试，标记为 `DEFER_EXTERNAL`。

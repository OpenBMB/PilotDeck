# Model Pool Settings API TRD

接口文档：[docs/model-pool-settings-api.md](../model-pool-settings-api.md)

状态：评审中　维护者：Config/UI 团队　目标读者：设置 UI、API 和模型维护者

## 代码边界

覆盖 `ui/server/routes/config.js`、`ui/server/routes/onboarding.js` 中可复用的模型探测生命周期、`ui/server/services/modelConnectionProbe.js` 和模型配置解析。模型运行时协议由模型协议相关 TRD 负责。

## 现有接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/config` | 读取完整 PilotDeck 配置 |
| PUT | `/api/config` | 保存 provider/model 配置并触发 reload |
| POST | `/api/config/models` | 获取 provider 远端模型列表 |
| POST | `/api/config/test-connection` | 单模型文字和图片探测 |
| POST | `/api/v1/model-connection-tests` | 兼容 onboarding 批量探测 |
| PUT | `/api/v1/model-connection-tests/:testId/image-capabilities` | 兼容 onboarding 图片能力补录 |

`PUT /api/config` 还负责 provider/model 标识变更时的引用同步。设置页不得自行只修改模型池 map 后再分别修补路由配置。

## 设置模型测试接口

设置页面使用以下 `/api/config` 接口；实现复用 onboarding 的 provider 解析、限流、TTL、用户隔离、取消和 probe 逻辑。

契约约定：路由沿用 UI API 的鉴权中间件，未认证请求不得进入处理器；单个模型 probe 超时为 10 秒，请求断开立即取消剩余模型并释放并发槽位。服务端最多同时运行 3 个 probe，单用户最多 1 个，测试创建接口按用户每分钟最多 5 次。`retryPolicy` 对象必填，字段可省略并使用默认值；`maxRetries`、`maxStreamRetries` 最大为 10，`streamIdleTimeoutMs` 最大为 300000，`baseDelayMs` 和 `maxDelayMs` 最大为 60000，且基础延迟不得超过最大延迟。创建测试不承诺幂等，`testId` 每次请求唯一；图片能力 PUT 对同一完整 payload 可重复提交，测试记录 TTL 为 10 分钟。

### `POST /api/config/test-connections`

请求字段：`providerId`、`protocol`、`endpoint`、`apiKey`、`models[]`、`retryPolicy`。`models` 必须为非空、去重后不超过服务端限制的模型 ID 列表。`retryPolicy` 的 `maxRetries`、`maxStreamRetries`、`streamIdleTimeoutMs` 为核心字段，`baseDelayMs` 和 `maxDelayMs` 可省略并使用服务端默认值。

预置 provider 的 `protocol` 使用服务端目录值；`endpoint` 非空时作为本次测试的有效地址并覆盖目录默认地址，空值时回退到目录默认地址。保存绑定时对 provider URL 使用同一有效地址规则，因此 provider 配置省略 URL 时仍可绑定目录默认地址；自定义 provider 必须提供合法 HTTP(S) 地址。

逐模型测试先执行文字探测；图片探测复用文字探测实际选中的 endpoint（包括探测器内部的 fallback 结果），不会重新从 provider 根地址开始选择。

成功响应返回 `testId`、聚合 `status`、`testedAt` 和逐模型结果：

```json
{
  "testId": "test_xxx",
  "status": "passed | failed | manual_input_required",
  "models": [
    {
      "modelId": "model-a",
      "textInput": "supported | unsupported",
      "imageInput": "supported | unsupported | unknown",
      "error": null
    }
  ],
  "testedAt": "2026-08-27T00:00:00.000Z"
}
```

### `PUT /api/config/test-connections/:testId/image-capabilities`

请求只包含本次测试中全部 `imageInput=unknown` 模型及 `supported/unsupported` 判断。缺少模型、增加非 unknown 模型、非法能力值、未知或过期 testId 均返回 4xx。补录后重新计算测试状态；全部模型文字通过且图片状态确定时，状态变为 `passed`。

### 测试结果绑定与引用校验

`PUT /api/config` 可携带 `modelTestBindings: [{ "testId": "test_xxx" }]`。服务端仅接受当前用户、未过期且状态为 `passed` 的测试记录，并核对 provider、协议、endpoint、API key 和模型集合后，将逐模型结果写入 `model.providers.<providerId>.models.<modelId>.connectionTest`。

绑定成功时，测试结果同时同步到该模型的 `multimodal.input`：图片支持写入 `["text", "image"]`，图片不支持写入 `["text"]`，供运行时模型能力解析使用。

仅当模型首次被 `agent.model` 引用且模型侧没有已通过的 `connectionTest` 时，才必须提交通过的 `modelTestBindings`，否则保存返回 `409 MODEL_TEST_REQUIRED`。路由、`agent.subagents.default` 和 `memory.model` 复用模型侧连接状态，不要求各自提交额外绑定，以兼容当前设置页保存流程。已有已引用模型修改连接参数继续兼容未绑定保存；provider/model 重命名按重命名元数据处理，不视为首次引用。

模型 provider 的 URL 为空时，配置服务在构建 Memory LLM 选项和运行时环境变量时读取 engine catalog 默认 URL；显式 URL 始终优先。

设置页在 Agent Model 页面选择尚未被测试通过的模型时，先调用批量测试接口；图片能力为 `unknown` 时提示用户补录，完成后将通过测试的 `testId` 随 `PUT /api/config` 提交。设置测试接口收到遮罩密钥时，会从当前配置复用真实密钥，客户端不会获得该密钥。

## provider/model 变更与引用同步

### 标识定义

- provider 配置 map 的 key 是 `providerId`；路由和其他设置中的模型引用统一使用 `providerId/modelId`。
- 仅修改 provider 的展示名称或目录显示名称、且 `providerId` 不变时，不需要改写引用。
- 修改 providerId 或 modelId 属于标识重命名，必须在同一个配置写入事务中同步所有引用。

### `PUT /api/config` 重命名元数据

模型池保存请求可携带以下元数据，用于消除新增/删除与重命名的歧义：

```json
{
  "providerRenames": [
    { "from": "provider-old", "to": "provider-new" }
  ],
  "modelRenames": [
    {
      "providerId": "provider-new",
      "from": "model-old",
      "to": "model-new"
    }
  ]
}
```

服务端要求重命名元数据与保存前后的 provider/model map 一致；目标 ID 已存在、源 ID 不存在、重复重命名或跨 provider 重命名均返回 `400 RENAME_INVALID`。provider rename 同时继续承担遮罩 API key 的恢复校验。

### 必须同步的引用

providerId 或 modelId 变更时，服务端必须原子改写以下路径中的 `providerId/modelId`：

- `agent.model`
- `agent.subagents.default`
- `memory.model`
- `router.scenarios.*`
- `router.fallback.*[]`
- `router.tokenSaver.judge`
- `router.tokenSaver.tiers.*.model`
- `router.stats.modelPricing` 的 key
- `router.stats.baselineModel.provider` / `router.stats.baselineModel.model`

同步和模型池配置写入必须成功或全部失败，不能产生旧引用残留。`router.stats.modelPricing` 的价格值保持不变，仅改写其 provider/model key。

## 当前实现状态与暂缓项

- `GET /api/config/model-references` 已实现，返回配置路径、引用值和引用类型，不返回密钥。
- `PUT /api/config` 已实现 provider/model 重命名后的引用同步，覆盖 agent、subagent、memory、router 和 pricing key；结构化配置与 raw YAML 均适用。
- provider/model 删除时已在保存阶段执行后端引用检查，存在引用返回 `409 MODEL_IN_USE`，不能仅依赖查询接口或前端确认框。
- 通用配置保存已支持 `modelTestBindings`，并仅对新增且被引用的模型强制通过测试；已有模型修改未携带绑定时保留兼容行为。
- `/api/v1/model-connection-tests*` 和 `/api/v1/model-configuration` 保留为 onboarding 兼容入口；设置页面不依赖这些路径。

## 错误与恢复

使用 `INVALID_REQUEST`、`RATE_LIMITED`、`TEST_NOT_FOUND`、`TEST_EXPIRED`、`TEST_NOT_PASSED`、`CONFIGURATION_MISMATCH`、`MODEL_TEST_REQUIRED`、`RENAME_INVALID`、`MODEL_IN_USE` 等稳定错误码。客户端断开必须取消当前 probe 并释放并发槽位；测试记录过期后不可补录。重命名和引用校验在现有配置写锁内完成，校验失败时不写入配置。

## 源码与测试映射

- 路由：`ui/server/routes/config.js:325-390`、`478-494`、`524-708`、`889-890`、`ui/server/routes/onboarding.js:99-190`、`164-258`
- 引用扫描/重写：`ui/server/services/modelReferences.js:40-134`
- 探测：`ui/server/services/modelConnectionProbe.js:115-165`
- 配置：`ui/server/services/pilotdeckConfig.js`、`src/model/config/parseModelConfig.ts`
- 测试：`ui/server/routes/config.test.js:414-500`、`ui/server/routes/onboarding.test.js`

## 验收

覆盖多模型成功、文字失败、图片成功/失败/unknown、人工补录、超时、取消、限流、TTL、重复模型、用户隔离和非法请求。真实 provider 调用标记 `DEFER_EXTERNAL`。

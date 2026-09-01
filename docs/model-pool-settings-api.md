# PilotDeck 模型池设置接口文档

## 1. 接口说明

- Server URL：`http://127.0.0.1:{SERVER_PORT}`
- API prefix：`/api/config`
- 默认本机端口：`3001`
- 数据格式：`application/json`
- 时间格式：ISO 8601 UTC
- 认证：`Authorization: Bearer <PilotDeck JWT>`
- 实例鉴权：当服务端配置 `API_KEY` 时，还必须提供 `X-API-Key`

`/api/config` 在 UI Server 中同时受全局 API-key 校验和 JWT 校验保护。缺少 JWT 或实例 API key 返回 `401`；JWT 无效返回 `403`。认证错误沿用现有响应格式 `{ "error": "..." }`。

模型测试业务错误使用：

```ts
type ApiError = {
  code: string;
  message: string;
  modelId?: string;
};
```

API key 只用于上游请求和服务端内存中的测试记录，不写入测试响应；日志和错误响应不得回显 API key。

## 2. 公共类型

```ts
type Protocol = "openai" | "openai-responses" | "anthropic" | "google";

type RetryPolicy = {
  maxRetries: number;
  maxStreamRetries: number;
  streamIdleTimeoutMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

type CapabilityStatus = "supported" | "unsupported" | "unknown";

type ModelTestResult = {
  modelId: string;
  textInput: CapabilityStatus;
  imageInput: CapabilityStatus;
  error: ApiError | null;
};

type ModelConnectionTestResult = {
  testId: string;
  status: "passed" | "failed" | "manual_input_required";
  manualInputRequired: boolean;
  models: ModelTestResult[];
  testedAt: string;
  error: ApiError | null;
};
```

`retryPolicy` 对象为必填；其字段可省略并使用服务端默认值。所有数值必须为非负整数，`maxRetries` 和 `maxStreamRetries` 最大为 10，`streamIdleTimeoutMs` 最大为 300000，`baseDelayMs` 和 `maxDelayMs` 最大为 60000，且 `baseDelayMs <= maxDelayMs`。服务端最多接受 10 个模型，模型 ID trim 后必须非空且不能重复。

## 3. 读取完整配置

### `GET /api/config`

返回当前 `pilotdeck.yaml` 的设置视图。密钥字段按现有配置序列化规则遮罩为 `********`。

成功响应 `200`：

```json
{
  "exists": true,
  "path": "/path/to/pilotdeck.yaml",
  "raw": "model:\n  providers: {}\n",
  "revision": "<opaque revision>",
  "config": {},
  "validation": {
    "valid": true,
    "errors": [],
    "warnings": []
  }
}
```

配置文件不存在时 `exists` 为 `false`。YAML 解析失败仍返回 `200`，同时返回 `configDisabled: true`、`parseError` 和 `validation.valid: false`；不得把无效 YAML 自动替换成默认配置。

## 4. 保存模型池配置

### `PUT /api/config`

这是完整配置写入口，不是模型池专属资源接口。模型池设置页可提交结构化配置：

```json
{
  "baseRevision": "<revision returned by GET /api/config>",
  "providerRenames": [],
  "modelRenames": [],
  "config": {
    "model": {
      "providers": {
        "openai": {
          "protocol": "openai",
          "url": "https://api.openai.com/v1",
          "apiKey": "********",
          "models": {
            "model-a": {
              "multimodal": { "input": ["text", "image"] }
            }
          }
        }
      }
    }
  }
}
```

也可提交 `{ "raw": "<YAML>" }` 走原始 YAML 保存路径。`baseRevision` 不为空时，如果配置已被其他写入修改，返回 `409 CONFIG_CONFLICT`，不会覆盖新配置。保存成功返回更新后的配置视图和 reload 结果。

本接口还负责 provider/model 标识变更时的引用同步。`providerRenames` 的元素为 `{ "from": "old", "to": "new" }`；`modelRenames` 的元素为 `{ "providerId": "provider", "from": "old-model", "to": "new-model" }`。重命名元数据必须与保存前后的配置 map 一致，否则返回 `400 RENAME_INVALID`。

providerId/modelId 重命名会在同一写入事务中改写 `agent.model`、`agent.subagents.default`、`memory.model`、`router.scenarios.*`、`router.fallback.*[]`、`router.tokenSaver.judge`、`router.tokenSaver.tiers.*.model` 以及 `router.stats.modelPricing` 的 key。仅修改展示名称而不修改 ID 时不改写引用；价格数值保持不变。

测试结果绑定规则见第 7 节。

常见状态码：

| HTTP | 错误码/字段 | 说明 |
| ---: | --- | --- |
| `200` | - | 保存并 reload 成功 |
| `400` | - | YAML、结构化配置、密钥遮罩或 provider rename 非法 |
| `400` | `RENAME_INVALID` | provider/model 重命名元数据与配置 map 不一致，或目标 ID 已存在 |
| `409` | `CONFIG_CONFLICT` | `baseRevision` 已过期 |
| `409` | `MODEL_IN_USE` | 删除的 provider/model 仍被 agent、subagent、memory 或 router 引用 |
| `500` | - | 写入或 reload 失败 |

### `GET /api/config/model-references`

查询 provider/model 当前被哪些配置引用。只传 `providerId` 时返回该 provider 下全部模型；同时传 `modelId` 时只返回指定模型。

成功响应 `200`：

```json
{
  "providerId": "openai",
  "modelId": "gpt-4.1",
  "references": [
    {
      "path": "router.tokenSaver.judge",
      "value": "openai/gpt-4.1",
      "kind": "router"
    }
  ]
}
```

该接口只返回配置路径和值，不返回 API key。删除保存时服务端必须再次执行同样的引用扫描，不能把该查询当作唯一保护。

## 5. 获取远端模型列表

### `POST /api/config/models`

请求：

```json
{
  "providerId": "openai",
  "providerType": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "secret"
}
```

`providerType` 支持 `openai`、`openai-responses`（按 OpenAI 兼容方式处理）、`anthropic` 和 `google`。当 `apiKey` 为 `********` 或空字符串时，服务端会尝试从当前配置中按 `providerId` 复用已保存密钥；不能复用时不会向上游发送遮罩值。

成功响应 `200`：

```json
{
  "ok": true,
  "models": [
    { "id": "model-a", "displayName": "Model A" }
  ]
}
```

模型列表响应支持上游 `data[]` 或 `models[]`，重复模型会被去重。缺少 `baseUrl` 返回 `400`；上游 HTTP 错误尽量保留上游状态码；超时返回 `500` 且错误消息为稳定的超时描述。

## 6. 单模型连接测试

### `POST /api/config/test-connection`

请求：

```json
{
  "providerId": "openai",
  "providerType": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "secret",
  "model": "model-a"
}
```

非 Ollama provider 必须提供 API key；Ollama 只要求 `baseUrl` 和 `model`。服务端先执行文字探测，再使用同一探测 endpoint 执行图片探测。

探测成功返回 `200`：

```json
{
  "ok": true,
  "message": "Connected successfully — Model model-a is available.",
  "imageSupport": {
    "status": "supported | unsupported | detection_failed",
    "supported": true,
    "source": "probe",
    "retryable": false,
    "manualConfirmationAllowed": false
  },
  "supportsImage": true,
  "imageCheckSource": "probe"
}
```

文字探测失败仍返回 `200`，业务结果为 `{ "ok": false, "error": "..." }`。缺少必要字段返回 `400`。单模型探测超时由探测服务处理，默认超时为 10 秒。

## 7. 批量文字/图片能力测试

### `POST /api/config/test-connections`

设置页面使用此接口，不调用 onboarding 路径。请求字段：

```json
{
  "providerId": "openai",
  "protocol": "openai",
  "endpoint": "https://api.openai.com/v1",
  "apiKey": "secret",
  "models": ["model-a", "model-b"],
  "retryPolicy": {
    "maxRetries": 2,
    "maxStreamRetries": 3,
    "streamIdleTimeoutMs": 30000,
    "baseDelayMs": 1000,
    "maxDelayMs": 60000
  }
}
```

`retryPolicy` 对象必须提供；其中所有字段均可省略并使用服务端默认值，并受上述非负整数和上限约束。

预置 provider 只需 `providerId`；自定义 provider 还必须提供合法的 `protocol` 和 HTTP(S) `endpoint`。预置 provider 的协议由服务端目录决定，非空 `endpoint` 可覆盖目录默认地址，省略或传空时使用目录默认地址。Ollama 可以省略或传空 API key，其他 provider 必须传非空 API key。

测试按模型依次执行文字和图片探测，返回 `200` 和完整测试记录：

```json
{
  "testId": "<opaque id>",
  "status": "passed",
  "manualInputRequired": false,
  "models": [
    {
      "modelId": "model-a",
      "textInput": "supported",
      "imageInput": "supported",
      "error": null
    }
  ],
  "testedAt": "2026-08-28T00:00:00.000Z",
  "error": null
}
```

当至少一个模型文字测试失败时，聚合状态为 `failed`；文字全部通过但存在图片 `unknown` 时为 `manual_input_required`。单模型失败不会阻止其他模型记录结果。

服务端约束：全局同时最多 3 个测试、单用户同时最多 1 个；单用户每分钟最多创建 5 次；测试记录 TTL 为 10 分钟；请求断开会取消未完成 probe 并释放并发名额。创建测试不承诺幂等，每次成功请求生成新的 `testId`。

状态码：

| HTTP | 错误码 | 说明 |
| ---: | --- | --- |
| `200` | - | 测试已执行，查看响应中的 `status` |
| `400` | `INVALID_REQUEST` | provider、模型列表、API key 或 retryPolicy 非法 |
| `429` | `RATE_LIMITED` | 触发创建频率或并发限制 |

### `PUT /api/config/test-connections/{testId}/image-capabilities`

仅用于补录本次测试中 `imageInput=unknown` 的模型：

```json
{
  "models": [
    { "modelId": "model-a", "imageInput": "supported" },
    { "modelId": "model-b", "imageInput": "unsupported" }
  ]
}
```

请求必须一次完整覆盖所有 unknown 模型，不能遗漏、重复、增加非 unknown 模型或提交其他能力值。成功返回更新后的 `ModelConnectionTestResult`；若文字全部通过且图片状态已确定，`status` 变为 `passed`。

状态码：

| HTTP | 错误码 | 说明 |
| ---: | --- | --- |
| `200` | - | 补录成功 |
| `400` | `INVALID_REQUEST` | 模型集合或能力值非法 |
| `404` | `TEST_NOT_FOUND` | testId 不存在或不属于当前用户 |
| `410` | `TEST_EXPIRED` | testId 已超过 10 分钟 TTL |

同一完整补录 payload 可重复提交；接口不会创建新的测试记录。

### 测试结果绑定

保存模型池时可在 `PUT /api/config` 中提交 `modelTestBindings: [{ "testId": "<opaque id>" }]`。服务端核对当前用户、TTL、provider/endpoint/API key 和模型集合后，将通过结果写入对应模型的 `connectionTest` 元数据，并同步更新 `multimodal.input`（支持图片为 `["text", "image"]`，不支持图片为 `["text"]`）。仅当模型首次被 `agent.model` 引用且没有已通过的 `connectionTest` 时，才必须提交通过的绑定；路由、`agent.subagents.default` 和 `memory.model` 复用模型侧状态，不要求各自提交额外绑定。缺少必要绑定时保存返回 `409 MODEL_TEST_REQUIRED`。已有已引用模型修改连接参数继续兼容未绑定保存。

provider URL 为空时，Memory LLM 选项和运行时环境变量使用 engine catalog 的默认 URL；显式 URL 优先。

设置页在 Agent Model 页面选择尚未被测试通过的模型时，会先调用 `POST /api/config/test-connections`；图片能力无法自动判定时提示用户补录，再将通过测试的 `testId` 随配置保存提交。已遮罩的 provider 密钥由设置测试接口从当前配置复用，不回显给客户端。

## 8. 兼容接口与明确缺口

以下 onboarding 接口仍保留，但设置页面不应依赖：

- `POST /api/v1/model-connection-tests`
- `PUT /api/v1/model-connection-tests/{testId}/image-capabilities`
- `PUT /api/v1/model-configuration`

已实现：

- `GET /api/config/model-references` 的实际路由和引用扫描；
- `PUT /api/config` 的 provider/model 重命名原子同步和 `MODEL_IN_USE` 删除拒绝，适用于结构化配置与 raw YAML。

## 9. 源码与测试映射

- 配置路由：`ui/server/routes/config.js:478-708`、`889-890`
- 引用扫描/重写：`ui/server/services/modelReferences.js:40-134`
- 批量测试处理器与生命周期：`ui/server/routes/onboarding.js:147-258`
- 单模型探测：`ui/server/routes/config.js:683-737`
- 探测实现：`ui/server/services/modelConnectionProbe.js:115-165`
- 路由注册与鉴权：`ui/server/index.js:500`、`ui/server/index.js:580-584`
- 确定性测试：`ui/server/routes/config.test.js:414-560`、`ui/server/routes/onboarding.test.js`

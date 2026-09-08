# PilotDeck Onboarding 后端接口文档

## 1. 接口说明

- Base URL：`http://127.0.0.1:{SERVER_PORT}/api/v1`
- 默认本机端口：`3001`
- 数据格式：`application/json`
- 认证：`Authorization: Bearer <PilotDeck JWT>`
- 可选实例鉴权：服务端配置 `API_KEY` 时还必须提供 `X-API-Key`
- 时间格式：ISO 8601 UTC
- OpenAPI：`docs/pilotdeck-onboarding-api.openapi.yaml`

统一错误响应：

```ts
type ApiError = {
  code: string;
  message: string;
  modelId?: string | null;
};
```

业务接口使用上述 `ApiError`。共享鉴权中间件保持现有响应：

```ts
type AuthError = {
  error: string;
};
```

缺少 JWT 或 `X-API-Key` 无效返回 `401`，JWT 无效返回 `403`。

## 2. 公共类型

```ts
type Protocol = "openai" | "openai-responses" | "anthropic" | "google";

type CapabilityStatus = "supported" | "unsupported" | "unknown";

type RetryPolicy = {
  maxRetries: number;
  maxStreamRetries: number;
  streamIdleTimeoutMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

type ModelTestResult = {
  modelId: string;
  textInput: CapabilityStatus;
  imageInput: CapabilityStatus;
  error?: ApiError | null;
};

type ModelConnectionTestResult = {
  testId: string;
  status: "passed" | "failed" | "manual_input_required";
  manualInputRequired: boolean;
  models: ModelTestResult[];
  testedAt: string;
  error?: ApiError | null;
};
```

默认重试值：

```json
{
  "maxRetries": 2,
  "maxStreamRetries": 3,
  "streamIdleTimeoutMs": 30000,
  "baseDelayMs": 1000,
  "maxDelayMs": 60000
}
```

所有数值必须为非负整数，且 `baseDelayMs <= maxDelayMs`。

## 3. 测试模型连接和能力

`POST /api/v1/model-connection-tests`

### 3.1 请求

```ts
type ModelConnectionTestRequest = {
  providerId: string;
  protocol?: Protocol | null;
  endpoint?: string | null;
  apiKey?: string;
  models: string[];
  retryPolicy: RetryPolicy;
};
```

约束：

- `models` 为 1 到 10 项，trim 后非空且不能重复。
- 预置服务商只使用 `providerId`，服务端忽略客户端传入的 `protocol` 和 `endpoint`。
- 自定义服务商必须提交实际服务商 ID、`protocol` 和绝对 HTTP(S) `endpoint`，不能使用保留 ID `custom`。
- Ollama 允许空 `apiKey`；其他服务商必须提供非空密钥。
- 请求体不接受未声明字段。
- 连接测试同时进行数限制为每用户 1 个、全局 3 个；客户端断开后服务端取消未完成探测并释放名额。

预置 ID：`anthropic`、`openai`、`openai-responses`、`dashscope`、`deepseek`、`gemini`、`openrouter`、`ollama`、`minimax`、`kimi`、`volcengine`、`zhipu`。

示例：

```http
POST /api/v1/model-connection-tests
Authorization: Bearer <token>
Content-Type: application/json

{
  "providerId": "anthropic",
  "apiKey": "sk-ant-...",
  "models": ["claude-sonnet-4-5", "claude-haiku-4-5"],
  "retryPolicy": {
    "maxRetries": 2,
    "maxStreamRetries": 3,
    "streamIdleTimeoutMs": 30000,
    "baseDelayMs": 1000,
    "maxDelayMs": 60000
  }
}
```

### 3.2 响应

请求被正常执行时返回 HTTP `200`。业务结果由 `status` 表达。

自动检测通过：

```json
{
  "testId": "tst_01J...",
  "status": "passed",
  "manualInputRequired": false,
  "models": [
    {
      "modelId": "claude-sonnet-4-5",
      "textInput": "supported",
      "imageInput": "supported",
      "error": null
    }
  ],
  "testedAt": "2026-08-18T10:00:00.000Z",
  "error": null
}
```

需要人工确认图片能力：

```json
{
  "testId": "tst_01J...",
  "status": "manual_input_required",
  "manualInputRequired": true,
  "models": [
    {
      "modelId": "custom-model",
      "textInput": "supported",
      "imageInput": "unknown",
      "error": {
        "code": "IMAGE_CAPABILITY_UNKNOWN",
        "message": "Image input capability could not be determined.",
        "modelId": "custom-model"
      }
    }
  ],
  "testedAt": "2026-08-18T10:00:00.000Z",
  "error": {
    "code": "IMAGE_CAPABILITY_UNKNOWN",
    "message": "One or more models require manual image capability input."
  }
}
```

文本测试失败：

```json
{
  "testId": "tst_01J...",
  "status": "failed",
  "manualInputRequired": false,
  "models": [
    {
      "modelId": "bad-model",
      "textInput": "unsupported",
      "imageInput": "unknown",
      "error": {
        "code": "MODEL_NOT_FOUND",
        "message": "The provider did not recognize this model.",
        "modelId": "bad-model"
      }
    }
  ],
  "testedAt": "2026-08-18T10:00:00.000Z",
  "error": {
    "code": "TEXT_TEST_FAILED",
    "message": "One or more models failed the text connection test."
  }
}
```

### 3.3 状态码

| HTTP | 说明 |
| ---: | --- |
| `200` | 测试已执行，查看响应中的业务状态 |
| `400` | 请求字段非法或自定义服务商参数缺失 |
| `401` | JWT 缺失，或实例 `X-API-Key` 无效 |
| `403` | JWT 无效 |
| `429` | 测试请求触发限流 |

## 4. 回填图片能力

`PUT /api/v1/model-connection-tests/{testId}/image-capabilities`

前端第一次收到 `manual_input_required` 后展示失败状态；用户再次点击“重新测试”时直接打开人工标记弹窗，不需要再次调用连接测试接口。

### 4.1 请求

```ts
type ManualImageCapabilitiesRequest = {
  models: Array<{
    modelId: string;
    imageInput: "supported" | "unsupported";
  }>;
};
```

必须一次提交该测试中全部 `imageInput=unknown` 的模型，不能遗漏、重复或增加其他模型。

```http
PUT /api/v1/model-connection-tests/tst_01J.../image-capabilities
Authorization: Bearer <token>
Content-Type: application/json

{
  "models": [
    {"modelId": "custom-text", "imageInput": "unsupported"},
    {"modelId": "custom-vision", "imageInput": "supported"}
  ]
}
```

### 4.2 响应

成功返回 HTTP `200` 和更新后的 `ModelConnectionTestResult`：

```json
{
  "testId": "tst_01J...",
  "status": "passed",
  "manualInputRequired": false,
  "models": [
    {"modelId": "custom-text", "textInput": "supported", "imageInput": "unsupported", "error": null},
    {"modelId": "custom-vision", "textInput": "supported", "imageInput": "supported", "error": null}
  ],
  "testedAt": "2026-08-18T10:00:00.000Z",
  "error": null
}
```

| HTTP | 错误码 | 说明 |
| ---: | --- | --- |
| `400` | `INVALID_REQUEST` | 模型遗漏、重复、额外提交或取值非法 |
| `401` | - | JWT 缺失，或实例 `X-API-Key` 无效 |
| `403` | - | JWT 无效 |
| `404` | `TEST_NOT_FOUND` | testId 不存在或不属于当前用户 |
| `410` | `TEST_EXPIRED` | testId 超过 10 分钟有效期 |

## 5. 保存模型配置

`PUT /api/v1/model-configuration`

### 5.1 请求

```ts
type ModelConfigurationRequest = {
  testId: string;
  providerId: string;
  protocol?: Protocol | null;
  endpoint?: string | null;
  apiKey?: string | null;
  models: Array<{
    modelId: string;
    textInput: boolean;
    imageInput: boolean;
  }>;
  retryPolicy: RetryPolicy;
};
```

约束：

- `testId` 必须属于当前用户、未过期且状态为 `passed`。
- 服务商、协议、地址、模型集合、能力和重试策略必须与测试结果一致。
- 新配置必须提交 `apiKey`，Ollama 除外。
- 更新已有服务商时 `apiKey=null` 表示保留原密钥；空字符串非法。
- `models[0]` 成为 `agent.model` 默认模型。
- API Key 写入本机 `~/.pilotdeck/pilotdeck.yaml`，不会出现在响应或服务端日志中。

示例：

```json
{
  "testId": "tst_01J...",
  "providerId": "anthropic",
  "apiKey": "sk-ant-...",
  "models": [
    {"modelId": "claude-sonnet-4-5", "textInput": true, "imageInput": true},
    {"modelId": "claude-haiku-4-5", "textInput": true, "imageInput": true}
  ],
  "retryPolicy": {
    "maxRetries": 2,
    "maxStreamRetries": 3,
    "streamIdleTimeoutMs": 30000,
    "baseDelayMs": 1000,
    "maxDelayMs": 60000
  }
}
```

### 5.2 响应

响应 `200`：

```json
{
  "configurationId": "cfg_01J...",
  "savedAt": "2026-08-18T10:02:00.000Z"
}
```

| HTTP | 错误码 | 说明 |
| ---: | --- | --- |
| `400` | `INVALID_REQUEST` | 请求字段或 API Key 语义非法 |
| `401` | - | JWT 缺失，或实例 `X-API-Key` 无效 |
| `403` | - | JWT 无效 |
| `404` | `TEST_NOT_FOUND` | testId 不存在或不属于当前用户 |
| `409` | `TEST_NOT_PASSED` | 测试尚未通过 |
| `409` | `CONFIGURATION_MISMATCH` | 保存内容与测试内容不同 |
| `410` | `TEST_EXPIRED` | testId 已过期 |

## 6. 创建或关联工作区

`POST /api/v1/workspaces`

### 6.1 请求

```ts
type CreateWorkspaceRequest = {
  type: "existing" | "new";
  path: string;
  githubUrl?: string | null;
  modelConfigurationId?: string | null;
};
```

约束：

- `path` 必须是本机绝对路径。
- `existing` 要求路径已存在且是可访问目录，不接受 `githubUrl`。
- `new` 创建目录；`githubUrl` 存在时将仓库克隆到目标目录下并注册实际仓库目录。
- clone 同时进行数限制为每用户 1 个、全局 2 个，最长执行 5 分钟；客户端断开时终止 Git 子进程并清理本次 staging 目录。
- `modelConfigurationId` 省略时使用当前默认配置；提供时必须匹配最近保存的配置。
- `modelConfigurationId` 为空字符串非法；`null` 与省略等价。
- HTTP API 不提供文件夹枚举。目录选择由桌面端原生选择器完成。

已有工作区：

```json
{
  "type": "existing",
  "path": "/Users/alice/work/pilotdeck-project",
  "modelConfigurationId": "cfg_01J..."
}
```

新建并克隆：

```json
{
  "type": "new",
  "path": "/Users/alice/workspaces",
  "githubUrl": "https://github.com/example/project.git",
  "modelConfigurationId": "cfg_01J..."
}
```

### 6.2 响应

响应 `201`：

```ts
type Workspace = {
  id: string;
  type: "existing" | "new";
  path: string;
  status: "ready";
};
```

```json
{
  "id": "project--Users-alice-work-pilotdeck-project",
  "type": "existing",
  "path": "/Users/alice/work/pilotdeck-project",
  "status": "ready"
}
```

| HTTP | 错误码 | 说明 |
| ---: | --- | --- |
| `400` | `INVALID_REQUEST` | 类型、路径或 Git URL 非法 |
| `400` | `PATH_NOT_FOUND` | existing 路径不存在 |
| `400` | `PATH_NOT_WRITABLE` | 目标或父目录不可写 |
| `401` | - | JWT 缺失，或实例 `X-API-Key` 无效 |
| `403` | - | JWT 无效 |
| `409` | `WORKSPACE_CONFLICT` | 目录或项目已存在 |
| `409` | `CONFIGURATION_MISMATCH` | 配置 ID 不是当前配置 |
| `409` | `GIT_CLONE_FAILED` | Git clone 失败 |
| `429` | `RATE_LIMITED` | 当前用户或服务器已有过多进行中的 clone |

## 7. 推荐调用流程

```text
POST model-connection-tests
  |-- passed --------------------------+
  |                                    |
  `-- manual_input_required            |
        `-- PUT image-capabilities ----+
                                       v
                         PUT model-configuration
                                       |
                                       v
                              POST workspaces
```

客户端必须遵守以下门禁：

1. 连接测试未通过时不能保存模型配置。
2. 模型配置未保存时不能创建工作区。
3. 工作区未返回 `ready` 时不能进入主工作区。
4. 人工图片能力弹窗取消后保留原来的失败状态，不隐式标记为通过。
5. 测试请求完成后仅当 Provider、协议、URL、模型和 API Key 仍与请求开始时一致时才能接受结果；任一有效配置变化都必须废弃旧 `testId` 和成功状态。自定义 Provider ID 在请求和配置持久化前统一为小写。
6. 保存使用测试成功时的配置快照；如果配置在保存期间发生变化，客户端必须在 PUT 前放弃这次写入并要求重新测试。
7. 自定义 Provider ID 不得使用预置 provider 或其兼容别名（例如 `google`、`gemini`、`moonshot`、`kimi`）。
8. 保存请求从开始到 PUT 完成期间必须禁用所有会影响配置快照的表单控件，避免已发出的旧快照被用户输入覆盖或误导 onboarding 完成状态。

## 8. 资源路径

后端交付包含以下静态资源：

| URL | 仓库文件 |
| --- | --- |
| `/pilotdeck-logo-lockup-transparent.png` | `ui/public/pilotdeck-logo-lockup-transparent.png` |
| `/pilotdeck-p-mark-transparent.png` | `ui/public/pilotdeck-p-mark-transparent.png` |
| `/pilotdeck-p-mark-transparent-v2.png` | `ui/public/pilotdeck-p-mark-transparent-v2.png` |
| `/onboarding/providers/anthropic.svg` | `ui/public/onboarding/providers/anthropic.svg` |
| `/onboarding/providers/bailian-color.svg` | `ui/public/onboarding/providers/bailian-color.svg` |
| `/onboarding/providers/deepseek-color.svg` | `ui/public/onboarding/providers/deepseek-color.svg` |
| `/onboarding/providers/gemini-color.svg` | `ui/public/onboarding/providers/gemini-color.svg` |
| `/onboarding/providers/kimi.svg` | `ui/public/onboarding/providers/kimi.svg` |
| `/onboarding/providers/minimax-color.svg` | `ui/public/onboarding/providers/minimax-color.svg` |
| `/onboarding/providers/ollama.svg` | `ui/public/onboarding/providers/ollama.svg` |
| `/onboarding/providers/openai.svg` | `ui/public/onboarding/providers/openai.svg` (OpenAI 与 OpenAI Responses 共用) |
| `/onboarding/providers/openrouter-color.svg` | `ui/public/onboarding/providers/openrouter-color.svg` |
| `/onboarding/providers/volcengine-color.svg` | `ui/public/onboarding/providers/volcengine-color.svg` |
| `/onboarding/providers/zhipu-color.svg` | `ui/public/onboarding/providers/zhipu-color.svg` |

图片能力探测使用内部资源 `ui/server/assets/onboarding/image-capability-probe.png`，不作为公共 URL 契约。

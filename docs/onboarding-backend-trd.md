# PilotDeck Onboarding 后端 TRD

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档状态 | Draft |
| 原型交接 | `PilotDeck-onboarding-code-api-handoff-2026-08-18-v2.zip` |
| 适用版本 | PilotDeck Web UI Server / Local Gateway |
| 目标读者 | 后端、Gateway、前端联调和测试 |

## 2. 背景

新的首次使用引导包含语言选择、模型服务商选择、模型连接与能力测试、工作区创建四个阶段。当前原型只模拟连接失败、图片能力人工确认和工作区创建，没有真实网络请求。

PilotDeck 已有以下基础能力：

- `ui/server` 提供 Express HTTP 服务、JWT 鉴权和静态资源托管。
- `ui/server/routes/config.js` 已支持 OpenAI、OpenAI Responses、Anthropic 和 Google 协议的文本连通性测试。
- `src/model/catalog/providers.ts` 是运行时服务商、默认地址和模型能力的权威目录。
- `ui/server/services/pilotdeckConfig.js` 负责读写 `~/.pilotdeck/pilotdeck.yaml` 并保留未知配置段。
- `ui/server/routes/projects.js` 已实现路径校验、已有目录关联、新目录创建和 Git clone。

本设计在这些能力之上增加一组稳定的 `/api/v1` onboarding 接口，不新增独立后端进程。

## 3. 目标

### 3.1 目标

1. 提供原型所需的四个完整 HTTP 接口。
2. 逐模型验证文本调用，并识别或人工确认图片输入能力。
3. 只有通过连接测试的配置才能写入 PilotDeck 配置。
4. 创建或关联工作区，并注册到现有项目系统。
5. 提供 OpenAPI、错误码和品牌资源清单，支持独立前端联调。
6. 复用现有模型、配置和工作区实现，避免形成第二套运行时语义。


## 4. 总体架构

```text
Onboarding Client
  |  Authorization: Bearer <JWT>
  v
ui/server/index.js
  `-- /api/v1 -> onboarding routes
        |-- Connection Test Service
        |     |-- Provider Catalog
        |     |-- Protocol Probe
        |     `-- In-memory Test Store (TTL)
        |-- Model Configuration Service -> pilotdeck.yaml
        `-- Workspace Service -> filesystem / git / project registry
```

接口挂载在现有 UI Server 的 `SERVER_PORT`。开发环境继续通过 Vite `/api` proxy 转发，生产环境由同一 Express 服务响应 API 和静态资源。

## 5. API 模块设计

建议新增 `ui/server/routes/onboarding.js`，挂载到 `/api/v1`。路由只负责鉴权后的参数解析、状态码和响应序列化，业务逻辑拆分为可测试服务：

- `modelConnectionProbe`：协议请求构造、文本探测、图片探测和错误归一化。
- `onboardingTestStore`：保存短期测试记录，校验用户归属和 TTL。
- `onboardingConfigService`：校验通过记录，原子更新 PilotDeck YAML。
- `workspaceService`：复用路径验证、Git clone 和项目注册。

现有 `/api/config/test-connection` 应与新接口共享底层文本探测代码，保留原接口的请求和响应行为。

## 6. 服务商解析

预置服务商的协议和地址必须由服务端目录决定，忽略客户端传入的 `protocol` 和 `endpoint`。原型 ID 与 PilotDeck 规范 ID 的映射如下：

| 原型 `providerId` | 规范 ID | 协议 |
| --- | --- | --- |
| `anthropic` | `anthropic` | `anthropic` |
| `openai` | `openai` | `openai` |
| `openai-responses` | `openai-responses` | `openai-responses` |
| `dashscope` | `dashscope` | `openai` |
| `deepseek` | `deepseek` | `openai` |
| `gemini` | `google` | `google` |
| `openrouter` | `openrouter` | `openai` |
| `ollama` | `ollama` | `openai` |
| `minimax` | `minimax` | `openai` |
| `kimi` | `moonshot` | `openai` |
| `volcengine` | `volc_ark` | `openai` |
| `zhipu` | `zhipu` | `openai` |

`custom` 不映射到目录。它必须提交受支持的 `protocol` 和合法绝对 HTTP(S) `endpoint`。保存配置时，自定义服务商使用请求中的 `providerId`；客户端应提交稳定、非空且不含空白的 ID，不能提交保留 ID `custom`。

## 7. 连接与能力测试

### 7.1 流程

1. 校验服务商、模型列表、API Key 和重试参数。
2. 对每个模型发起最小文本探测，要求返回非空文本或合法 reasoning 输出。
3. 文本成功后发起最小图片输入探测，测试图片使用后端随包资源 `ui/server/assets/onboarding/image-capability-probe.png`。
4. 汇总每个模型的 `textInput`、`imageInput` 和错误。
5. 生成 `testId`，将测试上下文保存到当前进程内存。

文本能力失败时，整体状态为 `failed`。文本成功且图片能力均已明确为 `supported` 或 `unsupported` 时，整体状态为 `passed`。存在无法可靠判断的图片能力时，整体状态为 `manual_input_required`。

图片探测收到明确的“模型不支持图片”响应时记录 `unsupported`；网络错误、非结构化 provider 错误或无法区分配置错误与能力错误时记录 `unknown`，不得猜测为不支持。

### 7.2 测试记录

测试记录结构：

```ts
type StoredConnectionTest = {
  id: string;
  userId: number | string;
  provider: {
    providerId: string;
    protocol: "openai" | "openai-responses" | "anthropic" | "google";
    endpoint: string;
    custom: boolean;
  };
  retry: RetryPolicy;
  keyFingerprint: Uint8Array;
  models: ModelTestResult[];
  status: "passed" | "failed" | "manual_input_required";
  testedAt: string;
  expiresAt: number;
};
```

默认 TTL 为 10 分钟。记录按 `userId + id` 隔离；不存在返回 `404`，已存在但过期返回 `410`。`keyFingerprint` 只用于保存时绑定测试凭证，不可逆且不对外返回；测试记录不保存明文 API Key、provider 原始响应或完整请求体。保存配置成功后立即删除对应记录，其余记录按访问时惰性清理并由定时任务清理。

单次请求最多测试 10 个模型，模型按请求顺序串行执行文本和图片探测。同时执行的连接测试限制为每用户 1 个、进程全局 3 个；客户端断开时取消当前 fetch 和重试等待，并立即释放执行名额。

### 7.3 手工图片能力回填

只允许提交当前测试中 `imageInput=unknown` 的模型，且必须一次覆盖全部未知模型。重复、遗漏或额外模型返回 `400`。回填后所有文本成功且图片能力明确时，测试状态变为 `passed`。

## 8. 模型配置写入

`PUT /api/v1/model-configuration` 必须引用同一用户、未过期且状态为 `passed` 的测试。请求中的服务商、协议、地址、模型集合和能力必须与测试记录一致，防止测试后替换配置。

配置写入使用现有 `pilotdeck.yaml` 的原子读改写路径，并保留所有无关 section。写入映射：

```yaml
agent:
  model: canonical-provider/first-model
model:
  providers:
    canonical-provider:
      protocol: openai
      url: https://example.com/v1
      apiKey: plaintext-compatible-with-current-runtime
      retry:
        requestMaxRetries: 2
        streamMaxRetries: 3
        streamIdleTimeoutMs: 30000
        baseDelayMs: 1000
        maxDelayMs: 60000
      models:
        example-model:
          multimodal:
            input: [text, image]
webui:
  onboarding:
    modelConfigurationId: cfg_...
    savedAt: 2026-08-18T10:00:00.000Z
```

`imageInput=false` 写入 `input: [text]`，`imageInput=true` 写入 `input: [text, image]`。`textInput=false` 的模型不能保存。

新服务商必须提交非空 `apiKey`，Ollama 除外。更新已有服务商时 `apiKey=null` 表示保留磁盘中的原密钥；空字符串非法，不承担删除语义。响应和日志不得包含密钥。

`configurationId` 使用随机稳定 ID，随配置写入 YAML。后续工作区请求提供该 ID 时必须与当前配置匹配。

## 9. 工作区创建

`POST /api/v1/workspaces` 复用 `validateWorkspacePath` 和 `addProjectManually`：

- `existing`：路径必须存在、可访问且是目录，随后注册为 PilotDeck 项目。
- `new`：目标不能与已有非空目录冲突；创建目录后，可选执行无交互 `git clone`。
- 提供 `githubUrl` 时，仅接受 HTTP(S) 或 SSH Git URL；clone 失败时清理本次创建的部分 clone 目录，不删除调用前已存在的目录。
- clone 同时执行限制为每用户 1 个、进程全局 2 个，单次最长 5 分钟；客户端断开或超时时终止 Git 子进程并清理本次 staging 目录。
- 返回的 `path` 是最终注册的项目根目录。带 GitHub URL 时为 clone 后的仓库目录。
- `modelConfigurationId` 省略时使用当前默认配置；提供时必须匹配 `webui.onboarding.modelConfigurationId`。

目录选择器不属于 HTTP API。桌面客户端应通过 native bridge 返回路径，再调用本接口。

## 10. 错误模型

所有新接口的业务错误使用统一错误体：

```ts
type ApiError = {
  code: string;
  message: string;
  modelId?: string | null;
};
```

主要错误码：

| 错误码 | HTTP | 场景 |
| --- | ---: | --- |
| `INVALID_REQUEST` | 400 | 字段缺失、类型或取值非法 |
| `INVALID_API_KEY` | 200 | 连接测试的业务失败 |
| `ENDPOINT_UNREACHABLE` | 200 | 服务地址无法访问 |
| `UNSUPPORTED_PROTOCOL` | 400 | 自定义协议不支持 |
| `MODEL_NOT_FOUND` | 200 | provider 不存在指定模型 |
| `TEXT_TEST_FAILED` | 200 | 模型未返回有效文本 |
| `IMAGE_TEST_FAILED` | 200 | 图片测试明确失败 |
| `IMAGE_CAPABILITY_UNKNOWN` | 200 | 需要人工确认图片能力 |
| `TEST_NOT_FOUND` | 404 | testId 不存在或不属于当前用户 |
| `TEST_EXPIRED` | 410 | testId 已过期 |
| `TEST_NOT_PASSED` | 409 | 未通过测试就保存配置 |
| `CONFIGURATION_MISMATCH` | 409 | 保存内容与测试记录不一致 |
| `PATH_NOT_FOUND` | 400 | existing 工作区路径不存在 |
| `PATH_NOT_WRITABLE` | 400 | 目标或父目录不可写 |
| `WORKSPACE_CONFLICT` | 409 | 目标目录或项目已存在 |
| `GIT_CLONE_FAILED` | 409 | Git clone 失败 |
| `RATE_LIMITED` | 429 | 连接测试请求过于频繁，或探测/clone 已达到进行中任务上限 |

连接测试使用 HTTP 200 表示请求已执行，具体成功与否由 `status` 和模型结果表达。协议级参数错误、资源不存在和冲突使用对应 HTTP 状态码。鉴权失败沿用共享中间件的 `{ "error": string }`：缺少 JWT 为 `401`，JWT 无效为 `403`。

## 11. 认证、日志与资源

- 四个接口全部使用现有 `validateApiKey` 和 `authenticateToken`；配置 `API_KEY` 时还必须提供 `X-API-Key`，本机禁用登录模式沿用当前自动用户语义。
- 日志可以记录 testId、规范服务商 ID、模型 ID、耗时、状态和错误码。
- 日志不得记录 Authorization、API Key、provider 请求头、provider 原始响应或带凭证的 Git URL。
- 静态品牌资源放在 `ui/public/`，由现有 `express.static` 托管：
  - `pilotdeck-logo-lockup-transparent.png`
  - `pilotdeck-p-mark-transparent.png`
  - `pilotdeck-p-mark-transparent-v2.png`
- provider 图标固定随仓库交付在 `ui/public/onboarding/providers/`：`anthropic.svg`、`bailian-color.svg`、`deepseek-color.svg`、`gemini-color.svg`、`kimi.svg`、`minimax-color.svg`、`ollama.svg`、`openai.svg`、`openrouter-color.svg`、`volcengine-color.svg`、`zhipu-color.svg`。`openai.svg` 同时用于 OpenAI 和 OpenAI Responses；Custom 使用现有通用设置图标。
- 图片能力探测资源放在 `ui/server/assets/onboarding/image-capability-probe.png`，不作为公共静态文件暴露。

## 12. 测试策略

### 12.1 路由测试

- 未认证请求被拒绝。
- 严格校验所有请求字段和 `additionalProperties`。
- 预置服务商忽略客户端协议和地址，自定义服务商必须提供二者。
- 原型 provider ID 正确映射为运行时 ID。

### 12.2 连接测试

- 四种协议的文本和图片请求构造正确。
- 多模型结果互不覆盖，单个失败不会丢失其他结果。
- 明确不支持图片、未知能力、无效密钥、模型不存在和网络错误映射正确。
- testId 用户隔离、TTL、全量人工回填和成功后删除符合状态机。

### 12.3 配置与工作区

- 保存配置保留 router、gateway、alwaysOn 等无关 YAML section。
- 重试字段与 `multimodal.input` 映射正确，密钥 null/空字符串语义正确。
- existing/new/Git clone 成功、路径冲突、不可写路径和 clone 失败均有覆盖。
- OpenAPI 文件能够通过解析器加载，品牌与探测图片资源存在。

## 13. 交付顺序

1. 提取共享模型探测服务并保持原接口测试通过。
2. 实现测试记录和两个连接测试接口。
3. 实现模型配置保存接口。
4. 提取工作区共享服务并实现 `/api/v1/workspaces`。
5. 加入 OpenAPI、静态品牌资源和图片探测资源。
6. 完成 focused 路由、服务和资源测试。

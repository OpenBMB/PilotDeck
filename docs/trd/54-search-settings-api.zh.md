# 智能体搜索设置接口 TRD

状态：评审中　维护者：Tools/Config/UI 团队　目标读者：设置 UI、API 和工具维护者

## 1. 范围与鉴权

本 TRD 覆盖设置页中 `tools.webSearch` 的读取、保存、校验和连通性测试。第三节“智能体常驻”不在范围内。

接口基路径为 `/api/config`。服务端在 `ui/server/index.js` 以 `authenticateToken` 挂载该路由，因此请求需要已登录用户的 Bearer token；缺少 token 时由鉴权中间件返回 `401`。JSON 请求必须发送 `Content-Type: application/json`。

| 方法 | 路径 | 用途 | 是否持久化 |
|---|---|---|---|
| GET | `/api/config` | 读取完整配置（包含 `tools.webSearch`） | 否 |
| PUT | `/api/config` | 保存原始 YAML 或结构化配置 | 是 |
| POST | `/api/config/validate` | 校验原始 YAML 或结构化配置 | 否 |
| POST | `/api/config/test-web-search` | 使用固定探测词测试搜索服务 | 否 |

## 2. 配置对象

搜索配置位于 `tools.webSearch`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `enabled` | boolean | 是否启用搜索工具；未提供时由调用方按默认启用处理；明确为 `false` 时跳过其余搜索子配置解析和校验 |
| `provider` | enum | `glm`、`tavily`、`custom`、`serper`、`brave` |
| `apiKey` | string | 当前 provider 的密钥；读取配置时会被遮罩 |
| `endpoint` | string | provider endpoint 覆盖值；内置 provider 可省略以使用默认值；必须为 HTTP(S) URL |
| `customProvider` | object | `custom` provider 的请求和结果映射规则 |

配置 parser 对未知字段产生 warning；未知 provider 等结构错误产生 fatal diagnostic。`enabled: false` 时只保留禁用状态，其他搜索子字段视为不活跃配置并跳过解析和校验；配置文件中的原始 YAML 仍由通用配置保存层保留。搜索启用或未显式禁用时，`POST /api/config/validate` 和 `PUT /api/config` 均调用该 parser，因此非法 provider 或非 HTTP(S) endpoint 会在通用配置接口拒绝。`apiKey` 可以省略，以支持运行时环境变量注入；未显式设置 provider 时，运行时按 `TAVILY_API_KEY`、`GLM_WEB_SEARCH_API_KEY`、`ZAI_API_KEY`、`SERPER_API_KEY`、`BRAVE_API_KEY`、`CUSTOM_WEB_SEARCH_API_KEY` 顺序选择第一个有值的 provider，以保持既有 Tavily 环境变量行为。显式 provider 始终优先；`custom` 的 endpoint 和调用测试时的凭证要求由运行时及测试接口校验。`customProvider` 支持以下字段：

| 字段 | 类型 | 默认值/取值 |
|---|---|---|
| `name` | string | `custom` |
| `auth` | enum | `bearer`、`bodyApiKey`、`queryApiKey`、`none`；默认 `bearer` |
| `method` | enum | `GET`、`POST`；默认 `POST` |
| `queryParam` | string | `query` |
| `apiKeyParam` | string | `api_key` |
| `resultsPath` | string | 空；为空时尝试通用结果字段 |
| `titleField` / `urlField` / `snippetField` / `sourceField` / `publishedAtField` | string | 分别为 `title`、`url`、`snippet`、`source`、`publishedAt` |

## 3. `GET /api/config`

无请求体。返回完整配置快照，敏感字段已遮罩：

```json
{
  "exists": true,
  "path": "/.../pilotdeck.yaml",
  "raw": "tools:\n  webSearch:\n    provider: serper\n    apiKey: ********\n",
  "revision": "...",
  "config": {
    "tools": {
      "webSearch": {
        "enabled": true,
        "provider": "serper",
        "apiKey": "********",
        "endpoint": "https://google.serper.dev/search"
      }
    }
  },
  "validation": { "valid": true, "errors": [], "warnings": [] }
}
```

YAML 解析失败时仍返回 `200` 快照，但带 `configDisabled: true`、`parseError` 和 `validation.valid: false`；读取异常返回 `500`。

## 4. `PUT /api/config`

请求体二选一：

### 4.1 原始 YAML 保存

```json
{
  "raw": "tools:\n  webSearch:\n    enabled: true\n    provider: brave\n    apiKey: ********\n",
  "baseRevision": "...",
  "providerRenames": {}
}
```

### 4.2 结构化配置保存

```json
{
  "config": {
    "tools": {
      "webSearch": {
        "enabled": true,
        "provider": "tavily",
        "apiKey": "new-key",
        "endpoint": "https://api.tavily.com/search"
      }
    }
  },
  "baseRevision": "...",
  "providerRenames": {}
}
```

成功响应为保存后的完整配置快照，结构与 `GET /api/config` 相同，并可能包含 `reload`。`baseRevision` 不为空且与当前配置不一致时返回 `409 CONFIG_CONFLICT`。YAML 解析、缺少 `raw/config`、未能恢复遮罩密钥或配置校验失败时返回 `400`；写入或 reload 的未分类异常返回 `500`。

## 5. `POST /api/config/validate`

请求体传 `raw` 或 `config` 其中之一：

```json
{ "raw": "tools:\n  webSearch:\n    provider: serper\n" }
```

响应结构固定为：

```json
{
  "valid": true,
  "errors": [],
  "warnings": []
}
```

配置有效返回 `200`，无效返回 `400`；解析异常也返回 `400`，并将错误放入 `errors`。

## 6. `POST /api/config/test-web-search`

该接口只做上游探测，不写入配置、不生成持久化 test ID。服务端固定使用探测词 `hello`，请求超时为 15 秒，网络层最多重试 2 次。重复请求相互独立。

请求字段：

```json
{
  "provider": "serper",
  "apiKey": "serper-key",
  "endpoint": "https://google.serper.dev/search",
  "customProvider": {
    "auth": "bearer",
    "method": "POST",
    "queryParam": "query",
    "apiKeyParam": "api_key",
    "resultsPath": "results"
  }
}
```

`provider` 省略时按 `glm` 处理。`apiKey: "********"` 会尝试从当前用户已保存的相同 provider/endpoint/auth 配置恢复；若作用域变化，必须重新输入密钥。响应不会回显密钥。

成功或上游失败均返回 JSON：

```json
{ "ok": true, "latencyMs": 123, "organicCount": 3 }
```

上游 4xx/5xx、超时或返回业务错误时返回 `200` 且 `ok: false`，包含 `error`，可能包含 `latencyMs`。请求参数错误返回 `400`：

| 条件 | HTTP | 响应 |
|---|---:|---|
| 不支持的 provider | 400 | `{ "ok": false, "error": "Unsupported web search provider." }` |
| 内置 provider 缺少 API key | 400 | `{ "ok": false, "error": "API key is required." }` |
| `custom` 缺少 endpoint | 400 | `{ "ok": false, "error": "Custom provider endpoint is required." }` |
| endpoint 不是合法 HTTP(S) URL | 400 | `{ "ok": false, "error": "Invalid endpoint URL: ..." }` |
| 遮罩密钥无法安全复用 | 400 | 返回要求重新输入密钥的错误信息 |

## 7. Provider 请求契约

| Provider | 默认 endpoint | 请求 | 凭证 | 结果数组 |
|---|---|---|---|---|
| `glm` | `https://api.z.ai/api/paas/v4/web_search` | POST JSON：`search_engine`、`search_query`、`count`、`search_recency_filter` | `Authorization: Bearer <key>` | `search_result` |
| `tavily` | `https://api.tavily.com/search` | POST JSON：`api_key`、`query`、`max_results`、`include_answer`、`search_depth` | 请求体 `api_key` | `results` |
| `serper` | `https://google.serper.dev/search` | POST JSON：`q`、`num` | `X-API-KEY` | `organic` |
| `brave` | `https://api.search.brave.com/res/v1/web/search` | GET 查询：`q`、`count` | `X-Subscription-Token` | `web.results` |
| `custom` | 必填，用户提供 | 按 `customProvider.method` | 按 `customProvider.auth` | `resultsPath` 或通用结果字段 |

工具运行时 `web_search` 使用同一 provider 契约，并将结果归一化为 `{ query, organic[] }`。Serper 的 `gl` 写入请求体；Brave 的 `gl` 写入 `country` 查询参数。

## 8. 源码与测试映射

- 鉴权挂载：`ui/server/index.js:579-584`
- 配置读取、校验、保存：`ui/server/routes/config.js:239-280`、`365-383`、`413-542`
- 搜索测试路由：`ui/server/routes/config.js:752-948`
- 类型与 parser：`src/pilot/config/types.ts:133-158`、`src/pilot/config/parseToolsConfig.ts:63-185`
- 工具适配：`src/tool/builtin/webSearch.ts:16-397`
- 设置页调用：`ui/src/components/settings/view/agentSearch/components/ToolsSection.tsx:139-175`、`:216-232`
- 确定性测试：`ui/server/routes/config.test.js:468-640`、`tests/tool/builtin/webSearch.spec.ts`、`tests/pilot/config/parseToolsConfig.spec.ts`、`ui/src/components/settings/view/agentSearch/utils/webSearchConfig.spec.ts`

## 9. 验收与未覆盖项

确定性测试应覆盖五个 provider 的配置解析、默认 endpoint、请求方法、鉴权头/请求体、结果归一化、错误、超时和设置页切换；真实搜索服务调用标记为 `DEFER_EXTERNAL`。

本接口不提供 provider/model 删除引用查询，也不把搜索测试结果绑定到配置保存；模型池相关缺口见 52 号 TRD。密钥遮罩和运行时恢复规则由通用配置实现及 48 号 TRD 负责。

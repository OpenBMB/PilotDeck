# 对话框改进后端接口文档

## 1. 文档说明

本文档定义对话框改进相关的后端 HTTP、SSE 和 Gateway WebSocket 接口契约。

- HTTP 基础路径：`/api`
- HTTP 数据格式：`application/json`，上传接口除外
- 时间格式：ISO 8601 UTC
- 字节单位：byte
- 分页游标：服务端生成的不透明字符串

统一错误响应：

```ts
type ApiErrorResponse = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
};
```

## 2. 公共类型

### 2.1 匹配区间

```ts
type MatchRange = {
  field: string;
  start: number;
  end: number;
};
```

`start` 包含，`end` 不包含；索引基于 UTF-16 code unit。多个区间按 `start` 升序返回，且不重叠。

### 2.2 分页

```ts
type PageResult<T> = {
  items: T[];
  nextCursor?: string;
};
```

游标与查询参数绑定。修改 `query`、`scope` 或其他过滤条件后，不得继续使用旧游标；非法或过期游标返回 `INVALID_CURSOR`。

## 3. 项目文件检索

### 3.1 查询文件和目录

`GET /api/projects/files`

Query 参数：

| 参数 | 类型 | 必填 | 默认值 | 约束 |
| --- | --- | --- | --- | --- |
| `projectKey` | string | 是 | - | 项目注册表中的标识 |
| `query` | string | 否 | 空 | 最大 256 字符 |
| `cursor` | string | 否 | - | 服务端返回的不透明游标 |
| `limit` | integer | 否 | 100 | `1..500` |
| `includeDirs` | boolean | 否 | true | `true` 或 `false` |

响应 `200`：

```ts
type ProjectFileEntry = {
  id: string;
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
  matches?: Array<MatchRange & {
    field: "name" | "relativePath";
  }>;
};

type ProjectFilesResponse = PageResult<ProjectFileEntry> & {
  projectKey: string;
};
```

语义：

- `id` 在同一项目和同一文件实体生命周期内稳定。
- `relativePath` 使用 `/` 作为分隔符，不以 `/` 开头。
- 不传 `query` 时按 `relativePath` 字典序返回全部可见文件和目录。
- 传入 `query` 时按名称和相对路径进行大小写不敏感匹配，并返回 `matches`。
- 服务端必须校验真实路径位于项目根目录内，禁止路径穿越和符号链接越界。

错误：

| 错误码 | HTTP | 说明 |
| --- | ---: | --- |
| `PROJECT_NOT_FOUND` | 404 | 项目不存在 |
| `PROJECT_PATH_FORBIDDEN` | 403 | 项目或路径越权 |
| `INVALID_CURSOR` | 400 | 游标非法或与查询不匹配 |
| `FILE_INDEX_LIMIT` | 422 | 文件扫描达到资源上限 |

## 4. 技能和命令检索

### 4.1 查询 slash command

`POST /api/commands/list`

请求：

```ts
type CommandsListRequest = {
  projectKey: string;
  query?: string;
  cursor?: string;
  limit?: number;
};
```

`limit` 默认 50，最大 200。

响应 `200`：

```ts
type SlashCommandItem = {
  name: string;
  description?: string;
  namespace: "pinned" | "builtin" | "project" | "user" | string;
  type: "built-in" | "custom" | "skill" | string;
  argumentHint?: string;
  matches?: Array<MatchRange & {
    field: "name" | "description" | "alias";
  }>;
};

type CommandsListResponse = {
  pinned: SlashCommandItem[];
  builtIn: SlashCommandItem[];
  custom: SlashCommandItem[];
  nextCursor?: string;
};
```

命令来源包括内置命令、项目和用户 `.pilotdeck/commands`、项目和用户 skills。服务端完成同名去重，优先级为：内置命令 > 项目命令/技能 > 用户命令/技能。`pinned` 保持服务端定义的固定顺序，其他结果按名称稳定排序。该接口是 `/` 候选列表的唯一数据源；`/api/skills/list` 用于独立技能清单，不应与本接口结果再次合并。

### 4.2 查询技能

`POST /api/skills/list`

请求：

```ts
type SkillsListRequest = {
  projectKey?: string;
  query?: string;
  scope?: "builtin" | "user" | "project" | "plugin" | "all";
  cursor?: string;
  limit?: number;
};
```

`scope` 默认 `all`，`limit` 默认 10，最大 50。

响应 `200`：

```ts
type SkillListItem = {
  name: string;
  displayName?: string;
  description?: string;
  scope: "builtin" | "user" | "project" | "plugin" | string;
  command: string;
  readonly?: boolean;
  matches?: Array<MatchRange & {
    field: "name" | "displayName" | "description" | "alias";
  }>;
};

type SkillsListResponse = PageResult<SkillListItem>;
```

响应不包含 `SKILL.md` 正文。`command` 是可提交的规范化命令，必须以 `/` 开头。

## 5. 文件和文件夹上传

### 5.1 上传状态

```ts
type UploadStatus =
  | "created"
  | "uploading"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";
```

合法转换：

```text
created -> uploading -> completed
                   -> failed
created/uploading -> cancelled
completed -> expired
```

### 5.2 创建上传任务

`POST /api/uploads`

Content-Type：`application/json`

请求：

```ts
type UploadManifestEntry = {
  clientFileId: string;
  name: string;
  relativePath: string;
  size: number;
  mimeType?: string;
  sha256?: string;
};

type CreateUploadRequest = {
  projectKey: string;
  files: UploadManifestEntry[];
};
```

约束：

- `clientFileId` 在本次上传内唯一，由调用方生成。
- `relativePath` 使用 `/` 分隔，不以 `/` 开头，不允许 `.`、`..` 或空路径段。
- 单文件上传的 `relativePath` 等于文件名；文件夹上传保留选择目录下的相对层级。
- `size` 必须为非负整数；所有 size 之和作为 `totalBytes`。
- `sha256` 可选；提供后服务端必须在上传完成时校验。

响应 `201`：

```ts
type UploadedAttachment = {
  attachmentId: string;
  name: string;
  relativePath?: string;
  mimeType?: string;
  bytes: number;
  sha256: string;
};

type UploadResponse = {
  uploadId: string;
  status: UploadStatus;
  totalBytes: number;
  uploadedBytes: number;
  expiresAt: string;
  attachments?: UploadedAttachment[];
  errorCode?: string;
  errorMessage?: string;
};
```

创建成功时状态为 `created`，响应同时返回：

```ts
type CreateUploadResponse = UploadResponse & {
  contentUrl: string;
  eventsUrl: string;
};
```

`contentUrl` 和 `eventsUrl` 只对当前 `uploadId` 有效。创建请求支持 `Idempotency-Key` 请求头；同一项目、相同 key 在任务过期前返回同一任务。

### 5.3 上传内容

`POST /api/uploads/:uploadId/content`

Content-Type：`multipart/form-data`

每个文件 part 的字段名为 `files[<clientFileId>]`，必须与创建任务时的 manifest 一一对应。不得缺少、重复或提交未声明的 `clientFileId`。文件流直接写入临时存储，不支持 base64 请求体。

服务端收到第一个文件字节时将状态从 `created` 转为 `uploading`，持续更新 `uploadedBytes`；全部文件通过大小及可选 hash 校验后转为 `completed`。

响应：

- 上传完成：`200` + `UploadResponse`
- 客户端中断：任务保持 `failed`，错误码 `UPLOAD_STREAM_INTERRUPTED`
- manifest 不匹配：`400` + `UPLOAD_MANIFEST_MISMATCH`

### 5.4 查询上传

`GET /api/uploads/:uploadId`

响应 `200`：`UploadResponse`。

`uploadedBytes` 单调递增；状态为 `completed` 时必须等于 `totalBytes`，并返回 `attachments`。

### 5.5 取消上传

`DELETE /api/uploads/:uploadId`

仅 `created` 或 `uploading` 状态可取消。成功返回 `204`；已完成返回 `UPLOAD_ALREADY_COMPLETED`。

### 5.6 上传事件

`GET /api/uploads/:uploadId/events`

Content-Type：`text/event-stream`

事件类型：

- `upload_started`
- `upload_progress`
- `upload_completed`
- `upload_failed`

事件数据：

```ts
type UploadEvent = {
  uploadId: string;
  status: UploadStatus;
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
  attachments?: UploadedAttachment[];
  errorCode?: string;
  errorMessage?: string;
};
```

`percent` 范围为 `0..100`。终态事件发送后服务端关闭 SSE 连接。

SSE 可在上传内容请求发起前建立。连接建立后服务端先发送当前状态快照，再发送后续变化。

### 5.7 上传错误

| 错误码 | HTTP | 说明 |
| --- | ---: | --- |
| `UPLOAD_NOT_FOUND` | 404 | uploadId 不存在 |
| `UPLOAD_NOT_COMPLETED` | 409 | 上传尚未完成 |
| `UPLOAD_ALREADY_COMPLETED` | 409 | 已完成上传不能取消 |
| `UPLOAD_LIMIT_EXCEEDED` | 413 | 文件、数量或总大小超限 |
| `UPLOAD_MANIFEST_MISMATCH` | 400 | multipart 内容与 manifest 不一致 |
| `UPLOAD_STREAM_INTERRUPTED` | 400 | 上传流意外中断 |
| `ATTACHMENT_EXPIRED` | 410 | 上传或附件已过期 |
| `PROJECT_PATH_FORBIDDEN` | 403 | 上传项目归属不匹配 |

## 6. 模型目录

### 6.1 查询模型

`GET /api/models`

Query 参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `projectKey` | string | 是 | 项目注册表中的标识 |
| `query` | string | 否 | 按 provider、model、displayName 检索 |
| `provider` | string | 否 | 过滤 provider |
| `includeAuto` | boolean | 否 | 是否在 Router 可用时返回 auto |

响应 `200`：

```ts
type ModelCapability = {
  type: "range" | "enum";
  min?: number;
  max?: number;
  step?: number;
  values?: number[];
  default?: number;
};

type ModelCatalogItem = {
  id: string;
  provider: string;
  model: string;
  displayName: string;
  available: boolean;
  capabilities: {
    reasoning?: ModelCapability;
    temperature?: ModelCapability;
    speed?: ModelCapability;
  };
};

type ModelsResponse = {
  items: ModelCatalogItem[];
  router: {
    enabled: boolean;
    autoAvailable: boolean;
  };
};
```

字段语义：

- `reasoning`：推理强度，归一化范围 `0..1`。
- `temperature`：采样温度，范围 `0..1`。
- `speed`：Provider 请求速度参数，范围 `0..1`；仅在模型显式声明支持且目标 Provider 有对应适配时返回。Google Provider 当前不支持该字段。
- 未显式声明 `supportsThinking` 的模型按协议默认支持 reasoning；显式 `supportsThinking: false` 时不返回 reasoning。
- 自定义 OpenAI-compatible provider 只有在 provider 配置显式设置 `speedMapping: openai_service_tier` 后才会返回 speed；自定义 Anthropic-compatible provider 对应设置 `speedMapping: anthropic_speed`。
- `speed < 0.5` 使用 OpenAI 和 Anthropic 默认速度（省略 `service_tier` / `speed`）；`speed >= 0.5` 映射为 OpenAI `service_tier: "priority"` / Anthropic `speed: "fast"`。Anthropic fast mode 同时自动添加 beta header `fast-mode-2026-02-01`。
- `range` 使用 `min`、`max`、`step`；`enum` 使用 `values`。
- 未返回的能力表示该模型不支持对应参数。
- Router 开启且支持 auto 时，接口可返回 `{ provider: "router", model: "auto" }` 虚拟条目。

### 6.2 查询会话模型设置

`GET /api/sessions/model?sessionKey=<sessionKey>&projectKey=<projectKey>`

响应 `200`：

```ts
type SessionModelSelection =
  | { mode: "auto" }
  | {
      mode: "model";
      provider: string;
      model: string;
      reasoning?: number;
      temperature?: number;
      speed?: number;
    };

type SessionModelResponse = {
  sessionKey: string;
  projectKey: string;
  saved?: SessionModelSelection;
  effective: {
    provider: string;
    model: string;
    source: "session" | "router" | "default";
    reasoning?: number;
    temperature?: number;
    speed?: number;
  };
};
```

`saved` 不存在表示会话没有显式设置：Router 开启时使用 auto，Router 关闭时使用系统默认模型。

### 6.3 设置会话模型

`PUT /api/sessions/model`

请求：

```ts
type SetSessionModelRequest = {
  sessionKey: string;
  projectKey: string;
  selection: SessionModelSelection;
};
```

`mode=model` 时校验模型存在、可用，并校验 reasoning、temperature、speed。`mode=auto` 仅在 Router 开启时允许，否则返回 `ROUTER_AUTO_UNAVAILABLE`。

设置写入会话 metadata，对后续 turn 持续生效；会话恢复后继续生效。成功返回 `SessionModelResponse`。

### 6.4 清除会话模型设置

`DELETE /api/sessions/model?sessionKey=<sessionKey>&projectKey=<projectKey>`

成功返回 `204`。清除后 Router 开启时回到 auto，Router 关闭时回到系统默认模型。

## 7. 权限模式

### 7.1 字段映射

| 产品语义 | API 值 | 说明 |
| --- | --- | --- |
| 默认权限 | `default` | 工具按现有权限策略请求确认 |
| 完全访问权限 | `bypassPermissions` | 跳过工具权限确认 |
| 计划模式 | `plan` | 仅表示运行模式，不自动提升权限 |

`basePermissionMode` 表示会话当前选择的权限，允许值为 `default` 或 `bypassPermissions`。`mode` 表示本轮运行模式，允许值为 `default`、`plan`、`bypassPermissions`。

### 7.2 生效规则

1. `mode=plan` 时，`effectivePermissionMode` 使用 `basePermissionMode`，不得自动提升为 `bypassPermissions`。
2. 非 plan 模式下，显式 `mode` 优先；未传时使用 `basePermissionMode`；两者都未传时使用系统权限设置。
3. 完全访问权限必须通过现有调用方能力和服务端策略校验。
4. 最终生效值记录到 turn metadata；临时的 turn 覆盖不写回下一轮。
5. 非法组合返回 `INVALID_PERMISSION_MODE`，且不得启动模型调用。

权限确认继续通过 `permission_request` 事件和 `permission_decide` RPC 完成。
文本 IM 渠道对同一会话内的多个权限请求按 FIFO 顺序逐条发送和确认；每次 `1/2/0` 只决策当前请求，完成后再发送下一条提示。

## 8. 提交对话

Gateway WebSocket 方法：`submit_turn`

请求：

```ts
type SessionModelOverride = {
  provider: string;
  model: string;
  reasoning?: number;
  temperature?: number;
  speed?: number;
};

type UploadedAttachmentRef = {
  uploadId: string;
  attachmentIds?: string[];
};

type SubmitTurnRequest = {
  sessionKey: string;
  channelKey: string;
  message: string;
  projectKey?: string;
  attachments?: WebChannelAttachment[];
  uploadedAttachments?: UploadedAttachmentRef[];
  mode?: "default" | "plan" | "bypassPermissions";
  basePermissionMode?: "default" | "plan" | "bypassPermissions";
  modelOverride?: SessionModelOverride;
  runId?: string;
};
```

`modelOverride` 仅覆盖当前 turn，不修改第 6.3 节保存的会话模型设置。未传 `modelOverride` 时使用保存的会话设置；会话未设置时，Router 开启则使用 auto，否则使用系统默认模型。

服务端校验：

- `modelOverride.provider/model` 必须存在且可用。
- reasoning、temperature、speed 必须满足模型 capabilities；speed 使用 `0..1` 的统一数值语义。
- `uploadedAttachments` 必须属于同一 `projectKey`、状态为 completed 且未过期。
- `mode` 和 `basePermissionMode` 必须属于声明枚举。
- 校验失败时不得启动模型调用。

模型选择优先级：本轮 `modelOverride` > 已保存的会话模型 > Router auto > 系统默认模型。

响应为 Gateway 事件流，新增事件：

```ts
type ModelSelectionChangedEvent = {
  type: "model_selection_changed";
  provider: string;
  model: string;
  source: "session" | "router" | "default";
  parameters?: {
    reasoning?: number;
    temperature?: number;
    speed?: number;
  };
  runId?: string;
};
```

其余事件沿用现有 `turn_started`、`permission_request`、`assistant_text_delta`、`assistant_thinking_delta`、`tool_call_started`、`tool_call_finished`、`turn_completed` 和 `error`。

当 `submit_turn` 流自然结束但未收到 `turn_completed` 时，WebSocket 会以 `final: true` 发送 `error` 事件，不会伪造成功的 `turn_completed`：

```ts
type IncompleteGatewayStreamError = {
  type: "error";
  code: "gateway_stream_ended_without_completion";
  message: string;
  recoverable: true;
};
```

## 9. 错误码

| 错误码 | HTTP/事件 | 说明 |
| --- | ---: | --- |
| `INVALID_CURSOR` | 400 | 分页游标非法 |
| `PROJECT_NOT_FOUND` | 404 | 项目不存在 |
| `PROJECT_PATH_FORBIDDEN` | 403 | 项目路径越权 |
| `FILE_INDEX_LIMIT` | 422 | 文件扫描达到资源上限 |
| `UPLOAD_NOT_FOUND` | 404 | uploadId 不存在 |
| `UPLOAD_NOT_COMPLETED` | 409 | 上传尚未完成 |
| `UPLOAD_LIMIT_EXCEEDED` | 413 | 上传超限 |
| `UPLOAD_MANIFEST_MISMATCH` | 400 | multipart 与 manifest 不一致 |
| `UPLOAD_STREAM_INTERRUPTED` | 400 | 上传流意外中断 |
| `ATTACHMENT_EXPIRED` | 410 | 附件已过期 |
| `gateway_stream_ended_without_completion` | 事件 | Gateway 流结束时未收到 `turn_completed` |
| `INVALID_PERMISSION_MODE` | 400 | 权限模式非法 |
| `INVALID_MODEL_OVERRIDE` | 400 | 模型不存在或不可用 |
| `UNSUPPORTED_MODEL_PARAMETER` | 422 | 模型参数不受支持或超出范围 |
| `ROUTER_AUTO_UNAVAILABLE` | 409 | Router 未开启，不能保存 auto |
| `CAPABILITY_UNAVAILABLE` | 501 | 当前 Gateway 不支持接口 |

## 10. 兼容性

- 所有新增 `submit_turn` 字段均为可选，缺省行为保持不变。
- Gateway 握手能力列表用于声明 `project_files_list`、`commands_list`、`model_catalog_list`、`session_model_get`、`session_model_set` 和 `session_model_clear`。
- 缺少新增 Gateway RPC 时，REST 层返回 `CAPABILITY_UNAVAILABLE`，不隐式改写请求。
- 老版本请求未传模型覆盖时，优先使用已保存的会话设置；没有会话设置时继续由 Router 或系统默认模型决定。

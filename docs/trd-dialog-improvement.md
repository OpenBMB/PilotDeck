# 对话框改进后端 TRD

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档状态 | Draft |
| 关联 PRD | `/Users/a1/Desktop/对话框改进.md` |
| 适用版本 | PilotDeck Web API / Gateway |
| 目标读者 | 后端、Gateway、接口联调和测试 |

## 2. 背景与目标

本次改进需要让用户在对话框中完成项目内容引用、技能选择、附件上传、权限选择和模型切换。后端需要提供稳定的资源查询与上传接口，并把会话级选项安全地传递到现有 Gateway、Session、Router 和 Model Provider 链路。

目标：

1. 项目文件列表支持完整浏览、滚动分页和关键词检索。
2. 技能列表支持搜索、稳定排序和结果高亮所需的匹配区间。
3. 文件和文件夹上传支持流式传输、状态查询和大文件进度。
4. 当前会话可覆盖模型及高级参数，但不改变全局配置。
5. 模型选择遵循“会话显式模型 > Router auto > 系统默认模型”。
6. 保持未升级客户端和现有 Gateway 调用的兼容性。

非目标：修改全局 Router 配置格式、重做权限策略、实现断点续传、改变 Provider 私有协议的公开接口。

## 3. 现有系统承接点

- `GatewaySubmitTurnInput` 已承载 `sessionKey`、`projectKey`、`attachments`、`mode` 和 `basePermissionMode`，新增字段应保持可选。
- `InProcessGateway` 是会话执行和附件解析的权威入口；`RemoteGateway`、`GatewayWsClient` 和浏览器协议需要同步新增 RPC/字段。
- Skill 管理由 Gateway 的 `skillsList` 负责，Web `/api/skills/*` 是转发层。
- 模型目录位于 Model Catalog 和配置中的 provider models；Router 运行时负责自动路由和 fallback。
- Gateway WebSocket 承载 `submit_turn`，REST 路由用于资源查询和上传管理。

## 4. 总体架构

```text
Web Composer
  |-- REST --> Web API Server（文件索引、上传注册、Gateway shim）
  `-- WebSocket submit_turn --> Gateway（权限、模型、Router、Provider）
```

资源接口按项目根目录授权。文件内容不在文件检索接口中返回；选择文件后只传递受校验的相对路径或已完成的 `uploadId`。模型和技能查询结果不写入 transcript，最终提交的模型覆盖和附件引用随 turn metadata 记录。

## 5. 项目文件检索

### 5.1 REST API

`GET /api/projects/files?projectKey=<projectKey>`

Query 参数：`query`（可选）、`cursor`（不透明游标）、`limit`（默认 100，范围 1..500）、`includeDirs`（默认 true）。

返回：

```json
{
  "items": [{
    "id": "sha256:...",
    "name": "src",
    "relativePath": "src",
    "kind": "directory",
    "size": 0,
    "mtimeMs": 1786430292000,
    "matches": [{"field": "relativePath", "start": 0, "end": 3}]
  }],
  "nextCursor": "...",
  "projectKey": "/workspace/project"
}
```

`matches` 仅在 `query` 非空时返回，供接口调用方定位匹配文本。排序固定为 `relativePath` 的 Unicode 字典序，游标绑定项目、查询词和排序版本。

### 5.2 Gateway RPC

新增可选方法 `projectFilesList(input)`：

```ts
type ProjectFilesListInput = {
  projectKey: string;
  query?: string;
  cursor?: string;
  limit?: number;
  includeDirs?: boolean;
};
type ProjectFilesListResult = {
  items: ProjectFileEntry[];
  nextCursor?: string;
  projectKey: string;
};
```

REST 层优先调用 Gateway；不支持该方法的旧 Gateway 返回 `CAPABILITY_UNAVAILABLE`，不得隐式改写查询。

### 5.3 安全与性能

- 使用项目注册表解析 `projectKey`，禁止客户端任意指定根目录。
- `realpath` 后检查路径位于项目根目录内；拒绝符号链接越界、`..` 和绝对路径引用。
- 默认忽略 `.git`、`.pilotdeck`、依赖目录和临时目录，复用现有 workspace 扫描规则。
- 单次扫描设置文件数、深度和耗时上限；超限返回 `FILE_INDEX_LIMIT`。
- 大目录使用异步迭代器，不一次性加载全量目录树。

## 6. 技能与 slash command 检索

对话框输入 `/` 时，后端返回技能和命令的统一候选列表。现有 `POST /api/commands/list` 作为命令发现接口继续复用，并与 Gateway 的技能目录保持同源语义。

`POST /api/commands/list` 请求：

```ts
type CommandsListInput = {
  projectKey: string;
  query?: string;
  cursor?: string;
  limit?: number;
};
```

响应至少包含 `pinned`、`builtIn`、`custom` 三组；每个条目包含 `name`、`description`、`namespace`、`type`，并在传入 `query` 时返回 `matches` 高亮区间。命令来源包括内置命令、项目/用户 `.pilotdeck/commands` 和技能目录中的 `SKILL.md`。

去重和优先级固定为：内置命令 > 项目命令/技能 > 用户命令/技能；同名条目只保留优先级最高的一项。`pinned` 保持服务端定义的固定顺序，其他结果按稳定名称排序。搜索应在合并去重后执行，避免同名候选产生不同高亮结果。

该接口的 Gateway RPC 版本命名为 `commandsList`；旧 Gateway 不支持时由现有 REST 实现提供命令查询，不影响 `submit_turn`。

`POST /api/skills/list` 和 Gateway `skillsList` 增加可选字段：

```ts
type SkillsListInput = {
  projectKey?: string;
  query?: string;
  scope?: "builtin" | "user" | "project" | "plugin" | "all";
  cursor?: string;
  limit?: number;
};
```

`limit` 默认 10，最大 50。服务端按技能名称、显示名称、描述和别名匹配，结果按作用域优先级（project > user > builtin；plugin 沿用运行时顺序）及名称稳定排序。每项返回匹配区间：

```ts
type SkillSearchMatch = {
  field: "name" | "description" | "alias";
  start: number;
  end: number;
};
```

技能内容不随列表返回。接口返回规范化 slash command；`submit_turn` 接收该命令后负责名称校验和现有 skill prompt 加载。

## 7. 附件上传

### 7.1 上传状态机

```text
created -> uploading -> completed
                   -> failed
created/uploading -> cancelled
completed -> expired
```

文件夹上传通过 manifest 保留相对层级；服务端不接受目标绝对路径。manifest 中每个条目包含唯一 `clientFileId`、文件名、相对路径、大小、MIME 和可选 sha256，multipart 字段通过 `clientFileId` 与条目一一对应。

### 7.2 REST API

上传拆分为三个阶段，确保上传开始前可以获得 `uploadId` 并订阅进度：

1. `POST /api/uploads` 使用 JSON 创建上传任务，提交 `projectKey` 和文件 manifest。
2. `GET /api/uploads/:uploadId/events` 建立 SSE 并立即返回当前状态快照。
3. `POST /api/uploads/:uploadId/content` 使用 `multipart/form-data` 流式上传内容。

创建任务返回 `201`：

```json
{
  "uploadId": "upl_01...",
  "status": "created",
  "totalBytes": 104857600,
  "uploadedBytes": 0,
  "expiresAt": "2026-08-11T12:00:00Z"
}
```

`GET /api/uploads/:uploadId` 返回状态、字节计数、附件元数据和错误信息。`DELETE /api/uploads/:uploadId` 取消上传。SSE 推送 `upload_started`、`upload_progress`、`upload_completed`、`upload_failed`，终态后关闭连接。

大文件必须流式写入临时目录，禁止 base64 中转。服务端校验 multipart 与 manifest 完全一致，上传完成后生成受项目目录约束的临时文件记录。创建接口支持 `Idempotency-Key`，内容上传流中断后任务进入 failed，本期不支持断点续传。

### 7.3 提交关联

`GatewaySubmitTurnInput` 增加可选 `uploadedAttachments`：

```ts
type UploadedAttachmentRef = {
  uploadId: string;
  attachmentIds?: string[];
};
```

提交时验证上传完成、项目归属、未过期、文件存在且大小/hash 未变化，成功后转换为现有 `ChannelAttachment[]`。失败返回 `UPLOAD_NOT_COMPLETED`、`ATTACHMENT_EXPIRED` 或 `PROJECT_PATH_FORBIDDEN`，且不启动模型调用。

配置项：`uploads.maxFileBytes`、`uploads.maxTotalBytes`、`uploads.maxFiles`、`uploads.maxConcurrentPerProject`、`uploads.retentionMs`、`uploads.tempDir`。

## 8. 权限模式

继续使用 `default`、`plan`、`bypassPermissions`。产品的“默认权限”映射为 `default`，“完全访问权限”映射为 `bypassPermissions`。`basePermissionMode` 表示用户选择，`mode` 表示本轮执行模式。服务端计算 `effectivePermissionMode`：

1. 输入非法返回 `INVALID_PERMISSION_MODE`。
2. `plan` 只能启用计划工具，不得把用户权限提升为 bypass。
3. bypass 仅在调用方具备能力且用户明确选择时允许。
4. 生效模式写入 turn metadata；会话恢复不继承下一轮临时覆盖。

权限请求继续使用现有 `permission_request` / `permission_decide` 事件和 RPC。
文本 IM 权限请求按 chat 维度 FIFO 串行处理；下一条提示发送成功前保持锁定，发送失败时保留待发送提示，不允许后续入站消息越过当前请求。
`permission_decide` 返回 `delivered: false` 表示 request 已失效；渠道应丢弃该 request 并推进队列，不能重复提交同一个 requestId。确认消息和下一条权限提示均须在渠道确认发送完成后再释放锁；turn stream 的结束清理不得抢先清除正在投递的回答状态。

## 9. 模型目录与会话覆盖

### 9.1 模型目录

`GET /api/models?query=&provider=&includeAuto=`

模型目录直接读取全局配置，不枚举项目或会话；旧客户端传入的 `projectKey` 仅为兼容保留。返回 `defaultSelection` 明确指定系统默认模型，目录顺序不影响选择。

返回 provider、model、displayName、available 以及 reasoning（推理强度）、temperature 和可选 speed 的能力声明。对话框统一使用 0..1 的数值语义；每个模型可通过能力声明限制可用范围、步长或枚举值，后端负责把 0..1 值映射为 Provider 所需参数。temperature 和 speed 统一范围为 0..1。官方 OpenAI / Anthropic 模型默认声明 speed；自定义模型需显式 `supportsSpeed: true`，且 Google Provider 当前不支持该字段。目录将 speed 暴露为枚举 `0`（标准）与 `1`（快速）。

协议默认将未显式声明的模型视为支持 reasoning；模型可通过 `capabilities.supportsThinking: false` 关闭。speed 对官方 OpenAI / Anthropic 默认开启，其他模型通过 `capabilities.supportsSpeed: true` 显式开启。

自定义兼容 provider 还必须显式声明 `speedMapping`：OpenAI 使用 `openai_service_tier`，Anthropic 使用 `anthropic_speed`。统一 speed 在 adapter 层转换为 provider 原生字段；OpenAI 和 Anthropic 低档都省略对应字段、高档分别使用 `priority` 和 `fast`。Anthropic fast mode 自动合并 beta header `fast-mode-2026-02-01`。Google 不声明 speed。

`includeAuto` 仅在 Router 开启时允许，返回虚拟模型 `router/auto`。

### 9.2 `submit_turn` 扩展

```ts
type SessionModelOverride = {
  mode: "model";
  provider: string;
  model: string;
  reasoning?: number;
  temperature?: number;
  speed?: number;
};
type GatewaySubmitTurnInput = ExistingGatewaySubmitTurnInput & {
  modelOverride?: SessionModelOverride;
  modelSelection?: { mode: "auto" } | SessionModelOverride;
  uploadedAttachments?: UploadedAttachmentRef[];
};
```

### 9.3 Web 全局偏好与兼容会话模型状态

Web Composer 只保存同一浏览器、同一站点内最近一次手动选择的模型及参数，不区分项目或会话，并同步其他标签页。未手动选择时使用系统默认模型；手动选择后，配置默认值变化、会话切换、提交确认和运行结果都不改写偏好。已选模型不可用时提示重新选择，不自动切换。

Composer 不再调用下列会话模型读写接口。它在准备附件之前固定每条提交的 `modelSelection`，队列、编辑重发和历史执行记录继续保留各自的快照。会话 API 保留给已有客户端，其保存值不参与 Web 全局选择恢复。

新增会话模型读写接口：

- `GET /api/sessions/model?sessionKey=...&projectKey=...`：返回保存值和最终生效模型。
- `PUT /api/sessions/model`：使用 `sessionKey + projectKey` 保存显式模型及高级参数，或保存 `mode=auto`。
- `DELETE /api/sessions/model?sessionKey=...&projectKey=...`：清除会话设置。

保存值写入 session metadata，会话恢复后继续生效。`mode=auto` 仅在 Router 开启时允许；清除设置后，Router 开启则回到 auto，Router 关闭则回到 `agent.model`。

`submit_turn.modelSelection` 为 Web 提交时固定的模型快照，随已接收输入记录；`modelOverride` 只覆盖本轮，不修改会话保存值。两者互斥，均优先于兼容会话设置。只有两者都未传时才使用会话保存模型 > Router auto/路由决策 > `agent.model` 默认模型；Web Composer 不依赖这条回退路径。

`provider/model` 不存在或不可用返回 `INVALID_MODEL_OVERRIDE`；reasoning、temperature 或 speed 不满足模型能力返回 `UNSUPPORTED_MODEL_PARAMETER`。未声明支持的参数不发送给 Provider。speed 必须在 canonical request 入口通过 `0..1` 校验，再由支持 speed 的 Provider adapter 映射为原生字段；Google Provider 不声明或接收 speed。

模型确定后发出 `model_selection_changed`，包含 provider、model、来源（session/router/default）和已生效参数。

## 10. 协议、错误与兼容性

新增 Gateway/Web 方法：`project_files_list`、`commands_list`、`model_catalog_list`、`session_model_get`、`session_model_set`、`session_model_clear`；同步浏览器协议镜像。上传任务由 Web API Server 管理，不经 Gateway RPC。所有新字段可选，老客户端保持现有行为。老 Gateway 缺少新增 RPC 时返回 `CAPABILITY_UNAVAILABLE`（501）。

统一错误码：

| 错误码 | HTTP | 说明 |
| --- | ---: | --- |
| `PROJECT_NOT_FOUND` | 404 | 项目不存在 |
| `PROJECT_PATH_FORBIDDEN` | 403 | 路径越权或跨项目引用 |
| `FILE_INDEX_LIMIT` | 422 | 文件扫描达到资源上限 |
| `UPLOAD_NOT_FOUND` | 404 | uploadId 不存在 |
| `UPLOAD_NOT_COMPLETED` | 409 | 上传尚未完成 |
| `UPLOAD_LIMIT_EXCEEDED` | 413 | 文件、数量或总大小超限 |
| `UPLOAD_MANIFEST_MISMATCH` | 400 | multipart 与 manifest 不一致 |
| `UPLOAD_STREAM_INTERRUPTED` | 400 | 上传流意外中断 |
| `ATTACHMENT_EXPIRED` | 410 | 附件已过期 |
| `INVALID_PERMISSION_MODE` | 400 | 权限模式非法 |
| `INVALID_MODEL_OVERRIDE` | 400 | 模型不存在或不可用 |
| `UNSUPPORTED_MODEL_PARAMETER` | 422 | 参数不在模型能力范围内 |
| `ROUTER_AUTO_UNAVAILABLE` | 409 | Router 未开启，不能保存 auto |
| `CAPABILITY_UNAVAILABLE` | 501 | 老 Gateway 不支持该 RPC |

## 11. 可观测性与数据保留

- 记录 uploadId、projectKey 哈希、字节数、耗时、结束状态和错误码。
- 记录模型选择来源、规范化参数和 provider/model，不记录 API key、文件内容或完整 prompt。
- Gateway 事件使用 runId/sessionKey 关联，上传事件使用 uploadId 关联。
- 临时文件按 `retentionMs` 清理；transcript 只保存附件元数据和模型覆盖，不保存临时绝对路径。

## 12. 测试与验收

### 单元测试

- 文件游标分页、稳定排序、搜索匹配区间、路径校验。
- 技能搜索字段、作用域优先级、limit/cursor 和空结果。
- 上传任务幂等创建、manifest 映射、状态机、字节计数单调性、限制校验和过期清理。
- 权限模式计算和 plan/bypass 约束。
- 模型能力校验、会话模型持久化、Router 优先级和 Provider 参数映射。

### 集成测试

- Gateway RPC 与 Web 协议类型同步。
- REST shim 的鉴权、项目归属校验和错误映射。
- 创建上传任务后先订阅 SSE 再上传内容，进度和终态与状态查询一致。
- 上传完成后关联 `submit_turn`；未完成、跨项目、过期附件不触发模型调用。
- Router 开关、会话模型设置/清除/恢复及本轮覆盖的完整调用链。

### 端到端验收

1. `@` 可滚动遍历超过固定数量的文件，并能搜索和高亮。
2. 技能查询默认返回不超过 10 条，搜索结果包含规范化 command 和匹配区间。
3. 上传文件夹和大文件时可观察进度，完成后能在对话中引用。
4. 切换模型并修改高级参数后，实际 provider 请求与选择结果一致。
5. Router 开关、权限模式、老客户端请求和异常场景均符合兼容性要求。

## 13. 假设与后续扩展

- 本期大文件上传采用流式 multipart，不实现断点续传；后续可在 uploadId 协议上增加分片。
- 高亮区间由后端计算并通过接口返回。
- 模型高级参数由能力声明驱动，不直接暴露 Provider 私有字段。
- 不改变现有权限策略和 Router 配置文件格式，只增加会话级覆盖和查询能力。

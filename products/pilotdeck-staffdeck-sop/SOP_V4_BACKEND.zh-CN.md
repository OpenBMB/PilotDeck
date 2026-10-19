# SOP v4 后端执行

本文件说明 SOP v4 后端协议、输入配置、执行工具和恢复语义，只接受 `sop.definition/v4` 和 `sop.lifecycle/v4`。PilotDeck + SOP v4 + 独立 KM 的源码/Compose 部署统一见 [部署文档](DEPLOYMENT.zh-CN.md)。

## 职责与绑定

Python Runtime 保存定义、流程实例、处理项、节点调用、尝试、租约和事件；PilotDeck 创建隔离 AgentSession，管理模型、工具、权限和共享工作空间。模型请求全部通过 PilotDeck。
在新 `pilotdeck.yaml` 中配置模型与下列正式模块绑定；不使用旧 `contextMode`、`definitionsPath` 或 `defaultSopId`。只运行一个 PilotDeck 执行宿主；Runtime 也只运行一个 worker。外部网络部署配置可达地址、TLS 与 host token。

```yaml
modules:
  sop:
    enabled: true
    implementationId: portable-sop
    hostAdapter: pilotdeck
    contract: sop.lifecycle/v4
    transport: sop-http-v4
    endpoint: http://127.0.0.1:18991
    credentialEnv: SOP_V4_HOST_TOKEN
    timeoutMs: 30000
    approval: { provider: disabled }
```

`approval.provider: disabled` 不加载用户库，普通 SOP 正常执行，包含审批节点的定义在创建运行前被拒绝。`pilotdeck` 启用现有 owner JWT 适配器。自定义宿主向 `createLocalGateway` 注入 `sopApprovalAuthority`，实现 `authenticate({ bearer, projectKey, signal }) -> { subjectId }`；主体为不透明标识，Runtime 只比较 `assigneeUserId`，不查询用户表。SDK 的 `approverAuthorization` 用法不变，客户端不得自行填写 `subjectUserId`。

需要宿主管理本机 Runtime 时增加 `localRuntime: { enabled: true, python: /absolute/prepared/venv/bin/python, dataDirectory: /absolute/new/sop-v4-data, maxConcurrency: 32, startupTimeoutMs: 10000 }`。该路径只启动已安装程序，不运行 pip。未配置 `localRuntime` 时连接外部服务，退出时不停止它。编程宿主必须等待返回的 `ready`，再开放业务入口；退出调用 `dispose()`。

使用 YAML 声明绑定，凭据通过 `credentialEnv` 指定的环境变量注入。`/api/modules/runtime` 展示 v4 协议和就绪状态；前端仅通过 Agent 工具调用 v4，不提供独立管理页面。

`GET /healthz` 返回 `contract: sop.lifecycle/v4`。PilotDeck 在创建运行前检查协议、全部固定版本引用、模型绑定和工具绑定；实际调用前再次校验。模型不存在或不允许使用时失败，不切换为其他模型。

## 定义与输入

所有 Runtime API（health 除外）需要 `Authorization: Bearer <host-token>`。发布固定版本使用 `POST /v4/definitions`；重复发布同内容幂等，同版本不同内容拒绝。

```json
{
  "schema": "sop.definition/v4",
  "skill_id": "extract-file",
  "version": "1",
  "start_node_id": "extract",
  "terminal_node_ids": ["extract"],
  "nodes": [{
    "node_id": "extract",
    "instruction": "解析单个文件，返回 output 对象并调用 structured_output。",
    "input": {"fields": {"document": {"source": "attachments"}}},
    "model": {"provider": "configured-provider", "model": "configured-model"}
  }],
  "edges": []
}
```

节点类型为 `task`（默认）、`subflow`、`foreach`、`approval`。`tools` 是该节点可用工具名列表，默认只有 `structured_output`。模型优先级：节点、运行默认、项目默认。子 SOP 自己的节点配置优先。状态和事件保存选择的 provider/model 与实际调用用量；provider 内部模型别名仍由 provider 管理。

未配置 `input.fields` 时只传 `originalQuery`、直接前驱 `handoffText`、当前项 `files`；循环子项还接收 `item`。每次用户提交在附件内联前捕获纯 query 和持久文件引用。共享工作目录不意味着自动读取文件。附件全文只在显式选择 `attachments` 时解析。

`input.fields` 每个字段使用 `{"source":"...","path":"a.b.0"}` 或 `{"value":...}`，可用来源：`originalQuery`、`latestUserMessage`、`handoffText`、`slots`、`item`、`files`、`attachments`、`history`、`output`（直接前驱的结构化输出）。例如：

```json
{
  "input": {
    "fields": {
      "query": {"source": "originalQuery"},
      "summary": {"source": "handoffText"},
      "company": {"source": "slots", "path": "company"},
      "file": {"source": "attachments", "path": "0"}
    },
    "template": "任务：{{query}}\n交接：{{summary}}\n企业：{{company}}\n资料：{{file}}",
    "history": false
  }
}
```

附件选择可以是引用数组或单个引用；路径必须在本次运行的项目内。`input.history: true` 将显式提供的原始对话加入节点模型请求；默认不加入原始对话、其他项历史或其他节点的完整对话。字段映射选择 `history` 则作为普通 JSON 输入。节点调用使用独立会话；循环重访产生新调用，显式失败重试产生新 attempt。生成目录是 `.sop-results/<run>/<execution>/<call>-<attempt>`，上传副本位于项目 `.sop-inputs`，需与数据库一起备份。

`structured_output.value` 返回 `status`、`reply`，可带 `slotUpdates`、`output`、`handoffText` 和合法 `nextNodeId`。`handoffText` 默认取 `reply`，与人工审批等待无关。终点不填写 `nextNodeId`。未知定义字段、执行请求字段和结果字段会拒绝。

## 子流程与 foreach

固定引用为 `"subSop":{"sopId":"extract-file","version":"1"}`。`subflow` 的 `input.fields` 映射为子执行输入，子流程 slots 独立。父节点 `output` 是返回 slots 的显式映射，如 `{"childAnswer":{"source":"output","path":"output"}}`，此时 `output` 来源是 `{itemKey,status,output,slots,handoffText}` 子结果。不自动合并子 slots。

`foreach` 使用相同固定引用；规划节点由 Agent 输出：

```json
{
  "status": "completed",
  "reply": "识别到三个股东",
  "foreach": {
    "items": [
      {"itemKey":"alice","input":{"name":"Alice"}},
      {"itemKey":"bob","input":{"name":"Bob"}},
      {"itemKey":"carol","input":{"name":"Carol"}}
    ],
    "concurrency": 3
  }
}
```

也可把列表放入 slots/结构化输出，在定义中设置 `items: "slots.shareholders"` 或 `items: "output.shareholders"`，返回 `foreach: {concurrency: 3}`。列表元素必须有唯一非空 `itemKey` 和对象 `input`。列表和并发决定在一次提交中持久化，空列表立即完成；1 为串行。结果按输入顺序汇总，失败项不阻断其余项，存在失败则父节点失败并保留成功结果。父节点 `output` 映射的来源此时是子结果数组。

嵌套共用部署和运行额度，只有运行中的叶节点占额度；等待子流程和审批不占额度。最多 8 层，递归 SOP 引用拒绝。支持运行时列表展开，不支持添加任意节点或依赖。单次运行最多 10000 项、单项最多 10000 次节点调用。

## Agent、Gateway 与 SDK

Agent 工具：`run_sop`、`sop_status`、`sop_result`、`sop_wait`、`sop_cancel`、`sop_retry`。同名 Python helper 可在 `execute_code` 中导入：

```python
from pilotdeck_tools import run_sop
run = run_sop(requestId="files-001", sopId="extract-file", version="1",
              concurrency=8, items=[
                  {"itemKey": str(i), "input": {"files": [file_ref]}}
                  for i, file_ref in enumerate(files)
              ])
print(run)
```

单次列表提交只调用一次 `run_sop`，返回 `runId`；后续运行独立于调用工具/代码的超时。未提供输入来源时继承当前提交捕获的 query、文件引用和可显式选择的历史；每项 `files` 覆盖当前文件列表。默认并发 8，超过部署上限明确报错。

Python helper 返回 `{content, data}`，读取 `response["data"]["runId"]`，不能直接从顶层取值。`requestId` 用于创建、取消和重试；只读查询不接受该字段。等待和结果分页：

```python
from pilotdeck_tools import sop_wait, sop_result

run_id = run["data"]["runId"]
print(sop_wait(runId=run_id, timeoutMs=60000))
print(sop_result(runId=run_id, offset=0, limit=100))
```

工具 `sop_result` 不指定 `limit` 时仅返回摘要与 `resultRef`，实际输出须显式分页。等待结束仍为 `running` 时可继续等待，不会取消持久化执行。

Gateway WS 方法 `sop_execution`：`{operation,input,projectKey?,approverAuthorization?}`。SDK：

```ts
const { runId } = await client.sop.call("run_sop", {
  requestId: "files-001", sopId: "extract-file", version: "1", items, concurrency: 8,
});
await client.sop.call("sop_wait", { runId, timeoutMs: 60000 });
const page = await client.sop.call("sop_result", { runId, offset: 0, limit: 100 });
for await (const event of client.sop.events(runId, { after: savedSequence, signal })) {
  savedSequence = Number(event.sequence);
}
```

SDK 事件订阅通过 Gateway 游标轮询，Runtime 原生 SSE 使用 `GET /v4/runs/<id>/events?stream=true&after=<sequence>`，支持 `Last-Event-ID`。序号持久递增，事件与状态变更同事务提交。终态时读完已持久化事件后结束；重连使用最后处理成功的 sequence。

| 操作 | Runtime 路由 | 输入/结果 |
| --- | --- | --- |
| run_sop | POST /v4/runs | requestId、sopId、version、input 或 items、concurrency?、model? |
| sop_status | GET /v4/runs/:id | offset/limit，父子调用、itemKey、节点、attempt、模型、usage、错误、counts、resultRef |
| sop_result | GET /v4/runs/:id/results | offset/limit，输入顺序的根项输出；工具默认仅摘要，显式 limit 才读取结果页 |
| sop_wait | Gateway/工具轮询 status | timeoutMs 0..60000，超时返回当前状态，不取消运行 |
| sop_cancel | POST /v4/runs/:id/cancel | requestId，取消传播到所有后代 |
| sop_retry | POST /v4/runs/:id/retry | requestId、callIds，仅失败叶节点 |
| sop_events | GET /v4/runs/:id/events | after，事件页和 nextSequence |
| sop_resume_execution | POST /v4/runs/:id/resume | requestId、callId、waitId、message；Gateway 注入已认证审批用户 |

运行接口需要 `X-SOP-Scope` 项目绝对路径，Gateway 自动填写。Runtime 仅向可信 PilotDeck host 开放，不把 host token 分发给最终用户。审批使用 `approval` 节点和固定 `assigneeUserId`；SDK options 的 `approverAuthorization` 传已有审批 authority 的 Bearer，用户不得自行填写 `subjectUserId`。

## 恢复、重试与运维

排队记录持久化。领取租约 60 秒，宿主每 10 秒续租。宿主重启后继续领取排队项；原运行项的结果无法确认时到期标记 `result_unknown`，拒绝旧租约提交与自动重放。当前没有跨宿主分布式执行，也没有从模型流中间自动重放业务操作。

业务失败默认不重跑。显式 `sop_retry` 只重试所选失败叶调用，不重跑成功兄弟或父规划；保留旧 attempt 和事件。`result_unknown` 禁止重试，需人工核对副作用，再决定是否另建业务运行。创建、提交、取消、重试、审批恢复都使用 requestId 幂等；同 ID 不同载荷拒绝。

取消立即将排队项及后代标记取消；运行中的宿主在续租被拒绝时中止 AgentSession，最长约一个 10 秒续租周期，已发生的外部副作用无法撤销。审批只恢复指定调用，其余项不受影响。

备份须协调停止宿主与 Runtime，备份新数据库、Pilot home/profile、项目 `.sop-inputs`、`.sop-results`。升级前保存当前代码版本和模型/工具配置。回退到旧版本时使用旧数据目录与原配置，禁止让旧 Runtime 打开 v4 数据库，不删除生产卷。

验收命令与证据见 `SOP_V4_ACCEPTANCE.zh-CN.md`。Linux Compose 部署、真实登录审批跨进程恢复、SIGKILL 后账本核对有专门验收；公网生产域名、集群和外部 StaffDeck release 仍需对应环境验收。

隔离容器、真实登录审批恢复与 SIGKILL 副作用夹具的历史验收见 [v4 执行验收](SOP_V4_ACCEPTANCE.zh-CN.md)。部署操作使用统一部署文档；验收脚本只用于专用测试实例。

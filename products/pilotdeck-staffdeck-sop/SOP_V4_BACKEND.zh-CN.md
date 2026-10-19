# SOP v4 后端执行

本入口用于全新环境，只接受 `sop.definition/v4` 和 `sop.lifecycle/v4`，不导入旧配置、旧数据库或进行中的运行。不包含前端。与 PR #660 的旧 SOP 部署使用不同进程、端口、Pilot home 和数据库。

## 职责与启动

Python Runtime 保存定义、流程实例、处理项、节点调用、尝试、租约和事件；PilotDeck 创建隔离 AgentSession，管理模型、工具、权限和共享工作空间。模型请求全部通过 PilotDeck。

前置条件：Node 22、pnpm 10、Python >=3.11。先在仓库根目录构建：

```sh
pnpm install --frozen-lockfile
pnpm run build
python3 -m venv /absolute/path/sop-v4/venv
/absolute/path/sop-v4/venv/bin/pip install -e packages/sop-runtime
```

Runtime 进程环境（所有值均为占位符）：

```sh
export SOP_V4_DB=/absolute/path/sop-v4/data/runtime.sqlite
export SOP_V4_HOST_TOKEN='<new-host-token>'
export SOP_V4_MAX_CONCURRENCY=32
/absolute/path/sop-v4/venv/bin/python -m uvicorn \
  staffdeck_sop_runtime.execution_api_v4:app_factory --factory \
  --host 127.0.0.1 --port 18991 --workers 1
```

PilotDeck 进程环境：

```sh
export PILOT_HOME=/absolute/path/sop-v4/pilot-home
export PILOTDECK_CONFIG_PATH=/absolute/path/sop-v4/pilotdeck.yaml
export SOP_V4_HOST_TOKEN='<same-new-host-token>'
node dist/src/cli/pilotdeck.js server
```

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

旧 `PILOTDECK_SOP_V4_ENDPOINT` / `SOP_V4_HOST_TOKEN` 环境入口保留，兼容原来的 owner 审批方式；推荐使用 YAML。两者同时配置时 endpoint 与 token 必须一致；与 v2/v3 或显式关闭 SOP 的 profile 冲突时报错。仅在 YAML 未声明 SOP 时使用旧入口。`/api/modules/runtime` 展示 v4 协议和就绪状态；不加载旧 SOP 页面。

`GET /healthz` 返回 `contract: sop.lifecycle/v4`。PilotDeck 在创建运行前检查协议、全部固定版本引用、模型绑定和工具绑定；实际调用前再次校验。模型不存在或不允许使用时失败，不切换为其他模型。

## 本机源码部署与插拔验收

使用 `scripts/sop-v4-source.mjs` 创建独立源码实例，Web 登录服务、Gateway 执行宿主和 Python Runtime 为三个独立进程。前置条件为上述 Node/pnpm/Python；根目录依赖必须先安装。准备器创建全新 venv 并安装当前 checkout 的 SOP package，模型配置从私有 YAML 复制到独立 Pilot home，不会输出凭据。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --dir ui run build
export SOP_V4_MODEL_CONFIG=/absolute/path/private/pilotdeck.yaml
export SOP_SOURCE_PYTHON=/absolute/path/python3.12
node scripts/sop-v4-source.mjs prepare /absolute/path/new-source-deployment
node scripts/sop-v4-source.mjs start /absolute/path/new-source-deployment
node scripts/sop-v4-source.mjs status /absolute/path/new-source-deployment
```

部署目录必须不存在。端口自动分配并写入 `deployment.json`；`private.json`、`home/pilotdeck.yaml` 和 `home/server-token` 为私有文件，权限 0600。模型 YAML 必须包含 `agent.model` 和 `model.providers`。默认准备器启用原生五槽与正式 SOP v4 YAML，关闭 Knowledge，并选择 owner 审批。当前 native 前端构建不包含 v4 页面。

同机 SOP/KM 组合使用 `profiles/independent-v4-local.yaml`，外部服务使用 `profiles/independent-v4-external.yaml`。源码准备器会重写托管服务的本地路径、端口，不读取样例中的占位路径；外部地址保留。将任一模块设为 `{ enabled: false }` 可准备 SOP-only 或 KM-only。

```sh
node scripts/sop-v4-source.mjs prepare /absolute/path/new-combined \
  --profile products/pilotdeck-staffdeck-sop/profiles/independent-v4-local.yaml \
  --knowledge-package /absolute/path/knowledge_core --without-web --build
node scripts/sop-v4-source.mjs start /absolute/path/new-combined
node scripts/accept-sop-v4-km.mjs /absolute/path/new-combined
node scripts/accept-sop-v4-approval.mjs /absolute/path/new-combined
node scripts/sop-v4-source.mjs stop /absolute/path/new-combined
node scripts/benchmark-sop-v4-startup.mjs /absolute/path/new-combined
```

`--without-web` 仅运行服务与 Gateway；移除此参数可启动登录服务，`--approval-provider pilotdeck` 启用 owner 审批。`start --services-only` 只拉起 YAML 声明的托管 Runtime，供独立执行宿主连接。所有外部凭据通过环境提供，外部服务不被启动或停止。首次 prepare 安装 Python 包，start 不安装、不构建；`prepare-timing.json` 和 `startup-benchmark.json` 分别记录准备和十轮启动。组合验收目标为依赖与构建准备完成后每轮不超过 10 秒，包含协议、数据库、KM 空间初始化和 SDK 绑定检查，不包含模型响应时间。不是操作系统冷缓存或跨机器性能承诺。

托管 KM 默认启用服务认证，准备时生成独立 `knowledge-identities.json`，绑定 YAML 的 namespace 和 spaces；不访问 SD 用户库。私有模型配置用于独立 KM 本地模型调用，宿主节点仍通过 PilotDeck 模型接口运行。`knowledge-data/knowledge.sqlite` 与 SOP 数据独立，日志位于该目录的 `service.log`。无需 Web 的拓扑测试可运行 `node scripts/accept-sop-v4-topologies.mjs /absolute/stopped-combined /absolute/new-evidence /absolute/knowledge_core`；它临时启动自己的服务，覆盖 SOP-only、KM-only、外部连接及退出所有权。

控制器仅监听 loopback，采用单 Gateway/Runtime，服务日志位于 `logs/`，SQLite 位于 `runtime-data/runtime.sqlite`，上传与生成文件位于 `workspace/`，会话和账号位于 `home/`。这是本机后端验收入口，包含 `native_probe` 测试工具及非交互执行配置。公网部署应使用正式服务管理及业务权限配置。

```sh
node scripts/accept-sop-v4-source.mjs /absolute/path/new-source-deployment
export SOP_RUNTIME_PYTHON=/absolute/path/new-source-deployment/venv/bin/python
node scripts/test-sop-v4-modules.mjs
node scripts/sop-v4-source.mjs stop /absolute/path/new-source-deployment
```

真实模型脚本使用正常注册/登录与工作区注册 API，上传 12 个文本文件，由 Agent 通过 `execute_code` 决定并发并提交 SOP，再验证动态子流程、失败项重试、双模型、审批全进程重启恢复及输入隔离。注册账号记录在私有 `owner-login.json`，结果在 `acceptance-*.json`。重复运行会创建独立定义和数据，脚本会停止并重启本实例全部进程，不得指向其他部署目录。

插拔脚本另启临时 Python Runtime、AgentLoop sidecar 和模块 HTTP 夹具；Gateway/SDK 在测试进程中运行。Tools、Context、Skills、Knowledge 和 Model Provider 的外部端均为独立进程协议夹具，不代表外部 StaffDeck release。AgentLoop/Tools/Context/Model Provider 为必选槽，验收替换与断开；Skills/Knowledge 可关闭。旧插拔脚本仍覆盖环境兼容入口，新组合脚本覆盖 YAML v4 与真实 KM。修改绑定后重启 Gateway/会话，不声称运行中热切换。

停止后备份 `home`、`workspace`、`runtime-data`、`knowledge-data`、`knowledge-*.json`、`private.json` 和 `deployment.json`。升级使用新的源码 checkout/构建产物；回退同时恢复对应版本及原数据目录，不删除已有数据库。完整证据和边界见 [源码插拔报告](SOP_V4_SOURCE_ACCEPTANCE.zh-CN.md)。

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

## 隔离容器部署与恢复验收

`scripts/deploy-sop-v4.mjs` 将当前 `dist`、Web 登录服务源码、Python Runtime 源码复制到一个全新目录并构建镜像。需要先完成上面的 `pnpm run build`；Docker Compose v2 可用。默认使用本机已有的 `pd-independent-export-1019-pilotdeck:latest`、`pd-independent-export-1019-sop-runtime:latest` 基础镜像，其他环境必须先用现有 exporter 构建对应基础镜像，或在导出的 Dockerfile 中设置 `PILOTDECK_BASE_IMAGE` / `SOP_BASE_IMAGE`。这不是从空白机器一条命令安装所有依赖的入口。

```sh
export SOP_V4_MODEL_CONFIG=/absolute/path/private/pilotdeck.yaml
node scripts/deploy-sop-v4.mjs /absolute/path/new-sop-v4-deployment
node scripts/accept-sop-v4-deployment.mjs /absolute/path/new-sop-v4-deployment
```

部署目录必须不存在；脚本生成随机 host/Gateway token，私有配置和凭据权限为 0600。服务是生产模式的 Linux 容器，只有一个 Gateway 宿主和一个 Runtime worker。宿主端口为 Web `23314`、Gateway `18814`、Runtime `18914`，均只绑定 loopback。Compose 项目名固定为 `sop-v4-acceptance`，一台机器只运行这一套验收环境；先核对端口和已有同名项目。旧部署的入口脚本会接管启动命令，因此 Gateway 镜像明确清空原 entrypoint。

这是后端验收部署：Web 提供现有真实注册/登录接口，没有新增 v4 前端。固定工作空间为 `/workspace`，非交互执行使用 `bypassPermissions`，业务节点仍受定义的工具白名单约束。公网生产部署需要按业务权限要求配置认证、网络和工具，不能直接将这组 loopback 端口改为公网开放。

验收会真实消费已配置模型，重启该套容器，创建两项审批和一个副作用夹具运行。夹具工具在追加账本并 fsync 后故意阻塞，由脚本 SIGKILL Gateway；它不去重，任何重放都会产生第二条记录。脚本检查真实租约到期、unknown 状态、重试/过期提交拒绝，最后关闭夹具。账本代表测试副作用，不涉及外部支付、邮件或企业生产交易。

验收目录保存 `evidence-*.json`、`workspace/effects.jsonl`、原始模型请求和数据库。实际登录密码在 `owner-login.json`，不输出到报告；token 和模型凭据不进入构建上下文。备份演练先停三个服务，复制 `home`、`workspace`、`runtime-data`，再启动独立 Runtime 容器打开备份，检查审批完成和 unknown 状态均保持。备份包含私有配置，应按部署目录相同级别保护。

```sh
docker compose -p sop-v4-acceptance -f /absolute/path/new-sop-v4-deployment/compose.yaml ps
docker compose -p sop-v4-acceptance -f /absolute/path/new-sop-v4-deployment/compose.yaml stop
docker compose -p sop-v4-acceptance -f /absolute/path/new-sop-v4-deployment/compose.yaml up -d --wait
```

停止不会删除文件数据。禁止使用 `down -v` 清理生产数据。恢复旧版本时使用旧镜像和原数据目录，保留本次 v4 目录。

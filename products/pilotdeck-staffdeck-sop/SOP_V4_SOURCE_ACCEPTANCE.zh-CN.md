# SOP v4 源码部署与七槽插拔验收

本文件保留最初源码/插拔验收记录；后续正式 YAML、可替换审批、真实 KM/Compose 和启动门槛的当前结果见 [解耦验收报告](SOP_V4_DECOUPLED_ACCEPTANCE.zh-CN.md)。后续 v4 不再依赖下文最初的环境变量启用方式，模块状态接口已准确展示 v4。

日期：2026-10-19。先拉取远端 `codex/standalone-alpha1-km-sop-parity`，本地与远端均为 `06c29176b2cf3d6db811994c02853c49c93d0fdb`。实施使用独立 `codex/sop-v4-backend` worktree，主工作区及之前的源码/容器部署未替换。以下结果包含本次未提交修复，不等同于仅部署远端基线。

## 部署

源码 checkout：`/Users/a1/.codex/worktrees/sop-v4-backend/PilotDeck`。新目录：`/Users/a1/.local/share/pilotdeck/sop-v4-source-20261019`。Node 22.23.1、pnpm 10.32.1、Python 3.12，新 venv 安装当前源码 package，独立 SQLite、工作区、账号和随机 token。PilotDeck 依赖复用此 checkout 安装，不宣称全新系统依赖安装。

保留三个独立源码进程：Web `http://127.0.0.1:63671`、Gateway `ws://127.0.0.1:63672/ws`、SOP Runtime `http://127.0.0.1:63673`。没有使用 Docker 启动本实例。Web 使用正常登录，账号位于部署目录私有 `owner-login.json`。v4 使用专用环境变量启用，旧 `modules.sop` 关闭；没有新增前端。

构建 `pnpm build`、`pnpm --dir ui run build` 通过。前端使用 native 五槽 profile，Knowledge 和旧 SOP 页面不启用。Web/Gateway 共享私有 server-token。启动和停止命令见 [后端部署说明](SOP_V4_BACKEND.zh-CN.md#本机源码部署与插拔验收)。

## 七槽范围

模块协议验证使用真实 Python SOP Runtime、实际 stdio/TCP AgentLoop sidecar、独立 HTTP 模块夹具、真实 WS SDK；Gateway 在测试进程内创建。外部 Tools/Context/Skills/Knowledge/Model Provider 是确定性协议夹具。每个场景创建新的 profile/Gateway/会话，不把配置重启视为运行中热插拔。

| 槽位 | 检查 |
| --- | --- |
| AgentLoop | 原生、stdio、TCP；TCP 断开失败、重连成功；禁止关闭必选槽 |
| Tools | 原生与外部目录、节点白名单、缺失工具预检拒绝、外部服务断开与重连；禁止关闭必选槽 |
| Context | 外部输入编排标记进入模型请求，断开与重连；禁止关闭必选槽 |
| Skills | 原生与外部 list/read、关闭后依赖预检拒绝、外部服务断开与重连 |
| Knowledge | 关闭后依赖拒绝、外部 query、真实端口 resolve_citation 调用、断开与重连 |
| Model Provider | 外部 prepare/stream、断开失败、重连成功；禁止关闭必选槽 |
| SOP | endpoint 未配置时工具不可用，服务不可达时预检拒绝；宿主离线时队列持久化，连接后完成 |

另有 TCP AgentLoop 与全部外部槽位组合运行。标题生成走原生 provider 的不可达 fixture URL，会记录 fetch failed；这些日志与声明的 SOP 业务结果分开，不计为真实模型成功。

最终矩阵 33/33 通过，退出码 0；证据为 `/var/folders/xd/mml9c6fj2g95x40hgf_n6lrr0000gn/T/sop-v4-modules-f3g2Ha/report.json`，相邻 `module-calls.jsonl` 保存端口实际调用。测试进程及其子进程均已清理。13 项聚焦 TypeScript 回归通过，无失败或跳过，涵盖项目会话、工具组合、配置、异步 SOP 预检与执行前验证。

## 真实模型业务

`scripts/accept-sop-v4-source.mjs` 通过实际 Web 注册/登录及工作区注册接口，实际上传文件、WS SDK 提交 Agent 任务，模型没有替身。

首个完整通过证据：部署目录 `acceptance-61ec210b.json`。

最终修复构建后完整复跑通过：`acceptance-bed7c86a.json`，退出码 0；batch `c18836a21fe640bb8c66c856135b31bf`，审批 `6b79576b2a8c47599c35bfe631720705`。额外直接读取三个股东场景结果，确认每组都是 Alice/Bob/Carol 且 checked=true。Web 实际返回构建后的 `/assets/` 页面，正常登录后的 `/api/modules/runtime` 返回 200、gatewayState=ready、unavailableSlots=[]。该接口只展示旧 profile 中关闭的 SOP 槽位；v4 健康与状态使用其专用 `/healthz` 和 SDK SOP 接口，本次没有开发 v4 前端。

| 场景 | 结果 |
| --- | --- |
| 12 文件 | Agent 调用 execute_code 中的 run_sop，选择并发 3；INV-1..12 全匹配、金额合计 78 |
| 动态列表 | 真实模型从文字识别 Alice/Bob/Carol；串行完成，嵌套 foreach -> subflow -> task 并行完成 |
| 失败项重试 | Bob 第一次失败，显式 retry 后 attempt=2；成功兄弟保持 attempt=1 |
| 模型选择 | 持久化 model_request 包含 deepseek-v4-flash-0731 与 qwen3.6-flash-distill |
| 输入隔离 | 12 个提取节点请求各只含一个 invoice ID；主 Agent 的 3 个请求不含 invoice 全文 |
| 审批恢复 | 正常 owner 身份，等待期间停止全部三个进程；新 PID 启动后 callId/waitId 保持，无凭据拒绝，登录 JWT 恢复；重复恢复只执行一次 |

文件是 UTF-8 文本发票夹具，不涵盖 PDF/OCR。股东处理是本地 checked=true 业务夹具，未做互联网企业尽调。审批是 PilotDeck 真实 owner 登录，不是企业外部审批系统。

## 修复与失败记录

- SOP 预检此前只检查宿主 ToolRegistry，误拒绝外部 Tools 和会话注入的 Knowledge 工具。现与实际工具构建保持一致，并等待异步能力校验。
- 外部工具目录此前未受节点 allowedTools 过滤。现应用相同会话策略，矩阵直接检查模型可见工具清单。
- 节点执行前同样等待绑定校验，回归测试验证校验拒绝时不创建业务运行/节点会话。
- 测试夹具更正：Context 显式返回 systemPrompt；工具错误让确定性模型返回 failed；TCP 重启等待就绪；SDK 使用 run.events()；工作区通过正式注册 API 注册。
- 扩展测试曾给 staffdeck.knowledge/v1 设置仅 knowledge-core/v1 支持的 agentMethods，被配置校验拒绝；改为在其公开 Knowledge port 调用 resolve_citation，没有放宽产品协议。

失败临时目录保留：`sop-v4-modules-P49dhY`、`nLFxNi`、`12lNWy`、`4dIaYq`、`EaK6sv`、`f4tl4R`。失败源码证据 `acceptance-*.json` 同样保留，不计入成功。

## Native / Sidecar 对拍复跑

2026-10-19，使用上述 checkout 的当前未提交修复及已构建 dist，Node 22.23.1 / Python 3.12.2，复跑仓库内 PilotDeck-only Gateway 对拍矩阵。两轮各 53 个场景、各 106 次 native/sidecar adapter 执行，均退出码 0；`failed=[]`、`blocked=[]`、`oracleFailures=[]`、`knownGaps=[]`。另有 trace 比较器测试 59/59、预算与快照测试 4/4 通过，包含缺失 handshake/module proof 和预算错误注入的负向校验。

```sh
env -u NODE_OPTIONS PATH=/absolute/path/node22/bin:$PATH python3.12 \
  tools/agent-loop-parity/run.py --pilotdeck-root "$PWD" \
  --comparison same-version --surface gateway --scenario all \
  --output /absolute/path/new-parity-output
python3.12 -m unittest discover -s tools/agent-loop-parity -p test_trace.py
node --test tools/agent-loop-parity/test_budget_evidence.mjs \
  tools/agent-loop-parity/compact-snapshot.test.mjs
```

两轮证据：`/Users/a1/.local/share/pilotdeck/parity-rerun-20261019/summary.json` 与 `/Users/a1/.local/share/pilotdeck/parity-rerun-20261019-round2/summary.json`。目录保存每场景原始 JSONL 和差异报告。deadline 的两个字段差异严格匹配仓库既有 transport extension；continuable live/cold 匹配既有 actor comparator；其余格式警告不改变语义结论。没有修改场景、比较器或归一化规则。

该矩阵覆盖确定性模型/工具、权限、取消/超时、媒体、恢复、压缩、预算、流式输出、steer 和子代理生命周期；比较当前 native 与当前 stdio sidecar，不包含 origin/main 版本漂移、StaffDeck Harness/旧 SOP 状态机或真实模型业务。现有源码实例三个服务在复跑结束后仍运行。

## 验收边界

本次为 macOS loopback 源码部署及后端业务验收。未验证公网域名/TLS、Linux systemd、外部 StaffDeck release、企业数据、PDF/OCR、分布式多宿主或真实外部交易核账。此前容器强杀/账本证据仍见 [既有 v4 报告](SOP_V4_ACCEPTANCE.zh-CN.md)，本次没有用它替代源码测试，也没有重复宣称真实支付系统验收。

本次改动尚未提交或推送。部署目录含私有配置、数据库与原始模型请求，不能整体加入版本库。

# SOP v4 后端验收记录

日期：2026-10-19。基线为 PR #660 的 `b436dddbf4575b938c20295dca59110f04b87a0e`，实现位于独立分支 `codex/sop-v4-backend`。没有修改主工作区，没有生产迁移。以下测试均使用全新数据库。

## 可重跑入口

在 Node 22 / pnpm 10 环境下，从仓库根目录运行。Python 必须安装 `packages/sop-runtime[dev]`；脚本设置本 checkout 的 PYTHONPATH，避免导入其他安装的旧 Runtime。

```sh
export SOP_RUNTIME_PYTHON=/absolute/path/venv/bin/python
node scripts/test-sop-v4.mjs
pnpm exec tsx --test tests/tool/builtin/executeCode.spec.ts \
  tests/cli/project-session-factory.spec.ts tests/cli/project-session-runtime-bundle.spec.ts
pnpm exec tsx --test packages/sdk/test/transport.test.ts
pnpm run build
```

真实模型入口会读取本地私有配置，创建临时项目/数据库，上传 12 个测试文件。不要把生成的 `pilotdeck.yaml`（含 provider 配置）加入版本库。

```sh
export SOP_V4_MODEL_CONFIG=/absolute/path/private/pilotdeck.yaml
export SOP_V4_SECOND_MODEL=qwen3.6-flash-distill
node scripts/test-sop-v4.mjs --real
node scripts/inspect-sop-v4-evidence.mjs /absolute/path/printed-evidence-directory
```

真实测试保留临时目录中的数据库、项目会话、原始模型请求、上传文件与结果。确定性集成测试运行后清理临时目录。以上真实测试是人工指定启动的，不会在普通回归中隐式消费模型。

## 确定性验证

| 覆盖 | 结果与边界 |
| --- | --- |
| 1000 项 | PASS；并发 16、第二次 claim 不超额、执行中重开 SQLite、结果分页/顺序、事件游标；第 500 项注入失败后仅显式重试该项 |
| 部署并发 | PASS；多个运行共用 32 叶节点额度，嵌套等待不占额度，foreach 自身额度生效 |
| 子流程/foreach | PASS；父子映射、隔离 slots、顺序汇总、成功项保留、空列表、递归拒绝、8 层允许/9 层拒绝 |
| 输入 | PASS；默认 query/handoff/files，无 attachments/history；显式 query、latest、handoff、slots、附件和原始 history；循环重访使用新 call |
| 幂等和事务 | PASS；重复创建/提交/取消/重试/审批恢复；非法 foreach 提交回滚状态和事件 |
| 租约 | PASS；过期调用标记 result_unknown，旧提交拒绝，不自动重放，不允许显式 retry unknown |
| HTTP 恢复/审批 | PASS；关闭并重新创建 Runtime，原 waitId/callId 保持；错误用户拒绝，正确用户仅恢复指定调用 |
| 事件 | PASS；持久游标补取、SSE Last-Event-ID、SDK 迭代补取终态事件 |
| 执行宿主 | PASS；提交响应丢失只重复提交结果，不重复执行叶节点；关闭宿主中止 active 调用并记录 unknown |
| Agent/SDK 链路 | PASS；真实上传接口 + AgentLoop + execute_code Python helper + HTTP Runtime + WS SDK，模型为确定性替身 |

Python v4 聚焦用例 11 个；TypeScript v4 聚焦用例 4 个通过，真实模型用例在普通运行中跳过。既有 execute_code/项目会话回归 15 个通过；SDK transport 139 个通过。构建与类型检查通过。

1000 项是调度及持久化测试，不代表 1000 真实模型并发或生产容量。此表中的审批重启和故障注入采用确定性环境；新增真实容器验收见下节。

## 真实模型结果

最后完整通过轮次目录：`/var/folders/xd/mml9c6fj2g95x40hgf_n6lrr0000gn/T/pilotdeck-sop-v4-2qCy8B`。真实模型用例通过，耗时约 124 秒；检查脚本直接读取数据库及持久化 `model_request`，没有通过结果标签推断模型调用。

| 场景 | runId | 结果 |
| --- | --- | --- |
| 12 文件批量提取 | 27cdb6c83f7248b6b5bad6188dba363b | 12/12 完成，INV-1..12 全部匹配，金额合计 78；Agent 用 execute_code 提交，选择并发 3，实测峰值 3 |
| 三股东串行 | 04d9c831a6b24746b0c91fac52f4aeed | Alice/Bob/Carol 全部完成，运行额度 1，峰值 1 |
| 嵌套并行 | 81177a6cc9bc454aa6a34cf99ffcb4d9 | company foreach -> holder-wrapper subflow -> holder；三项完成，峰值 3 |
| 单项失败与重试 | da0aed36d26d4f6499555f4c6eafd5bb | Bob 首次失败，成功兄弟保留；显式 retry 后完成，仅 Bob attempt=2，其余 attempt=1 |

检查到 26 个 SOP 节点模型请求，其中 12 个文件请求各只含自己的一个 invoice ID；节点请求不带其他项历史，主 Agent 请求不含 invoice 全文。附件全文是定义显式选择 `attachments` 后传给提取节点的。

实际路由同时包含 `provider1/deepseek-v4-flash-0731` 与 `provider1/qwen3.6-flash-distill`。子 SOP 的模型选择覆盖运行默认值，记录 usage。provider 返回的内部别名（例如 qwen3.6-flash）不等同于 PilotDeck 自动替换模型。

股东内容是本地业务夹具：模型从文字识别三人并输出 checked=true，没有进行互联网企业尽调。12 个文件为真实经过上传/解析/模型请求链路的 UTF-8 文本夹具；不代表 PDF OCR、大文件或所有文档格式验收。

## 失败轮次与修复

以下原始失败目录保留，不计入通过轮次：

| 目录后缀 | 观察与处理 |
| --- | --- |
| myOBaf | Agent 将文件引用简化为字符串路径，附件解析器随后兼容路径/引用对象；旧失败保留 unknown |
| ZI7euF | foreach 错放在 output 内，SDK 30 秒请求超时早于 wait；修正节点输出约束及 SOP 请求超时 |
| iGohoQ | 第二模型将 structured_output.value 编码为 JSON 字符串；宿主增加 JSON 解析 |
| cPHxrs / kO6TVc | 模型空 optional 字段或虚构结束节点；增加 SOP 专用结果 schema、终点/合法边说明，非法提交明确失败 |
| dNZXxj | 真实失败项 key 为 bob，测试错误地固定大小写；断言按业务名比较，控制操作仍使用持久化 callId |

会话标题生成出现 missing_title、empty_content 和 timeout 日志；业务节点验收成功，不把标题生成视为 SOP 业务结果。

## Linux 容器部署与真实恢复

可重跑入口为 `scripts/deploy-sop-v4.mjs` 和 `scripts/accept-sop-v4-deployment.mjs`，具体前置条件、端口、凭据和停止方式见后端接口文档的“隔离容器部署与恢复验收”。使用当前独立 worktree 的 `dist` 构建 Linux 镜像，三个独立服务为 Web 登录服务、PilotDeck Gateway/执行宿主、SOP v4 Runtime；`NODE_ENV=production`，SQLite 与项目文件持久化至独立宿主目录。

当前部署目录：`/Users/a1/.local/share/pilotdeck/sop-v4-container-20261019-r3`。Web 登录入口 `http://127.0.0.1:23314`，Gateway `ws://127.0.0.1:18814/ws`，Runtime `http://127.0.0.1:18914`。此入口用于后端验收，没有新增 v4 前端。

首轮完整通过证据：`evidence-c99015947a.json`；审批运行 `59fb503f9d7a4e71b2f63ba5798539d7`，强杀运行 `73c613ceba854c5eae170c332c4ed983`。两个审批项通过真实 HTTP 注册/登录得到 owner 身份，等待期间停止全部容器再启动，核对 callId/waitId 保持；重新登录恢复 A 后，B 仍等待，重复恢复 A 只执行一次；随后 B 完成。缺失凭据、无效 Bearer、自填 subjectUserId 均拒绝。游标补取包含两次 approval_resumed，没有因重复请求产生第三次。

副作用由真实模型调用 `acceptance_ledger` 工具触发：追加一条账本并 fsync，工具故意不返回。确认数据库调用仍为 running 后 SIGKILL Gateway。使用真实墙钟等待 60 秒租约过期，状态变为 `result_unknown` / `SOP_LEASE_EXPIRED`；attempt 保持 1，账本记录保持 1。显式 retry unknown 和旧租约 submit 均拒绝，继续观察后没有自动重放。验收结束后关闭该工具，容器健康运行。

这里的账本是可核对的本地业务夹具，不是支付、邮件或企业系统交易。通过的是“已持久化副作用 + 结果未提交 + 强杀后不重放”的行为；外部业务系统仍须使用其流水/幂等键完成核账。

首轮部署曾发现基础镜像 entrypoint 接管启动命令，已清空并重建；原有部署占用 3314 端口，已改用 23314，没有停止原服务。失败目录 `sop-v4-container-20261019`、`sop-v4-container-20261019-r2` 保留，不计入通过轮次。

此处“部署通过”限于本机 Docker 的 Linux 容器生产模式部署及实际业务调用，不代表公网生产域名、集群高可用或真实企业数据上线。

复跑完整证据为 `evidence-8e0fa3df6e.json`，2026-10-19 13:48:19 至 13:50:30（北京时间），脚本退出码 0。审批运行 `4131abac7aaa44ae8f0d085e25e57223`，强杀运行 `2d8bed4c117e411188c86b30c72c630c`。该轮额外记录容器实际 PID、启动时间和命令，确认全停/重启及 SIGKILL 后进程均已更换；直接读取持久化 model_request，确认两项审批分别且仅发起一次 `provider1/deepseek-v4-flash-0731` 节点请求，均含授权回复。

该轮在停止三个服务后备份 `home`、`workspace`、`runtime-data` 至 `backup-8e0fa3df6e`；用独立临时 Runtime 容器打开备份数据库，确认上述审批为 completed、强杀为 result_unknown。临时恢复容器已删除，原部署三个服务重新启动后全部 healthy。此演练覆盖该隔离部署的停机文件备份与 Runtime 状态恢复，没有执行旧版本镜像回滚或生产历史数据迁移。

## 未执行的验收

- 公网生产域名/TLS、外部 StaffDeck release、真实生产数据与集群高可用、隔离沙箱。
- 企业外部支付/邮件等系统的副作用核账，外部 SSO/审批服务；本轮使用真实 PilotDeck owner 登录和本地持久账本。
- 所有显式输入组合的真实 provider 请求矩阵；映射在 Runtime 测试，默认隔离/显式文件内容在真实模型请求中验证。

部署和协议限制见 [SOP v4 后端接口](./SOP_V4_BACKEND.zh-CN.md)。本报告不宣称上述公网生产与外部系统验收完成。

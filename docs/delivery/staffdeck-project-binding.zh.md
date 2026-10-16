# PD 项目与 StaffDeck 智能体自动绑定

在 PD Gateway、Web 服务和 SD 服务中设置 `STAFFDECK_PROJECT_BINDING_ENABLED=true`。
保持 `PILOT_HOME` 指向同一安装目录；单个安装连接一个 SD 租户。
旧部署不设置此开关即可继续使用原固定目标模式。

## 连接配置

PD Gateway 与 Web 服务需要以下服务端环境变量：

- `STAFFDECK_FORMAL_API_ORIGIN`：SD 服务根地址。
- `STAFFDECK_COPY_TENANT_ID`、`STAFFDECK_COPY_ACTOR_USER_ID`：SD 租户及账号 ID。
- `STAFFDECK_COPY_PILOTDECK_USER_ID`：PD 安装用户 ID。
- `STAFFDECK_COPY_USER_TOKEN`：SD 账号登录凭证。
- `STAFFDECK_SOP_MANAGEMENT_API_KEY`、`STAFFDECK_SOP_MANAGEMENT_CREDENTIAL_ID`：该账号的全量访问 API 密钥及 ID，需包含 agents、knowledge、sops 的读写和 SOP 发布权限。
- `STAFFDECK_SOP_RUNTIME_ORIGIN`：独立 SOP 执行服务地址。

SD 回调继续使用 `PILOTDECK_DOMAIN_HOST_ENABLED=true`、`PILOTDECK_GATEWAY_URL`、
`PILOTDECK_GATEWAY_TOKEN_PATH`、`PILOTDECK_USER_ID`，以及上述租户/账号和项目模式开关。
项目模式无需设置固定 `STAFFDECK_COPY_TARGET_AGENT_ID`。
项目模式的 SOP 发现请求默认限时 90 秒，执行服务调用仍默认 30 秒。
`modules.sop.discoveryTimeoutMs` 和 `timeoutMs` 可分别显式配置；故障不会静默绕过发现路由。
账号和 API 凭证由现有登录及凭证管理流程提供；本功能不签发凭证。

## 项目生命周期

新建目录、添加目录和克隆仓库共用项目注册流程，自动创建空白 SD 智能体。
已有项目打开时只读取状态，通过“创建并绑定”显式接入；已存在的项目配置
显式 agentId 会验证后复用，不覆盖冲突身份。失败保留 PD 项目，普通聊天可继续。
重试验证原目标；归档或撤销权限不会自动创建替代智能体。

绑定 UUID、安装 UUID、目标身份和状态保存于
`PILOT_HOME/staffdeck/project-bindings.json`，跨进程更新使用本地文件锁。
这份安装状态应随安装数据保留。删除项目不会删除该记录或 SD 智能体；同路径重新添加可恢复。
智能体名称是初次项目目录名加 UUID 短后缀。

项目 SOP 快照与发布回执存于 `PILOT_HOME/staffdeck/<binding UUID>/`；
空白项目不启用 SOP 执行，首个成功发布流程成为默认流程。
知识库、SOP 管理、资源同步和回调使用同一项目智能体身份。
全局资源和“通用 / 仅限 SOP”沿用 SD 的已有规则，不在初始化时复制资源。

## 接口与状态

PD：`GET /api/projects/:projectName/staffdeck-binding` 查询；
`POST /api/projects/:projectName/staffdeck-binding/ensure` 创建、验证或重试。
状态为 disabled、pending、binding、bound、failed，错误不包含凭证。
模块请求携带 `X-PilotDeck-Project` 项目标识，由服务端解析绑定。

SD：`POST /api/v1/agents:ensure-project-binding` 接收
`installation_id`、`project_binding_id`、`name`，返回相同标识与 `agent`。
创建固定使用 `source_mode: blank`，不从全局或示例智能体复制资源。
租户、安装、项目标识具有永久唯一映射；创建智能体和映射在同一事务提交。
新增表由 SD 原有 `init_db/create_all` 建表机制创建，无需修改旧表。

生产上线前先部署支持 ensure 接口的 SD，再部署 PD 并启用开关。
旧固定部署保持开关关闭；不要同时将旧固定目标用作所有项目的默认目标。
回滚关闭开关并恢复原固定配置；保留绑定数据和 SD 智能体。

## 错误与恢复

绑定摘要的 `error.code` 与 `error.message` 可用于展示和诊断，凭证不进入摘要。

| 错误 | 处理方式 |
| --- | --- |
| `PROJECT_BINDING_CONFIG_REQUIRED` | 补齐服务端连接配置后重试。 |
| `PROJECT_BINDING_CREDENTIAL_INVALID` | 更新同一账号的有效全量凭证后重试。 |
| `PROJECT_BINDING_IDENTITY_CONFLICT` | 检查显式 agentId、SD 地址或租户冲突，不自动覆盖已有目标。 |
| `PROJECT_BINDING_TARGET_OCCUPIED` | 该智能体已属于其他项目，本轮不提供更换或解绑。 |
| `PROJECT_BINDING_TARGET_UNAVAILABLE` | 恢复原智能体状态或权限后重试，不创建替代目标。 |
| `PROJECT_BINDING_UPSTREAM_REJECTED` / `PROJECT_BINDING_UNAVAILABLE` | 恢复 SD 服务、网络或权限后重试。 |
| `PROJECT_BINDING_BUSY` | 其他进程正在更新绑定，稍后重试。 |

已绑定状态读取最多每 30 秒重新验证目标；项目列表只读持久化摘要。
进程中断留下的 binding 状态在没有有效锁时显示为 pending，重试使用原 UUID。
只有目标验证、项目配置解析及 Gateway 运行时加载成功后返回 bound。
后台任务查询、结果、取消与事件流也校验任务所属智能体。

## 验证记录（2026-10-13）

最新逐项结果见 [上线前执行报告](../testing/staffdeck-binding-acceptance-2026-10-13.md)。
可复现脚本见 [测试入口说明](../../scripts/staffdeck-binding/README.md)。
脱敏结果、实际事件与截图位于 `docs/testing/evidence/staffdeck-binding-2026-10-13/`。

本轮已运行正式 SD 应用、编译 Gateway、生产 Web 构建、独立 SOP 服务以及真实模型。
最新完整绑定核心101项、SD82项通过；已有发布10项、UI89项及shell44项证据保留，数量有重叠。
项目默认发现预算90秒后，正式SD的31秒延迟恢复及全新真实模型六组各三轮18项通过，15次发现最长27.482秒。
历史超时、审批失败、夹具干扰和模型瞬时服务异常均保留；当前未提交候选满足报告中的SQLite隔离上线前验收条件，不代表已经部署或生产验收。
旧 PD21/UI108/SD25 与 `/tmp/pd-sd-binding-qa.kJse4x/` 是历史交付起点，不能替代本轮正式验收。
所有原始临时目录包含私有测试配置，不可整目录提交。没有部署生产。

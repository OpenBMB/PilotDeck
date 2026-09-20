# 七模块可插拔开发 SOP

状态：实施中，尚未通过 G0-G5。范围：后端。关联：[设计](BACKEND_MODULE_COMPOSITION_DESIGN.md)、[Roadmap](ROADMAP.md)、[验收要求](ACCEPTANCE_REQUIREMENTS.md)。

## 1. 开发目标与约束

交付组合：PilotDeck AgentLoop、Skill、Tool、Context（含 Compaction）、Model Provider + StaffDeck SOP、知识管理。所有模块通过明确的 Port、契约和 binding 装配；未知实现满足已支持协议即可通过配置接入。

不修改各模块核心语义。算法、默认值、阈值、排序、提示构造、权限、错误、重试、完成/等待规则及存储事务边界均以各自冻结的 origin/main 为准。接口提取、数据映射、传输和依赖注入可以变动；算法复制到 glue、替代原 owner、为测试改变规则不允许。

本 SOP 约束当前和后续实施，不表示所有步骤均未执行，也不把已有代码视为自动完成。每次接手先盘点候选代码、未提交改动、最新证据和最早未通过门槛；文档和历史 PASS 不代替最终候选的验收证据。

### 协议接入与常用模块豁免

开发者接入已有插槽时，只需实现已发布契约并提交 manifest、配置和部署来源；模块自己的 adapter 可以编写，PilotDeck 不需要新增厂商代码或重新构建。协议测试包面向任何实现公开运行，不要求进入宿主实现名单。

常用的 PilotDeck 五个原生模块可用内置 Port + 静态 descriptor，免独立服务、网络握手及该原生实现的 RPC 打包；仍必须参与统一装配和原始 main 等价测试。对应插槽的外部协议实现不能因此缺失。StaffDeck SOP/知识管理保留真实跨进程验收。

每项内置豁免记录插槽、实现 ID、版本、豁免的传输检查、替代的 Port/schema 检查及 parity 证据。豁免不得包含核心语义、状态/权限规则、失败传播或外部实现接入门槛。新厂商实现无需申请同类豁免，直接通过标准协议接入。

## 2. 冻结正确的基线

2026-09-18 通过 `git ls-remote origin refs/heads/main` 观察到：

| 仓库 | 原始 main 候选基线（完整 commit ID） | 当前工作分支提交 |
| --- | --- | --- |
| OpenBMB/PilotDeck | `ecedc5c32f2b8c8e5387cb2faba70cccf65650fd` | `ec34a7cea8c83bb76842a9cd062fa53d5fcfb31a` |
| OpenBMB/StaffDeck | `7adc7c84f61bd6cca13ff0380a811cbb3ae3c544` | `7fdc8d427790229541405abf10fd929189b4389c` |

StaffDeck 本地 remote-tracking main 已更新到上述提交；本次没有合并到工作分支。开发启动时记录这对基线为 B0；若采用更新 main，产生新的基线批次并重跑对照，不能在同一报告里使用移动 ref。

每个仓库至少区分三个版本：B0 原始 main、N0 解耦分支原生调用、C 本轮装配候选。在独立 worktree/容器运行 B0，不向其产品源码打补丁；测试驱动可从外部调用原始入口。记录运行环境、依赖锁文件版本、数据库/文件 fixture 和模型响应序列。

已有事实：PilotDeck 工作分支的 AgentLoop、Context、Tool、Model 相比 B0 有大量结构差异；StaffDeck B0 没有当前 `backend/src/staffdeck_harness/sop/` 目录，存在旧 harness 与 SOP 测试。结构不同不自动等于语义不同，但 N0 的 oracle 不能证明 B0 等价。

实施者必须定位 B0 中真实 SOP 校验、图转换、恢复和知识管理入口，并填写 owner 映射。原始入口不可运行或不可定位时标为 BLOCKED；不得把 N0 当作 B0，也不得把 main 中存在、候选缺失的能力自动排除。

## 3. 模块 ownership 清单

以下路径是候选代码中的定位线索，B0 中的对应入口由 M0 实测确认。

| 模块 | 必须保持的行为 | 候选入口/边界 |
| --- | --- | --- |
| AgentLoop | 轮次、模型/工具调度、停止、取消、事件与恢复 | `src/agent/loop/AgentLoop.ts`、AgentLoopRuntimeFactory |
| Skill | 内置/user/project scope、发现顺序、冲突规则、内容渲染、read_skill、CRUD/导入校验 | `src/extension/skills/`、`src/tool/builtin/readSkill.ts`、ExtensionResolver |
| Tool | 工具目录/schema、权限、工作区、批量顺序、结果与副作用、错误 | `src/tool/`、ToolPort、ToolAuthorizationPort |
| Context | prompt/messages/media、预算/缓存、工具结果落盘、overflow recovery | `src/context/ContextRuntime.ts`、DefaultContextRuntime |
| Compaction | 自动/手动触发、有效窗口、protected context、tool pair 完整性、摘要与持久化 | `src/context/compaction/`、SessionContextRuntimeBundle、ManualCompactionController |
| Model Provider | 选择、请求映射、流拼接、usage、限额、错误与既有重试 | `src/model/`、ModelInvokerPort |
| SOP | slots、graph、校验、生命周期、等待/恢复、引用和工具依赖 | StaffDeck 原生 SOP 入口与当前 `staffdeck_harness/sop/` |
| 知识管理 | 库/版本/可见性、导入/编辑/删除、任务/索引、检索/排序/预算、引用快照 | `backend/app/api/knowledge*.py`、`app/knowledge/`、`app/capabilities/local_knowledge.py` |

SOP 中的 StaffDeck Skill 数据结构与 PilotDeck Skill 插槽是两个不同概念，不能互相转换为同一目录。StaffDeck 知识发现生成的建议也不能自动安装成 PilotDeck Skill，除非原始 owner 合同明确定义且有单独适配测试。

知识管理包含写入和查询。StaffDeck 数据库、文档、索引、入库 job 和引用快照仍由 StaffDeck 服务/worker 持有；不得套用 SOP 的无状态模型。独立知识 service 如需数据库/worker/模型依赖，必须显式声明。

## 4. 每个模块的开发操作流程

1. 建立 owner-contract 表：输入、输出、状态、副作用、错误、取消、重试、默认值、依赖、调用位置、并发边界及 B0 证据。先跑原生用例保存 trace。
2. 建立 B0 → N0 对照。相同 fixture、配置、逻辑时间、工具环境和外部响应序列下运行原始入口，定位已有分支漂移。未解决差异进入阻断清单。
3. 依据真实入口定义 schema/Port，完整保留 required/optional/null、顺序、ID 关联和扩展字段。传输约束通过 adapter 解决，不缩减 owner 输入语义。
4. 在 composition 层注入原生实现；每个插槽必须可独立配置 binding。数据、进程、预算依赖都在 plan 中声明，失败时不发布半成品 runtime。
5. 增加通用 transport binding；复用原 owner。常用原生实现可按上述规则保留内置绑定，对应插槽仍须提供外部协议入口。Skill/Tool 的同步目录通过原生初始化快照映射，不能任意变更运行期可见性；远端 Context 需要保留落盘文件/摘要可访问性。
6. 运行 N0 → C 对照，再验证 B0 → C。单测不能只比较两个调用同一 adapter 的路径；oracle 与候选不得共享待验证的映射/归一化逻辑。
7. 运行受影响组合，包括该模块的禁用/恢复、依赖拒绝、服务故障。必要核心插槽不可用必须启动拒绝，不偷偷补默认实现。
8. 导出隔离部署，运行后端 E2E，记录证据后才提交阶段完成。新改动触及共享上下文/调度时扩大到相应跨模块回归。

每个 PR 附上：涉及插槽、owner 路径与核心源码差异、binding/schema 变更、B0/N0/C 标识、比较字段、执行命令和退出码、首次分歧位置、已知阻塞。不能仅以“未改 AgentLoop.ts”证明没有语义漂移，glue 的调用顺序和参数同样可改变行为。

## 5. 知识模块接入细则

- 管理面复用 StaffDeck 原生库、版本、文档、导入 job、编辑和删除入口；查询面复用 KnowledgeRuntime/KnowledgeService。能力范围先在 M0 列清单，已有公开行为不能默默删减。
- PilotDeck Tool 模块执行知识查询桥接工具，桥接仅将请求交给知识 owner。检索结果、hit 顺序、budget、trace、evidence pack 和引用关系原样按契约投影；不在 glue 重新排序或拼造引用。
- tenant/agent/版本 scope 从已绑定的宿主身份映射取得，并交原生可见性校验；不能把模型传来的 ID 当作授权结果。
- LocalKnowledgeRuntime 的 citation resolve 当前要求持久快照，adapter 必须调用原始快照持久化/解析链，不能直接对裸 chunk 生成替代 citation。
- StaffDeck 知识流程如内部调用 LLM，默认继续使用其原生调用与预算语义。验收组合中的 PilotDeck Model Provider 负责 PilotDeck loop；若要复用它承接知识内部 LLM，必须显式定义依赖和 B0 parity，不能顺带替换。
- 知识管理写入超时按原始 job/status 机制查询；结果不明不得自动重试写入。入库取消、部分失败和重启恢复以 B0 结果为准。

## 6. 差异处理与停止条件

只允许声明式归一化随机 ID、时间戳、隔离路径等与语义无关的字段，且保留引用图一致性。禁止丢掉错误、空结果、排序、usage、动作次数、权限或等待状态来获得通过。

如果 B0 与 N0 已不同，先隔离分支漂移：可从固定 B0 复用原实现，或通过边界 adapter 恢复其公开行为；需要修改核心规则才能满足时标记 BLOCKED 并报告，不能私改核心或放宽验收。B0 自身失败也要记录，双方共同失败不是成功证据。

StaffDeck main 中出现 `test_nested_sop_execution.py` 和 `test_sop_nesting.py`，必须核查对应运行行为。若目标要求完整 SOP 等价而候选无该行为，整个等价门不得 PASS；有限 `operator_approval` 场景可单独 PASS。

## 7. 提交与交付

按 [Roadmap](ROADMAP.md) 的阶段提交，保留先前代码和工作树。只把源码、测试、契约和脱敏报告纳入版本管理；运行数据库、文档 fixture 实例和日志放入隔离产物目录。

交付记录注明两个 main 基线、候选提交、未提交改动、模块 manifest、profile、镜像/构建来源、命令/退出码和产物路径。候选冻结后重新导出；打包成功、握手成功、语义等价和业务 E2E 分别报告。不得复用旧固定组合的 READY 作为新组合结论。

## 8. AI 实现最容易发生的偏离

将本 SOP 交给自动实现代理时，默认防范以下方向。它们不是可接受的“工程简化”，发生时必须回退到最近一个可验证阶段并记录原因：

| 偏离方向 | 典型表现 | 判定/处理 |
| --- | --- | --- |
| 重写 owner | 在 glue 中复制 loop、graph、检索、压缩或 provider 算法 | 立即停止该路径；只保留 adapter/Port 映射，核心语义改动记 BLOCKED |
| 假协议接入 | 只返回 manifest、只改 implementationId、只测 JSON 往返或 mock 最终回复 | 不算 conformance；必须执行一次真实领域操作和一次错误路径 |
| 厂商白名单化 | 新实现增加 provider registry、专用 factory、exporter `if/else` 或宿主分支 | 违反协议即接入；删除厂商分支，改为 contract/transport resolver |
| 豁免扩大 | 把常用内置模块豁免扩大成语义、状态、权限或未知实现测试豁免 | 豁免只允许免部署/传输；补回 parity、协议入口和未知实现测试 |
| 范围缩水 | 把 Skill 缩成 `read_skill`、Context 缩成 `prepare`、知识缩成 search，或把 main 已有嵌套 SOP 标为“不适用” | 按 B0 owner 清单补齐；无法补齐就 BLOCKED，不改验收名称 |
| oracle 污染 | 用候选 adapter、转换器或共享归一化逻辑生成 expected，或删除差异字段 | 重新建立独立 B0 driver；比较字段先于候选运行固定 |
| 状态降级 | 把 timeout/unknown 当失败或成功，把旧 revision 当当前 revision，自动重试不明写入 | 保留原错误和不确定性，遵循 owner 的恢复/重试语义 |
| 导出即完成 | Compose/build 成功后直接写 READY，或把握手通过当作业务等价 | 按 `exported`、`built`、`handshake-validated`、`e2e-validated` 分开记状态 |
| 过早泛化 | 先生成七套空接口、动态 hook、插件市场或第二套调度引擎，再寻找真实调用 | 回到 M1a 的 SOP 纵向切片；每个插槽必须有 owner、parity、独立实现三项证据 |
| 偷换基线 | 更新 main、只比较解耦分支，或用旧 SOP-only READY 覆盖本次结论 | 固定 B0/N0/C；基线移动则新建批次并重跑受影响门 |

## 9. 防偏离执行规则

1. SOP 纵向链路是装配机制的样板。当前候选已有该链路时，先核对其最终候选证据并补缺口，不重新搭建；其他插槽继续复用同一模式。七插槽接口定义不是七插槽交付。
2. 每个原模块建立“规则 → owner 函数 → adapter 调用点 → 测试证据”清单；glue 只做边界转换。禁止复制 graph、检索、Skill 发现或压缩算法，也禁止顺手优化提示、默认值、重试、排序与错误行为。
3. 核心 owner 执行逻辑保持不变。若仅需导出类型、导出已有入口或机械接口提取，单独列出源码 diff 和等价证据；不能以“重构”为名移动并重写算法。
4. 契约明确必需行为、可选能力和实现私有部分；未协商能力拒绝。不要把完整内部对象/数据库模型序列化为通用协议，不新增动态代码加载、插件市场、任意 hook 或第二套调度引擎。
5. 原模块对照与未知实现 conformance 分别产出报告。第三方实现允许内部算法不同，只需符合公开契约；原模块仍必须与 B0 等价。
6. 冻结宿主后未知实现测试不得修改或重新构建宿主，不得仅修改原服务 ID；实现由公开协议开发，调用实际领域操作和错误路径。若需要修改宿主，保留失败记录，修复后重新冻结并重跑。
7. 在观察候选结果前确定对照字段和归一化规则。任何新增归一化必须有原始 trace 和非语义差异理由；禁止因测试失败排除字段或改期望。
8. Skill 不缩减为 read_skill，Context 不缩减为 prepare，知识管理不缩减为 search。范围来自 B0 行为清单；不相关宿主功能无需扩展，但模块内缺失能力不能偷偷删掉。
9. 内置豁免按实现列出，仅免部署/传输，不增加语义豁免或取消插槽外部接入。常用模块通过同一 resolver/Port，不能成为绕过装配的永久分支。
10. 发生分歧先记录最早错误输入/输出和 owner 调用，再修 glue；需要改核心语义、换基线或缩范围时报告具体阻塞。继续可独立推进的工作，停止依赖该冲突的推进，不重复无变化测试。
11. 测试 harness 只能修复真实的观察、关联或调度记录缺陷。不得修改 expected、删除事件、串行化原本并发的产品执行、吞掉 `result_unknown`，或在比较器中重排语义事件来制造通过；任何 harness 修复都需保留原产品输入/输出并增加敏感性用例。

每槽完成必须具备三项证据：原 owner 的真实调用、原模块与 B0 的行为对照、冻结宿主后的独立实现配置接入。接口、manifest、mock 往返与单次最终回复均不能单独证明完成。

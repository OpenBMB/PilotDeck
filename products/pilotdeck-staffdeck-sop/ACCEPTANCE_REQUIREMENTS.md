# 七模块可插拔验收需求

状态：READY（G0-G5 当前权威台账全部通过）。本文定义验收门槛和当前权威台账；
历史固定 SOP 证据不能覆盖缺失门槛。基线与开发流程见
[开发 SOP](DEVELOPMENT_SOP.md)，阶段见 [Roadmap](ROADMAP.md)。

## 1. 签收定义

验收对象：PilotDeck AgentLoop + Skill + Tool + Context/Compaction + Model Provider，组合 StaffDeck SOP + 知识管理。满足全部必需门槛才可写 READY。

要求保持各模块相对自身固定 origin/main 的语义与可观测行为。只能在公开的输入域、配置和场景覆盖范围内给出等价证据，测试不能证明所有可能输入的数学等价；最终报告必须同时给出覆盖清单与未覆盖项，不能无边界保证。

核心执行逻辑保持不变与行为对照都是门槛：允许单独审查的类型/入口导出及机械接口提取，不允许改变规则。同样的源码通过不同参数/顺序调用也会产生语义漂移。现有 SOP-only 验收、解耦 owner oracle 和 mock 冒烟不足以签收本组合。

“满足协议即可接入”是必需签收条件：新实现只提供模块端实现/adapter、manifest、配置和部署来源，不要求修改、构建或发布宿主，也不要求登记厂商。协议相容包括已声明的数据与行为约定、依赖和状态模式；全新模块类型仍需先有宿主扩展点。

常用内置模块的豁免只涵盖部署/传输。PilotDeck AgentLoop、Skill、Tool、Context/Compaction、Model Provider 原生实现可免远程部署、网络握手和原生实现 RPC 对照，以静态 descriptor、Port/schema 校验和 main → 原生 Port → 组合 parity 替代。七个插槽的未知实现外部协议接入测试均不可豁免；StaffDeck SOP/知识管理的跨进程对照也不可豁免。报告逐项列出豁免及替代证据，不把豁免检查伪记为执行通过。

七个插槽固定为：`agentLoop`、`skills`、`tools`、`context`、`modelProvider`、`sop`、`knowledge`。`Compaction` 是 `context` 的必验能力（包含自动和手动路径），不是单独的第八个可替换 owner；任何实现不得让两个模块同时决定压缩边界。

## 2. 三层独立对照

以下 parity 专用于现有 PilotDeck/StaffDeck 模块。第三方独立实现运行另一组 contract conformance 用例，验证公开协议的必需行为与所声明的可选能力，不要求其算法或业务输出与 PilotDeck/StaffDeck 相同。两个报告不能互相代替。

| 对照 | 目的 | 判定 |
| --- | --- | --- |
| B0 原始 main → N0 解耦分支原生路径 | 检查预存分支漂移 | 任何行为差异均须解决，不能当作新 baseline |
| N0 原生路径 → C 单模块 binding | 检查接线、传输和字段投影 | 调用参数、结果、状态与副作用一致 |
| B0 原始 main → C 组合中的模块调用 | 防止组合层引入隐藏差异 | 对组合实际输入，用 B0 同 owner 重放核验 |

两个产品 main 没有同一个完整组合入口，因此不要求虚构一个“原生完整混合产品”。组合 harness 保存每个模块实际调用；独立基线驱动在等价原生状态与参数下重放，并比较边界前后状态。模块基线 drivers 可以适配旧 API 名称，但不得调用候选 glue 来构造期望值。

固定模型/摘要/知识内部 LLM 响应序列、逻辑时钟、文件/库 fixture。记录规范化后的模型请求和工具参数；不能只喂预录响应而不检查请求是否已不同。真实模型 E2E 是部署证据，不用于逐字证明两个随机运行等价。

归一化仅允许随机 ID、时间和隔离路径的一一映射；保留引用关系、顺序、错误类型、usage、状态、操作次数和因果关系。流切块边界仅在不影响已声明消费语义时归一化，终态和工具调用关联不得合并掉。

比较字段与归一化表先于候选结果固定。比较器必须有敏感性用例：故意改变工具顺序、错误码、slots、知识 hit 排序、引用关联或压缩边界，确认报告产生 FAIL。原始 trace、期望构造来源和归一化表可检查；共享候选 adapter 构造 expected、删字段后转绿或只比较最终回复均不合格。

## 3. 模块等价矩阵

以下每行均需 B0 与 C 的可执行用例；条件能力先核查 main，只有证明确实不存在才记不适用。候选缺失而 main 存在应 FAIL/BLOCKED。

| ID | 模块 | 必须覆盖的行为与比较字段 |
| --- | --- | --- |
| LOOP-01 | AgentLoop | 单/多轮、串并行工具、停止条件、取消/模型中断、turn limits、继续与重放；比较模型调用序列、工具序列、事件因果、终态、持久消息和副作用次数 |
| SKILL-01 | Skill 发现/消费 | builtin/user/project 同名冲突、可见性、启停、缺失/坏定义、读取、资源路径、内容渲染；比较列表、顺序、原始内容、注入 prompt 和读取错误 |
| SKILL-02 | Skill 管理 | 原生支持的创建、编辑、导入、校验、删除与运行期刷新；比较文件/元数据、只读边界和旧/新会话可见性；知识发现不得隐式安装 Skill |
| TOOL-01 | Tool | schema/目录/别名、权限接受/拒绝、workspace 文件读写、批量顺序、错误/超时/取消、工具结果；比较授权决策、返回值、审计与真实文件/进程副作用 |
| CTX-01 | Context | 系统与会话消息、Skill/SOP/知识贡献顺序、媒体/附件、token 预算、cache、spill/recovery；比较完整 canonical request、引用文件及可读取性 |
| CMP-01 | 自动压缩 | 触发点之前/恰好/之后、路由到更小窗口、protected context、tool call/result 完整性；比较触发次数、摘要请求、保留/删除消息、token 统计和持久边界 |
| CMP-02 | 手动压缩与故障 | 原生手动入口、摘要失败/取消、spill 缺失、压缩提交前后进程终止、重启重放；比较原始错误/恢复策略和下一次模型输入，不允许重复压缩提交 |
| MODEL-01 | Model Provider | 选择与配置、参数映射、内容/工具流、usage、token 限额、错误分类、既有重试/取消；比较 provider 请求及响应规范化、次数和模型可见结果 |
| SOP-01 | SOP | slots 缺失/null/空白/0/false/list/object、merge、默认/显式/非法 graph、终态、非完成转换、工具凭据过期；比较校验/错误、slots、位置/stack、结果 |
| SOP-02 | 等待/恢复 | awaiting-user/handoff/blocked/failed/external-wait、revision、终态回复 journal；比较原始状态与声明的宿主投影、重复/陈旧恢复拒绝与唯一持久回复 |
| SOP-03 | main 能力完整性 | 依据 B0 公共入口和测试盘点子 SOP、嵌套与其他已有能力；若已存在，需同 owner 行为通过，不能用候选不支持声明豁免 |
| KB-01 | 知识管理写入 | 原生库/版本、文档导入、解析/入库 job、编辑重建、删除、取消/失败与重启；比较库/索引内容、job 状态和副作用次数 |
| KB-02 | 知识查询 | scopes、query types、空/有命中、budget/max_chunks、排序、版本可见性；比较请求、hit 顺序/内容/source、selected documents/concepts、evidence pack 与错误 |
| KB-03 | 引用和隔离 | 原生引用持久快照、历史引用解析、文档更新/删除后的引用行为、不同 tenant/agent/版本；比较权限结果、引用关联和内容，不以裸 chunk 替代快照 |
| KB-04 | 管理范围完整性 | 盘点原生知识公开入口（含 OKF、发现建议、版本/发布等实际存在能力），逐项映射/回归；只验证 search 不足以通过“知识管理” |

原生测试定位线索：PilotDeck `tests/extension/skills/`、`tests/context/`、`tests/session/*compaction*`、`tests/model/`、`tests/sop/`；StaffDeck `backend/tests/test_knowledge_base.py`、`test_knowledge_citations.py`、`test_local_knowledge_provider.py`、`test_harness_v2.py`、`test_sop_nesting.py`、`test_nested_sop_execution.py`。这些只是入口清单，不表示本次已执行或版本间路径一定相同。

## 4. 组合 E2E 场景

主场景 E2E-01 为“知识辅助的操作审批”，使用隔离知识库、测试 Skill 和测试文件；不涉及账户 onboarding。

1. 通过原生知识管理后端创建测试库并导入审批规范，轮询到原生 ready 状态，保存版本/job 证据。
2. 启动七模块 profile，通过后端 Gateway 创建会话。PilotDeck 按原生发现规则提供 Skill，模型实际调用 read_skill 并收到内容。
3. 模型通过 PilotDeck Tools 读取测试文件并调用知识桥接工具，StaffDeck 执行检索。记录 scope、命中、引用快照与实际工具结果。
4. Context 生成包含 Skill、SOP 与知识结果的模型输入；逐字段与其原生输入路径比较。SOP 要求的 evidence/citation 依赖通过已有契约传递，不能仅凭文本提及视为满足。
5. 使用足够长的多轮内容触发原始自动 Compaction，并在独立分支运行手动压缩。两侧使用同一原生窗口配置和确定性摘要服务，不能改阈值来掩盖未触发。
6. 压缩后验证下一次请求等价于原生结果，必要工具引用可读取；是否保留某段引用按原生压缩规则判断，不能额外强保留来制造更优语义。
7. StaffDeck SOP 进入 handoff，服务重启后同一 waitId 保留。调用后端 resume，随后经普通 Gateway turn 发送 continuation。
8. 达到 completed，校验唯一持久终态回复、知识引用可按原生规则解析、文件副作用和知识写入次数符合预期。

原有单步骤 `operator_approval` 定义不强行增加语义。若不能覆盖工具/知识要求，使用 owner 已支持 schema 的独立多步骤测试定义并同时供 B0/C 执行。单步骤原 profile 仍单独回归。

补充场景：E2E-02 更新文档并重新检索，验证当前版本和旧引用；E2E-03 知识服务中断/恢复且原始 SOP 状态不被错误推进；E2E-04 双会话与陈旧 resume 隔离；E2E-05 入库写请求响应丢失后用 job/status 判定，不重复写入。

E2E-REAL：从最终候选导出后，使用真实 provider 完成 Skill 读取 → Tool → StaffDeck 知识查询 → SOP handoff → 后端 resume → completed。使用结构化状态、工具结果、引用和副作用断言；不依赖固定文案。Compaction 的严格差分由确定性场景负责，真实模型阶段还需确认一次真实摘要调用可完成。凭据仅运行时注入，产物脱敏。

## 5. 插拔、协议与部署矩阵

| ID | 配置/故障 | 必须满足 |
| --- | --- | --- |
| PLUG-01 | 原生/外部 binding 装配 | 仅改 YAML，记录实际 binding/调用 trace；非豁免 owner 跨协议结果相同，常用内置 owner 提供 Port/schema 与 main parity 替代证据 |
| PLUG-02 | 每个目标插槽的未登记 implementationId | 冻结宿主后新增实现，在同一宿主发布版本仅改配置完成必需操作和错误路径；无新增 factory/白名单/厂商 exporter 分支；错误 contract/version/operation/state mode 拒绝 |
| PLUG-03 | SOP 与知识分别开关，Skill 开关 | 不调用禁用模块；知识-only/SOP-only/plain profiles 正常；required 依赖缺失启动拒绝 |
| PLUG-04 | 核心插槽关闭/缺失、名字冲突、能力不足 | 按原生必需条件明确拒绝；不隐式装默认实现或降级为简化 Context |
| PLUG-05 | 配置重建失败、模块身份/schema 变化 | 旧 runtime 不被半初始化实例替换；旧会话不静默迁移到不兼容实现 |
| RPC-01 | 坏 payload、错 ID/版本、矛盾结果、断连/timeout/cancel | 原始错误可达下一次模型输入；无非法状态/等待/journal 更新；未知副作用保持未知 |
| EVID-01 | 对照驱动与比较器有效性 | 基线独立运行，expected 不来自候选映射；故意注入语义差异可检出；每槽三项完成证据齐全 |
| DEP-01 | build/image/external 导出 | 包不依赖原工作树；依赖/镜像/配置可追溯；外部依赖明确列出，不冒称离线独立 |
| DEP-02 | 共享 StaffDeck SOP/知识进程 | 依赖服务去重，关闭一个能力不使另一能力失效；全部关闭才移除无需的共享资源 |
| REC-01 | 分别重启 PilotDeck、SOP、知识/worker | session、compaction、wait、KB/索引/job、引用按各原 owner 恢复；持续运行中的非完成结果不伪装成功 |
| REC-02 | 重复/并发/丢响应 | 无额外工具或写入副作用；未声明 durable dedup 的服务不被报告为已经验证持久去重 |

用户界面不是本轮门槛。调用真实后端 HTTP/Gateway 与真实模块进程；Mock 只替换外部模型/摘要等非确定性响应，不替换被验收的 loop、Skill、Context、工具、SOP 和知识引擎。

PLUG-02 是单独的协议接入测试，允许独立测试实现替换插槽并覆盖契约操作；这不替代上一段要求真实 owner 的行为等价与七模块 E2E。至少包括一次错误响应和一次实际领域调用，不能仅通过改现有模块 ID 或返回 manifest 证明未知实现兼容。开发者最终交付协议说明、可运行示例与 conformance 命令，新模块作者无需阅读宿主内部实现即可接入。

## 6. 证据与签收表

每条结果必须包含：case ID、两个 B0 commit、N0/C commit、相关未提交改动、profile 和 binding manifest、运行环境、fixture 标识、完整命令、退出码、输入/输出、状态前后、模型/工具 trace、副作用计数、产物路径和首次差异。报告中的命令不能以省略号代替可复现参数；敏感值使用环境变量名。

证据按批次保存原始脱敏 trace 和规范化比较结果，归一化规则随测试版本管理。main 更新后不混用旧证据。产物归档到明确的长期位置，临时目录只作为运行区。

| Gate | 必需结果 | 当前状态 |
| --- | --- | --- |
| G0 原始 main 基线与行为清单 | 所有 owner 可运行，预存差异已定位且闭环 | PASS: the frozen B0 -> N0 -> C inventory and injected-difference checks pass for the declared rows, including `incomplete-turn-resumed-execution` in the independent AgentLoop session replay runner. |
| G1 逐模块等价 | 七个插槽全部适用用例及 EVID-01 PASS；CTX 必须包含 CMP-01/CMP-02 | PASS: declared AgentLoop, Skill, Tool, Model, SOP, Knowledge, Context, and Compaction rows pass. Deterministic Model provider/request/runtime differentials cover selection, mapping, stream, usage, token limits, error, retry, cancellation, and mismatch sensitivity; G5 separately covers the real-provider workflow. |
| G2 拼插与协议 | PLUG/RPC 全部 PASS，未知实现接入有证据 | PASS for the declared protocol/conformance matrix: PLUG-01..05, RPC-01, and unknown-implementation evidence are recorded in `PARALLEL_PROTOCOL_REPORT.md`. |
| G3 完整组合 | E2E-01 至 E2E-05 确定性后端流程 PASS | PASS for E2E-01..E2E-05 and REC-01/REC-02 in the declared native-five composition. The real-owner E2E and focused compaction/process tests cover cancellation, atomic write-race, missing-summary, and service outage/recovery; no remote durable deduplication is claimed beyond the contract. |
| G4 导出恢复 | DEP/REC 全部 PASS，最终候选重新导出 | PASS for the frozen native-five artifact. Durable sanitized evidence is in `conformance/artifacts/g4-native-five-runtime-20260920/`; it records clean artifact startup, Knowledge restart/query recovery, PilotDeck restart with a retained SOP wait, SOP outage/recovery, and durable compaction. |
| G5 真实模型 | E2E-REAL PASS，凭据未进入交付物 | PASS: `conformance/artifacts/g5-native-five-continuous-20260920/` contains one final-artifact real-provider session with `read_skill`, `read_file`, `knowledge_query` evidence/citations, SOP handoff/resume/completed state, and durable compaction; credentials and provider URLs are absent. |

FAIL 表示可执行比较发现语义/行为差异；BLOCKED 表示原生入口、环境、凭据或依赖使该门无法完成；NOT RUN 表示尚未执行。只有全部必需门 PASS 才可签收七模块组合。范围内未实现行为不能通过标“不适用”绕过；若需要缩小用户要求，必须另行明确批准并改变最终结论的名称和范围。

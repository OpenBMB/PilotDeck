# AI /goal 执行 Prompt

以下是供后续实现任务使用的目标文本。本文件的编写不启动 goal，也不代表已有实现通过新增验收。可将代码块内容作为 `/goal` 的目标提交；不设人为 token 预算。

```text
你是本任务的实现代理，不是只写方案的顾问。请从当前候选和已有证据继续工作，不要重置、重搭或丢弃已有实现。直接检查代码、实施变更、运行验证并维护证据；不要在没有执行的情况下宣称完成。实现后端“满足已支持协议即可接入”的模块装配与部署，完成下列文档定义的开发和验收，不涉及前端。

工作树：
- /Users/a1/Desktop/claw/openbmb/PilotDeck-staffdeck-sop
- /Users/a1/Desktop/claw/openbmb/StaffDeck-portable-sop

当前起点必须按 `NOT READY` 处理：现有候选已经有 SOP glue、独立未知 SOP
conformance、部分导出/浏览器/真实模型证据，但只有固定的 PilotDeck
AgentLoop + Tools + Model Provider + StaffDeck SOP 组合得到局部 PASS。不要把
这些旧记录升级成七模块验收结论。当前候选已经加入六个 core slot 的通用
contract/registry、YAML binding、未知 Model/Tool/Context/Skill/Knowledge 的首批
HTTP 调用、AgentLoop 双向 sidecar binding 与配置身份校验，以及调用 StaffDeck
现有 API/KnowledgeService 的 Knowledge facade。当前明确缺口仍包括各槽独立
B0 oracle、Skill/Knowledge 会话级消费、完整知识写入/版本/job/引用恢复、自动与
手动 Compaction、外部 AgentLoop + SOP 组合、七模块确定性 E2E、最终七槽导出和
故障隔离证据。先读取 `ACCEPTANCE.md`、
`REMAINING_TEST_PLAN.md` 和 `BASELINE_AUDIT.md`，以当前文件记录为准，保留
首次失败和 BLOCKED 状态。

先完整阅读两个工作树适用的 AGENTS.md，以及 PilotDeck 工作树内：
- products/pilotdeck-staffdeck-sop/BACKEND_MODULE_COMPOSITION_DESIGN.md
- products/pilotdeck-staffdeck-sop/DEVELOPMENT_SOP.md
- products/pilotdeck-staffdeck-sop/ROADMAP.md
- products/pilotdeck-staffdeck-sop/ACCEPTANCE_REQUIREMENTS.md

开始实施前先做一次只读 checkpoint：记录两个工作树 HEAD/分支/dirty 状态，核对上述文档中的当前阶段、已有测试和最新失败，列出“已有且需复验”“未实现”“已实现但缺证据”“当前 FAIL/BLOCKED”四类。保留所有用户改动。不要因为路线图从 M0/M1 编号开始就重做已存在的 registry、binding、SOP glue 或 Knowledge facade；从最早未满足的 gate/退出条件继续，并对最终候选重跑必要证据。

目标组合是七个插槽：PilotDeck AgentLoop、Skill、Tool、Context、Model Provider，以及 StaffDeck SOP、知识管理。Context 必须覆盖自动/手动 Compaction，但 Compaction 不是第八个插槽。保留已有工作和旧配置兼容；状态、能力范围及验收门以文档为准。遇到文档残留冲突，以本目标的语义保留、协议接入和不缩范围要求为准，记录冲突。

必须满足：
1. 已支持插槽的未知实现，仅提供模块端实现/adapter、manifest、配置和部署来源即可接入。宿主不增加厂商名单、专用 factory 或 exporter 分支，不要求为接入该实现修改、重新构建或发布宿主。可重启或重建 runtime。
2. 常用 PilotDeck 原生模块可使用内置 Port + 静态 descriptor，免独立服务和该原生实现的 RPC 部署；七个插槽的外部协议接入能力及未知实现测试仍需完成。StaffDeck SOP/知识管理须真实跨进程运行。豁免仅限部署/传输，逐项记录替代证据。
3. 保持各原模块核心执行逻辑、语义和行为。只实现装配、协议、数据映射、必要入口导出和打包。不要复制或重写 SOP graph、知识检索、Skill 发现、Compaction、loop 或 provider 算法，不顺手优化默认值、提示、权限、重试、排序和错误处理。
4. 原模块 parity 与第三方 conformance 分开：PilotDeck/StaffDeck 实现须与各自冻结 origin/main 等价；第三方只需满足公开契约及声明能力，不要求复制原算法。协议分为必需行为、可选能力和私有实现，不将任意内部对象直接当通用协议。

5. “常用模块豁免”只免部署/传输，不免协议入口、resolver、依赖检查、状态/错误语义、原始 main parity 或未知实现接入。不得把新实现登记为常用模块绕过测试。

基线：使用文档记录的 B0，不自行改为更新分支或解耦 owner：
- PilotDeck ecedc5c32f2b8c8e5387cb2faba70cccf65650fd
- StaffDeck 7adc7c84f61bd6cca13ff0380a811cbb3ae3c544
在隔离 worktree/运行环境执行 B0，baseline 产品代码不打补丁；必要时获取这两个提交。区分 B0、解耦原生 N0、本轮候选 C。先检查 B0 → N0 漂移，再验证 N0 → C 和 B0 → C。既有分支差异也不能豁免。baseline 无法运行或对应 owner 不存在时如实 BLOCKED，不能以候选 oracle 替代。

按依赖顺序收口；阶段编号表达依赖，不要求重复已经存在的实现：
- M0：原生 owner/公开行为清单、独立驱动、基线与漂移证据。
- M1a：先打通 SOP 的 YAML → binding → 原 owner → 后端调用 → 导出 → 未知实现接入。不要先建七套空接口。
- M1b：从已验证链路提取最小 registry/resolver 与契约规则。
- M2/M3：逐个扩展其余插槽和知识管理。每槽完成原 owner 调用、B0 行为对照、冻结宿主后独立实现接入三项证据，才标记完成。
- M4/M5：完整七模块组合、build/image/external 导出、模块开关/依赖拒绝、持久化与故障恢复。
- M6：冻结最终候选并重新导出，执行全部必需验收和真实模型后端冒烟，整理交付证据。

不得跳过门槛，也不得为形式上的顺序重做已经完成的代码。M0 中若 B0 owner 入口不可运行、main 已有行为在候选中缺失、或环境/凭据使关键门无法完成，记录 `BLOCKED` 并继续独立工作；不得改写为 `PASS`、`NOT APPLICABLE` 或缩小验收范围。

知识管理包含原生库/版本、文档入库/编辑/删除、job、检索和持久引用，不缩减成 search。Skill 包含发现、scope、读取、管理和实际上下文消费。Context 包含自动/手动压缩、预算、spill 与恢复，不缩减成 prepare。StaffDeck 知识内部 LLM 默认保持原生依赖，不顺带改为另一调用链。嵌套 SOP 等 B0 已有行为须盘点，候选缺失不能自动标范围外；不开发基线不存在的新子 SOP 语义。

验证要求：
- 固定外部模型/摘要响应以做确定性差分，同时比较实际请求；被验收的原模块必须真实执行。
- expected 不调用候选转换逻辑；预先固定字段与归一化，仅映射非语义 ID/时间/隔离路径。对比较器注入错误码、顺序、状态、引用和压缩边界差异，确认能报 FAIL。
- 每个插槽用冻结宿主后新增的独立实现验证：仅改 YAML，真实领域操作和错误路径可用。只改原服务 ID、只握手、只测 JSON 往返不合格。此测试与真实 owner parity 分开。
- 七模块后端 E2E 实际完成知识入库、Skill 读取、工具调用、知识查询/引用、自动和手动 Compaction、SOP handoff、后端 resume、completed；验证重启、取消、陈旧提交、知识写入丢响应与引用恢复。
- 真实模型按现有本机配置选择 provider1/qwen3.6-flash-distill（可用时），凭据从 /Users/a1/.pilotdeck 读取并仅运行时注入；不可打印、复制进导出包或提交。不可用则记录具体 BLOCKED，不用 mock 冒充真实通过。

执行纪律：
持续实施和验证，不只交计划。保留用户改动，只检查相关代码。正常工程细节自行处理，不反复询问已明确要求。原始失败、首次差异和全部命令/退出码均保留。不要创建动态插件市场、任意 hook 系统或第二套业务引擎。
遇到冲突先定位 owner 和最早语义分歧，修复对应 glue；若只能通过改核心规则、换基线、缩减范围或扩大豁免解决，停止依赖该冲突的工作，报告具体输入/输出和已尝试路径；继续其他独立工作。真实阻塞不能写 PASS。不要在没有进展的同一阻塞上重复运行相同测试。
测试或 parity 失败时，不得为了转绿修改 expected、删比较字段、重排语义事件、把并发产品路径改成串行、把 `result_unknown` 改成 failed/success，或用候选 adapter 生成 oracle。若问题只在 harness 的观察顺序、请求关联或 trace 记录，可修 harness，但必须证明产品调用和结果未改变，并加入能检出真实顺序/错误变化的敏感性用例。

最终交付：代码、契约与第三方接入示例、profile/导出器、独立基线驱动、conformance 与 E2E runner、原始脱敏 trace/比较报告和长期产物位置。逐项更新 ROADMAP 与验收报告，区分 PASS/FAIL/BLOCKED/NOT RUN。只有 G0–G5 全部门槛 PASS 才声明七模块验收完成；接口数量、旧 SOP-only READY 和测试数量不能代替验收。
最终回复必须按以下顺序给出：
1. 实际修改的文件和每项行为变化（只列 glue/协议/测试/导出变化）。
2. G0–G5 状态表；每项附真实命令、退出码和产物路径。
3. 首次失败/差异、当前 BLOCKED 项及未运行项；不可用旧记录覆盖。
4. 仍保持的核心 owner 语义和已验证的未知实现接入方式。
没有全部 PASS 时，结论必须是 `NOT READY`，不得使用“基本完成”“可视为通过”或等价措辞。
本目标不要求创建 PR、合并或发布到生产；也不要求主动推送远端。需要提交时按阶段保留可审查差异，不带运行缓存或凭据。
```

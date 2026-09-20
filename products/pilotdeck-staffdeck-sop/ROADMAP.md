# 七模块可插拔 Roadmap

状态：M0 owner 审计已取得部分证据；M1a SOP 纵向切片已有历史部署证据；M1b 与 M2 已实现六个 core slot 的协议 registry、YAML binding 和首批未知实现调用；M3 已增加 StaffDeck Knowledge owner facade。各阶段仍缺完整 B0 parity、会话级消费、七槽 E2E 和最终导出，因此总体仍为 `NOT READY`。详细命令见 [M0 基线审计](BASELINE_AUDIT.md)。目标与约束见 [开发 SOP](DEVELOPMENT_SOP.md)。

交付组合为七个插槽：PilotDeck `AgentLoop`、`Skill`、`Tool`、`Context`、`Model Provider`，以及 StaffDeck `SOP`、`知识管理`。Compaction 属于 Context 的必验能力，不单列为第八个插槽。阶段以门槛完成，不按尚未评估的工期承诺日期。

## 1. 阶段与依赖

| 阶段 | 前置 | 工作与交付物 | 退出门槛 |
| --- | --- | --- | --- |
| M0 基线与能力审计 | 无 | 固定两份 origin/main；B0/N0 owner 映射、原生 trace、行为/公开入口清单、分支漂移清单 | 每个模块原生路径可跑；缺能力和漂移可定位；未解决行为差异阻止最终等价签收；B0 入口不可运行时明确 BLOCKED |
| M1a SOP 端到端接入 | M0 的 SOP 原生映射与可执行证据 | 最小 SOP 契约/resolver、原 owner binding、未知实现接入、独立导出与真实后端调用 | SOP 原生对照、冻结宿主后未知实现接入、部署业务调用均通过；不能仅交接口和握手 |
| M1b 装配基础与插槽清单 | M1a | 从已运行链路提取 registry/resolver；七插槽边界和依赖草案、豁免清单、旧 YAML 兼容 | 复用已验证机制；未实现插槽明确拒绝，不建空实现宣称支持 |
| M2 PilotDeck 原生模块绑定 | M1b、相关 M0 映射 | 逐个完成 Tool、Model、Skill、Context/Compaction、AgentLoop binding 及外部接入 | 每槽均有原 owner 对照、独立协议实现和组合调用证据；压缩实际触发并落盘恢复 |
| M3 StaffDeck SOP 与知识绑定 | M1b、M0 原生 owner 可运行 | 延续 SOP 接入、知识查询与管理桥接、StaffDeck DB/worker 依赖、持久引用与身份映射 | SOP/知识分别 B0 → C 等价；管理全生命周期、检索和引用可用；没有替代算法 |
| M4 跨模块组合 | M2、M3 | 完整 profile、知识工具接线、SOP 依赖/引用映射、compaction 后继续执行 | 全链路 deterministic E2E；每个插槽的绑定替换/开关矩阵；无未声明回退 |
| M5 独立导出与故障恢复 | M4 | build/image/external 导出、共享服务去重、数据卷/worker 拓扑、模块故障诊断 | 隔离环境运行；单模块断连/恢复；知识写入不重复；会话/引用/压缩边界持久化一致 |
| M6 候选冻结与签收 | M5 | 固定源码候选重导出、真实模型后端冒烟、完整差分报告、验收记录 | [验收要求](ACCEPTANCE_REQUIREMENTS.md) 所有必需门 PASS；无语义 FAIL/必需项 BLOCKED |

当前阶段记录：M0 的 PilotDeck/StaffDeck owner focused tests 已通过，但 B0 → C 完整差分尚未完成；M1a 已有未知 SOP 实现的真实跨进程 conformance 和 generic `external` export。六个 core slot 已有公开 contract、通用 HTTP 或双向 sidecar binding、manifest 校验和 YAML 解析；未知 Model/Tool/Context/Skill/Knowledge 的首批协议调用通过，外部 Skill 同时覆盖运行期读取和 Gateway 管理 Port，AgentLoop 配置身份在 hello 阶段校验，SOP glue 能装饰外部 runner。当前已有一个 YAML 选择 TCP 外部 AgentLoop、外部五个 core owner 与 SOP submit 的 Gateway E2E，并已覆盖一次外部自动/手动 Compaction、替换后继续执行、持久 handoff、sidecar 重启后的 resume 去重和再次调用；StaffDeck Knowledge 已有调用现有 API/Service 的 Module Protocol facade，但完整管理 lifecycle、独立 StaffDeck/worker restart、owner parity 和最终七槽导出运行仍未完成。

M1a 是装配机制的历史纵向样板，当前已有链路和历史证据，不要求接手者重做；其未满足的最终候选证据仍须补齐。不得再实现七套未经实际调用验证的空协议。M2 按插槽分别收口，其内部依赖决定具体顺序；Context 阶段必须同时覆盖自动和手动 Compaction。每槽先确认原生能力，再验证未知实现。M2 与 M3 的独立工作可并行推进，但知识查询和 SOP 结果依赖仍需在 M4 一起验证。M0 的未解决差异阻断受影响阶段签收，不阻止其他已明确边界的独立工作；不得把 BLOCKED 改写为 NOT APPLICABLE。

## 2. 每阶段变更边界

- M0 只增加外部测试驱动与报告，不修改 baseline 产品代码。
- M1a/M1b 使用已有配置解析和 Module Protocol v2，先跑通 SOP，再提取实际需要的装配机制，不另建调度引擎。
- M2 在 runtime factory、capability bundle、Skill/Context 接入处加注入，不改 owner 的规则、阈值或错误策略。
- M3 调用 StaffDeck 的原生管理、SOP、检索和引用入口；SOP 可无状态，知识服务必须保留自己的持久依赖。
- M4 增加参数/结果/身份映射。SOP 指令、Skill 内容和知识结果进入 Context 的位置必须有契约记录，并验证最终模型输入。
- M5 导出器根据模块来源和依赖生成拓扑，不按厂商名称写特殊分支；共享 StaffDeck 服务按服务实例去重，保留各模块能力开关。
- M6 只修复已定位的 glue/协议/打包缺陷；任何修改后重跑受影响 parity 和组合场景。

## 3. 配置产物

M1b 已实现以下 profile 结构的 core slot 解析；SOP 使用现有独立配置。该片段仍是组合目标示意，不代表 exporter 和七槽运行证据已经完成：

```yaml
modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  skills: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  context: { enabled: true, provider: pilotdeck }
  modelProvider: { enabled: true, provider: pilotdeck }
  sop:
    enabled: true
    provider: staffdeck
    # endpoint、definition 与 deployment 由对应契约配置补全
  knowledge:
    enabled: true
    provider: staffdeck
    # 原生库/版本 scope、身份映射、DB/worker 与服务地址显式绑定
```

完整 profile 启用所有目标能力；Compaction 默认使用 Context 内原始实现与原生配置，不额外调整阈值。另交付 plain-PilotDeck、SOP-only、knowledge-only，以及依赖故意缺失的拒绝 profile。

核心 loop/model/tools/context 在完整运行时是必需插槽，关闭必须返回明确配置错误。Skill/SOP/知识可关闭，但先检验所选 Skill/SOP 的依赖；不能静默跳过 required knowledge 或工具要求。上下文的可选关闭模式仅在 main 本身存在且已验证时提供，不为支持开关新造 Null 语义。

## 4. 可插拔能力的交付定义

每个插槽必须提供标准协议入口，并支持只改 YAML 切换实现，不修改或重建宿主。非豁免实现验证原生调用与协议 binding 调用同一 owner 的一致性。常用 PilotDeck AgentLoop、Skill、Tool、Context/Compaction、Model Provider 可使用内置 Port + 静态 descriptor，免把原生实现另行 RPC 部署；以 B0 → 原生 Port → 组合调用对照作为替代证据。该豁免不取消对应插槽的协议入口及未知实现接入测试。

七个目标插槽分别使用宿主冻结后才创建的未知 implementationId 进行协议接入测试。实现代码、manifest 与服务放在宿主之外，测试只改配置，不向 registry 增加厂商条目；宿主镜像保持同一版本。测试实现必须覆盖相应契约必需操作，不只返回健康检查。它们证明协议接入，不承担原模块等价证明；内置原模块仍须单独证明与 origin/main 一致。Compaction 的独立实现若作为 Context 的能力扩展验证，必须沿用 Context binding，不得创建第二个压缩 owner。

AgentLoop 协议 binding 若当前不能与 SOP wrapper 组合，必须补齐已有扩展边界的 glue 并通过组合测试。若需要改 loop 核心语义则记 BLOCKED；不以取消该组合检查代替完成 M4。

## 5. 回退与最终交付

各阶段保留上一可运行 profile；初始化失败不覆盖活动 runtime。回退采用已记录源码/镜像/profile，不将新知识数据库直接回滚为不兼容 schema。任何 schema 迁移由原 StaffDeck owner 提供；缺失迁移或恢复方案时拒绝复用数据。

最终交付包括七插槽契约、开发者接入示例、profile/导出器、原生对照 harness、后端 E2E runner、基线和候选清单、脱敏 trace/状态/副作用报告。所有新文档和测试状态使用 PASS/FAIL/BLOCKED/NOT RUN，保留首次差异，不用旧 READY 覆盖。

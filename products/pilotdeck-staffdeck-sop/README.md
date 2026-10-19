# PilotDeck + SOP v4 + 独立 KM

了解功能与使用场景，先阅读 [SOP 功能介绍](SOP_FEATURES.zh-CN.md) 和 [KM 功能介绍](KM_FEATURES.zh-CN.md)。两份介绍面向使用者，不需要先理解部署配置或接口协议。

部署从 [部署文档](DEPLOYMENT.zh-CN.md) 开始，覆盖无 StaffDeck 的源码组合部署、Compose、外部服务、验证、备份及回退。

- [SOP 后端协议与接口](SOP_V4_BACKEND.zh-CN.md)：批量执行、foreach、输入映射、模型、审批和恢复。
- [同机托管 YAML](profiles/independent-v4-local.yaml)：源码 SOP/KM 组合。
- [外部服务 YAML](profiles/independent-v4-external.yaml)：外部连接或改为 Compose build 模式。
- [解耦验收记录](SOP_V4_DECOUPLED_ACCEPTANCE.zh-CN.md) 与 [源码插拔验收记录](SOP_V4_SOURCE_ACCEPTANCE.zh-CN.md)：历史实测及边界，不能代替目标环境验收。

PilotDeck 管理 AgentLoop、模型、工具、权限与工作空间；SOP Runtime 和 Knowledge Core 为独立进程、独立数据边界。SOP 使用 `sop.lifecycle/v4`，KM 使用 `knowledge-core/v1`。本入口仅介绍当前版本，不迁移历史定义、数据或进行中的执行。

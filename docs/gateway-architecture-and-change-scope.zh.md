# Gateway 架构与变更范围评估

日期：2026-11-02。这里区分 Agent 运行时、对外服务接口和独立服务进程，避免仅按名字判断架构。

## PilotDeck 当前职责

`Gateway` 接口提供会话、提交任务、事件、权限交互及项目操作。它既有进程内实现，也有 WebSocket 远程客户端；共享这一接口不意味着必须启动额外的服务进程。普通 CLI/TUI 的代码中已有创建本地 Gateway 的路径。

桌面默认运行 Web 服务与 Gateway 服务两个后端进程。Web bridge 通过本地 WebSocket 连接 Gateway；Gateway 承载 Agent 执行、路由、MCP、会话及定时任务，并连接启用的 IM 适配器。这样能让多个入口使用同一个活跃运行时，减少状态与任务所有权分裂；代价是多一个进程、连接认证、启动协调及独立的失败点。

截图中的进程退出错误只能说明 Gateway 服务进程终止。134 在已经验证的 Windows Node 环境中既可以来自主动 abort，也可以来自内存不足，因此不能据此决定删除整个运行时或唯一归因。

## 官方实现对照

| 产品 | 实现 | 对 PilotDeck 的启示 |
| --- | --- | --- |
| Hermes Agent | 官方架构把 CLI、Gateway、ACP、API 等列为不同入口。CLI 路径直接进入 AIAgent；Gateway 路径负责消息适配、授权、会话解析和回复。 | 有 Gateway，但它不是所有运行方式的强制中转。不能把 Hermes 的消息网关与 PilotDeck 的完整 Agent 后端当作同一职责。 |
| DeepSeek Harness | CLI 按 profile 只加载所选 runner。Desktop 启动一个 Electron Node 模式的 Host 子进程，同时立即加载打包的 Web 界面，通过 IPC 传递启动与就绪信息；Host 同时承载应用与插件。 | 有后端 Host；桌面启动说明没有采用 PilotDeck 这种 Web 服务再连接单独 Gateway 的两后端布局。不能因此说 DSH 没有服务层。 |

来源：[Hermes 官方架构](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)、[DSH CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)、[DSH Desktop](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)。这些说明支持职责和启动结构的比较，不构成竞品同机性能测量。

## 建议

本轮保留 Gateway，先修复可诊断性和已经测出的启动开销。直接删除会同时影响 Web bridge、IM、定时任务、会话订阅及权限回传，超出一次启动修复的合理范围。

后续可单独评估：桌面默认使用一个后端 Host，把 Web API 与 Agent 运行时组合在同一进程，保留 `Gateway` 接口作为边界；远程连接、多入口共享常驻实例及 IM 场景仍可选用服务模式。CLI 保留直接调用本地运行时的能力。该方向需要验证任务恢复、调度器唯一实例、会话并发和崩溃隔离，本轮不直接实施。

配置迁移与进程合并是两个独立变更，不应绑在一起。当前 YAML 迁移已回退；原有格式保持兼容，后续新功能继续使用既有配置读写入口。

# 通用 SDK 应用开发起点

本工作副本承接已通过本地验收的 SDK/Gateway/Runtime 增量，分支为 `codex/sdk-application-base`。继承增量与本次通用化修改尚未提交；当前分支引用本身仍指向原基线，单独 checkout 分支名不会带走这些修改。继续开发应使用本 worktree；交付为可克隆的分支前需要将审阅后的增量提交。

## 保留能力

附件上传、调用方 runId、可信上下文、Gateway 持久化 RunRegistry、运行观察/重连/结果、权限查询与响应、原生归档、memory/snapshot 管理，以及 skills/Cron/Always-on/manager 的宿主接口。

Runtime 保留 FailureGuard、异常快照、断流恢复、provider 审计和发送前持久化屏障。精确生命周期与安全阻断由 Runtime 本地执行。浏览器管理依赖宿主 provider，并非自带已验证的浏览器实现。

## 通用化变更

- 工具显示名称从 `runPolicy.failureGuard.toolLabels` 读取，未配置时使用工具标识，不再内置业务数据源名称。
- Gateway 能力测试改名为 `tests/gateway/capabilities.spec.ts`，配置和测试使用通用研究工具示例。
- 审计模块使用 `src/storage/invocationStorage.ts`，类型为 `InvocationStorageConfig`，解析函数为 `resolveInvocationStorageConfig`。
- 审计和快照读取 `PILOTDECK_STORAGE_ROOT`，快照目录可用 `PILOTDECK_SNAPSHOT_ROOT` 覆盖；未设置存储根目录时，环境配置的审计/快照保持关闭。
- 原 `PILOTDECK_LEGAL_*` 配置在此新起点改为对应的 `PILOTDECK_*` 名称，没有旧名称兼容层。`DATABASE_URL/SCHEMA/TABLE`、`OBJECT_PREFIX`、`STORAGE_CONFIG_VERSION` 字段也遵循此命名；字段存在不表示内置了远程数据库后端，当前审计实现为文件存储。

示例项目策略：

```yaml
runPolicy:
  failureGuard:
    enabled: true
    modelFailureLimit: 3
    toolFailureLimits:
      mcp__research__: 3
    toolLabels:
      mcp__research__: Research service
```

应用自行负责 HTTP/SSE、鉴权、业务幂等、材料转换、交付规则和数据源 MCP 配置。不要把 SDK sessionStore 当作运行权威状态；持久化运行控制须接入 Gateway RunRegistry。宿主接口不存在时，应用应处理 capability unavailable。

## 验证和边界

通用化后的构建成功，Gateway 能力、FailureGuard、策略配置、快照、调用审计 focused compiled tests 为 43/43。此前第一轮相关验证为 32/32，不与 43/43 累加。没有为此次命名/配置调整重跑全量回归，也没有执行生产级评测。

新 worktree 初始缺少依赖，且主机 NODE_OPTIONS 指向不存在的 preload。验证清除了 NODE_OPTIONS，并临时借用原 worktree 的 node_modules；临时链接已移除。使用前在本目录安装项目依赖，使用 Node 22.23.1 或项目支持的版本；不要依赖原 worktree 的绝对路径。

原试验 worktree 与独立业务后端保持原样。此起点没有复制业务后端或宣称覆盖所有外部服务、生产部署和真实浏览器 provider 验收。

# Migration 与 Changelog

每个 SDK 版本应记录新增 public export、option、message、error、Gateway capability、deprecated API 和行为变化。协议变更说明最小 Gateway 版本、旧客户端行为和回滚方式；Native 语义变更单独发布，不隐藏在 SDK changelog 中。

升级顺序：先确认 Gateway capability，部署兼容 Gateway，再升级 SDK consumer，重启 SDK-hosted MCP/hook server，创建新 query/runtime 并验证工具事件和 final result。

## 版本记录模板

每次发布至少填写：

```text
SDK: @pilotdeck/sdk x.y.z
Gateway/protocol: <version>
Capabilities: <hello response>
Added/changed: <public symbols and semantics>
Deprecated/removed: <migration action>
Rollback: <last known compatible pair>
```

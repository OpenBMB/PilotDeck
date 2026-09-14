# Compatibility Matrix

| 组合 | 规则 |
| --- | --- |
| 新 SDK + 支持 capability 的 Gateway | 按对应 Guide 使用 |
| 新 SDK + 旧 Gateway | 新能力返回 `unsupported_capability`，基础 query 保持可用 |
| SDK-only patch | 只影响升级该 SDK 的应用 |
| Gateway protocol change | 先部署兼容 Gateway，再升级 SDK |
| Native runtime semantic change | 独立评审并重新运行 parity |

发布时记录 SDK 版本、Gateway 版本、protocol version 和 capabilities。具体能力状态见[实现 Roadmap](../../pilotdeck-sdk-implementation-roadmap.zh.md)。

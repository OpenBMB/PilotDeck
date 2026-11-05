# PilotDeck TRD 索引

状态：评审中　维护者：PilotDeck 工程团队

本目录记录后台任务、设置接口及模型协议的技术契约。通用配置读写和凭证运行时规则分别由 `GET/PUT /api/config` 及配置运行时实现负责。

| 编号 | 文档 | 主要边界 |
|---:|---|---|
| 41 | [Background Task](41-background-task.zh.md) | 后台任务生命周期、恢复与验收 |
| 52 | [Model Pool Settings API](52-model-pool-settings-api.zh.md)；[接口文档](../model-pool-settings-api.md) | provider/model 配置、批量连接测试和图片能力补录 |
| 53 | [Router Settings API](53-router-settings-api.zh.md) | 路由开关、任务层级、子智能体策略和模型定价 |
| 54 | [Agent Search Settings API](54-search-settings-api.zh.md) | 五类搜索 provider、配置和服务探测 |
| — | [Anthropic Prompt Cache](anthropic-prompt-cache.zh.md) | Anthropic 请求缓存标记与兼容边界 |

第三节“智能体常驻”不在本次设置接口 TRD 范围内。

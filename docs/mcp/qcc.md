# 企查查 MCP OAuth 预设

依赖通用远程 MCP OAuth 功能。设置 → 扩展 → 全局 MCP 中点击
**添加企查查 OAuth 预设（5 个 Server）**，再选择任一预设，点击准备授权、
在系统浏览器中打开授权。客户端名称为 **PilotDeck**，无需复制 API Key。

一次授权覆盖下面五个明确资源。查询能力仍以当前企查查账户权限为准。

| Server | Resource |
|---|---|
| qcc-company | https://agent.qcc.com/mcp/company/stream |
| qcc-risk | https://agent.qcc.com/mcp/risk/stream |
| qcc-ipr | https://agent.qcc.com/mcp/ipr/stream |
| qcc-operation | https://agent.qcc.com/mcp/operation/stream |
| qcc-executive | https://agent.qcc.com/mcp/executive/stream |

安装前分别检查五个资源的 Protected Resource Metadata，canonical resource
必须精确匹配，授权服务器必须为 `https://agent.qcc.com`。授权入口使用 company，
五个配置引用同一私有凭证记录；不是根据域名自动共享令牌，也不包含未列出的第六个服务。
已有同名 Server 时不覆盖，用户应先确认原配置用途。

刷新和重启恢复复用通用 OAuth 管理器。解绑任一预设会清除整个 grant 的令牌并尝试
撤销 refresh token；其他四个预设随即失去授权。保留五个配置与共同引用，重新授权
仍覆盖五个资源。删除单个配置不等同于解绑。若跨项目手工复制引用，解绑同样会使其失效。

这是内置 MCP **预设入口**，并非已经上架外部连接器市场。默认本机浏览器 / 桌面部署，
远程 Web 回调、分布式部署、凭证存储等边界见 [通用 OAuth 说明](oauth.md)。

自动测试验证五类资源的模拟工具调用、一次刷新被五路并发复用、管理器重启后恢复、
整组解绑以及不向列表外 URL 发送凭证。真实企查查短信授权和五个真实工具调用仍需
人工验收；模拟测试不代表已使用客户账号完成实测。

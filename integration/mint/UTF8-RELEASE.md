# UTF-8 包侧修复交付

Host移除全局UTF-8，保留hook超时。Mint分支codex/package-local-utf8-host，提交a4589ea9；另以bb8d4bd9修正provider来源日志。
源码分支均为codex/package-local-utf8，已推送华为云原仓库；未合并master。

| 包 | 版本 | 源码提交 | 发布 |
|---|---|---|---|
| pilotdeck/context-instructions | 0.1.5 → 0.1.6 | `5da16b46` | [MintHub](https://mint-hub.ea.modelbest.co/p/pilotdeck/context-instructions) |
| pilotdeck/context-retention | 0.2.3 → 0.2.5 | `c4725d20` | [MintHub](https://mint-hub.ea.modelbest.co/p/pilotdeck/context-retention) |
| pilotdeck/context-tool-result-pruner | 0.1.7 → 0.1.8 | `828dc2cb` | [MintHub](https://mint-hub.ea.modelbest.co/p/pilotdeck/context-tool-result-pruner) |
| pilotdeck/context-budget-production | 0.3.4 → 0.3.6 | `d533457d` | [MintHub](https://mint-hub.ea.modelbest.co/p/pilotdeck/context-budget-production) |
| pilotdeck/model-provider-openai-consumer | 0.1.2 → 0.1.3 | `3c2f04da` | [MintHub](https://mint-hub.ea.modelbest.co/p/pilotdeck/model-provider-openai-consumer) |

五包均正式发布且索引可见；新实例utf8-registry-project由MintHub安装，12包无本地覆盖。
原安装项目保留。编解码器为各包模块局部绑定，不注入全局。
FS Read已有自身实现，本次没有修改或重新发布。

验证：5包源码测试、UTF8中文/emoji/BOM/非法序列与1000组对照、provider3项流式测试、独立无全局VM与真实Host加载、Host全局缺失与长hook测试通过。
真实Rust loop：文件读取、Retention/Pruner3轮、Budget拒绝、Basic压缩及跨进程追问、中文emoji实时流通过。
Port压缩、bridge一次性审批写入中文emoji文件并读取、附件中文与emoji消费通过。网页服务已切换；本轮浏览器工具连接不可用，未重复浏览器点击验证。

日志：同目录各checks.log、e2e-*.log、publish-*.log；Kernel详细日志在运行目录utf8-unified/data/supervisor/installed-rust-loop.log。
provider版本字段在旧Core日志中硬编码0.1.2，此处包真实版本以新项目mint.lock、激活清单与MintHub下载记录为准。
Provider原v0.1.3标签被其他提交占用，未覆盖；本次使用model-provider-openai-consumer-v0.1.3-utf8标签。

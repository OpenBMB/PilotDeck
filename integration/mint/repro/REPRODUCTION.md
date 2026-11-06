# 独立复现报告

日期：2026-11-06。结论：**源码可获取、构建成功、13 包安装成功；固定新版包组合不能启动 ACP，端到端验收未通过。**

## 已实际验证

- 通过远端 Git 新克隆 Host 提交 `0598599ef99671c1f03e7451b663a9f85428bc73`，构建 `cpmrt`（js-host）及 `mint-host` 成功。
- 通过远端 Git 新克隆 CLI 提交 `437dece108b9a2843f7fea4b0d662a5e45fa20e6`，构建 `mint-cli --bin mint --release` 成功。
- 使用新构建 CLI、新项目、新 Mint home、新缓存在线安装 13 个锁定包成功；同 lock 离线安装 13 包成功。见 [install.log](evidence/install.log)。
- 新配置及测试入口通过 Python 编译和 Node 语法检查；ACP gateway 聚焦测试 5 passed。
- Rust/Cargo 下载缓存沿用宿主工具链的缓存；Mint 包缓存和运行状态均为新建。这里不声称验证了没有任何 Rust/npm 下载缓存的机器。

## ACP 启动失败

原始错误见 [provider-startup.log](evidence/provider-startup.log)。所有测试均使用同一套发布包，未修改 `.mint/packages`：

| 包 | 版本 | 原始错误 |
|---|---|---|
| compaction-basic | 0.1.4 | plugin imports are disabled |
| compaction-port-owner | 0.2.4 | plugin must export default { activate(ctx) } |
| context-image-offload | 0.1.2 | plugin must export default { activate(ctx) } |
| context-tool-result-pruner | 0.1.9 | plugin must export default { activate(ctx) } |
| model-provider-openai-consumer | 0.1.5 | 激活时 ConsumerError permission_denied |

这些错误阻止整个必需插件装配就绪，因此 Instructions、Retention、Budget、Attachments、Prompt、Time、FS 和 Provider 也不能在此组合下进入真实对话验收。安装成功不等于运行成功；state-types 作为 iface 已成功安装，不单独激活。

## 逐项验收状态

scenarios.mjs 提供 Instructions、Prompt、Time、Attachments、FS read/write（包含 state-types 消费）、Retention、Pruner、Budget、Provider、Image、Compaction Basic/Port 的输入与事件日志。统一组合启动失败时，每项报告 failed，不换旧 Host、不删掉失败插件、不沿用旧结果。

- 新版 13 包运行：启动失败，未通过。
- 压缩正式触发/收据：未覆盖。旧 example-only 测试环境变量不适用于固定 Rust ACP 路径。
- 图片 offload/视觉调用：未覆盖，先被插件激活阻止。
- 浏览器流式、工具审批、附件、取消、刷新、重启恢复：新版组合未通过端到端验收；历史实例证据不能替代。
- Ollama 历史适配器不是默认路径；其简化提示词、工具列表和历史的结果不作为原始请求等价证据。

## 后续修复边界

优先由上述包提供符合 Host 激活契约、构建依赖闭合的新版制品，Provider 的权限问题需联合核对激活时能力和显式 grants。发布修复版后更新精确清单和 lock，在另一空目录重跑。仅确需时改 Mint，不修改公共 iFace。

逐项重跑结果：12 个可执行场景全部在同一必需插件装配失败处报告 failed（FS 场景同时代表 state-types 的运行消费验证未进入）。见 [scenarios.jsonl](evidence/scenarios.jsonl)。

## Git 交付与前端启动

代码锚点提交：`ea57f5fff7b3e1144f358631e335221f2596b0d0`（初始快照）；后续启动修正以 `codex/pilotdeck-mint-reproducible-deploy` 的最终固定提交为准。已从 GitHub 新克隆确认可获取。pnpm 10.32.1 frozen-lockfile 安装成功。Vite 必须从 ui 工作目录启动（配置按 cwd 解析 React），已修正实例启动器；独立端口 server 3187、web 5387 启动，前端 HTTP 200。浏览器聊天验收仍因 ACP 必需插件失败未通过。

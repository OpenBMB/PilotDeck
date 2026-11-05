# Mint Host parity 重测记录（2026-11-05）

## 测试基线

- PilotDeck：`084399afcde29cbcde5ece65dcf23d3ff7a5be0c`（本地 `origin/main` 接入实例）。
- Mint Host：`codex/pilotdeck-turn-loop-host-parity`，基线 `44b92014c67ae5b21ea718bf350b5810c5e4fee8`；本地 parity 接线修改仍在 worktree，未提交。
- 独立运行目录：`/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime-parity-20261105`。
- 项目：`utf8-registry-project`；运行入口：`utf8-unified/launch.py`。

## 安装清单

项目 lock 中安装了原 12 包，并额外安装了新的：

`liyishan1/pilotdeck-context-image-offload@0.1.1`

本轮 MintHub 解析到的更新版本包括：instructions 0.1.6、retention 0.2.6、tool-result-pruner 0.1.8、budget-production 0.3.6、model-provider-openai-consumer 0.1.4；其余包沿用清单版本。

Image offload 的发布物是 owner-injected consumer adapter，不导出标准 `{ activate(ctx) }` 插件。因此它已安装并保留在 lock/包目录中，但不能加入 Host 直接激活列表。独立契约测试通过：`image-offload-contract.mjs` 验证 `replaceMedia` 和 `applyToSupplementalMessage` 都转发给宿主 Budget owner。

## 已完成验证

| 场景 | 结果 | 证据 |
|---|---|---|
| Rust loop + iface + Mint Host + OpenAI consumer | 曾通过，当前重编译后需复核 | `acp-smoke-parity.log`；连续两轮均返回 `apricot`，历史读取包含两轮 assistant 消息。之后切换 parity kernel 二进制复测时出现 5 秒 loop readiness timeout |
| Budget | 通过 | `budget-smoke.log`；超限时记录 `context capacity exceeded; model not called` |
| Retention / Pruner | 可运行但语义待核对 | `retention-smoke.log`；三轮完成，但第三轮未能回忆 inventory row |
| Image offload | consumer 契约通过，Host 注入未完成 | `image-offload-contract.mjs`；2 个 owner 转发调用成功 |
| PilotDeck Server | 已启动 | `http://127.0.0.1:3101`，`/api/auth/status` 返回 200，auth disabled |
| PilotDeck 页面 | 页面可访问 | Vite `http://127.0.0.1:5273/` 返回 200 |

## 当前阻塞

Compaction 重测尚未通过。使用 parity kernel 启动时曾出现两类装配问题并已修正：缺少 `js-host` feature、image offload 被错误放入直接激活 hook 列表、time consumer 缺少 `preparedContext`、工具重复注册。当前重试仍在 5 秒 loop readiness 窗口内超时，尚未取得新的 compaction candidate 证据；此前失败原因是 `Compaction candidate is not eligible for Session persistence`。

本轮新增了 Mint Host 的最小兼容改动：`MINT_LOOP_READY_TIMEOUT_MS` 可覆盖 stdio kernel 的 loop readiness 等待，当前实例设为 30000ms；同时保持 `iface` 目录零修改。延长等待后错误变为 30000ms 内仍未登记 loop，说明剩余问题是 loop/Kernel 装配或注册失败，不是单纯超时。

因此本轮不能报告“12 包完整跑通”。目前可以确认：更新包已安装，Budget 和页面服务已跑通，ACP 连续会话有成功日志；最新 parity kernel 重编译后的启动稳定性、Retention 语义、Compaction 真实提交、Image offload 宿主注入以及页面内真实对话/附件/工具操作仍需继续验证。

## 启动方式

```bash
cd /Users/a1/Documents/ChatGPT/pilotdeck-mint-integration
./integration/mint/start-server.sh
cd ui && node_modules/.bin/vite --host 127.0.0.1 --port 5273
```

ACP 重测：

```bash
PILOTDECK_MINT_COMMAND=/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime-parity-20261105/utf8-unified/launch.py \
PILOTDECK_MINT_PROJECT=/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime-parity-20261105/utf8-registry-project \
node --import tsx integration/mint/acp-smoke.mjs
```

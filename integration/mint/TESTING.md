# PilotDeck + Mint 测试流程

本文记录 PilotDeck `origin/main` 接入 Mint 后的本机测试方法。所有场景使用同一套安装项目、同一外部 AgentCPM Kernel、同一 Rust `builtin-turn-loop`、同一 Mint Host 和同一组 12 个包。

## 1. 测试实例

- PilotDeck 分支：`codex/mint-acp-12-package-integration`
- Mint 分支：`codex/pilotdeck-12-package-integration`
- 项目目录：`/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime/provider-probe-project`
- 原始安装目录：`/tmp/mint-pilotdeck-curated-install-20261105-28489`，保持不修改
- 页面：`http://127.0.0.1:5273/`
- 模型：`mint-minicpm5:2.6b-q4_k_m`
- 模型端点：`http://127.0.0.1:11434/v1`
- 认证：`PILOTDECK_DISABLE_LOCAL_AUTH=1`

12 个包中，11 个是运行时 JS 包，`pilotdeck-tool-fs-state-types@0.1.1` 是文件工具源码的构建类型依赖。

## 2. 构建和准备

在 PilotDeck 集成仓库执行：

```bash
cd /Users/a1/Documents/ChatGPT/pilotdeck-mint-integration

python3 integration/mint/setup-local.py
sh integration/mint/build-runtime.sh
node --import tsx integration/mint/build-streaming-override.mjs \
  /Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime/provider-probe-project
```

构建内容包括：

- `cpmrt`（JS Host）
- `mint-host`
- 外部 Kernel owner
- `installed_loop_worker`
- `installed_tool_command`
- provider 的本地流式适配覆盖

启动和停止：

```bash
sh integration/mint/start-local.sh
sh integration/mint/stop-local.sh
```

启动后打开 `http://127.0.0.1:5273/`。免账号状态应为：

```json
{"needsSetup":false,"isAuthenticated":true,"authDisabled":true}
```

## 3. 聚焦测试

```bash
node --test tests/mint/acp-gateway.test.mjs
node --test tests/mint/streaming-consumer.test.mjs
CARGO_TARGET_DIR=/tmp/mint-merge-all-mrs-20261104/target \
  cargo test -p mint-protocol external_input --lib
```

这些测试检查 ACP 事件映射、连续会话、provider 流式解析、外部输入 envelope 和协议错误传播。

## 4. 按能力测试

### Instructions、Prompt、Time

在项目目录放置 `PILOTDECK.md`，内容包含测试标记，然后发送模型请求。检查 `unified/request-evidence/`，确认请求中包含：

- `context-instructions` 提供的项目指令
- `context-prompt` 提供的 system prompt
- `context-time` 提供的日期和宿主环境

### FS Read、FS State Types

通过网页让模型创建并读取 `browser-proof.txt`，验证：

1. `write_file` 经审批执行；
2. `read_file` 读取实际文件；
3. 结果来自安装的文件工具包。

同时使用已安装的 `pilotdeck-tool-fs-state-types@0.1.1` 编译 read/write 源码，验证类型契约被构建依赖实际消费。结果记录在：

```text
/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime/fs-actual-source-contract.log
```

### Retention、Pruner

```bash
node --import tsx integration/mint/retention-smoke.mjs
```

测试构造多轮工具结果，检查原始结果落盘、后续请求中的保留引用、结果截断和最新结果保留。证据包括：

```text
unified-retention-pruner-small.log
retention-pruner-request-evidence.json
```

### Budget

```bash
node --import tsx integration/mint/budget-smoke.mjs
```

构造超大输入，确认预算评估失败时不会调用模型 provider。证据：

```text
unified-budget-block-final.log
```

### Compaction Basic、Compaction Port

```bash
MINT_COMPACTION_TEST_MODE=basic \
  node --import tsx integration/mint/compaction-smoke.mjs

MINT_COMPACTION_TEST_MODE=port \
  node --import tsx integration/mint/compaction-smoke.mjs
```

检查摘要模型调用、Kernel admission/settlement、lease/fence、正式压缩收据和压缩后继续对话。

### 压缩后的重启恢复

```bash
node --import tsx integration/mint/compaction-restart-smoke.mjs
```

测试先触发压缩，再关闭并重启 ACP/KERNEL。新 Kernel 会话通过稳定 ACP 会话找到原检查点和正式收据，然后继续回答。当前证据中原始 5 个用户回合仍然存在，重启后的回答为 `apricot`：

```text
unified-compaction-restart.log
```

### OpenAI Consumer

检查请求实际经过已安装的 `pilotdeck/model-provider-openai-consumer@0.1.2`，并验证真实流式响应和 usage。provider 使用了明确记录的本地覆盖，原发布制品保存在 `.published` 文件中。

## 5. 浏览器端到端测试

在 PilotDeck 页面完成以下操作：

1. 发送普通消息，确认流式输出；
2. 连续追问，确认同一 Mint 会话保留上下文；
3. 请求创建文件，点击一次性审批，确认文件实际生成；
4. 请求读取该文件，确认工具结果显示在页面；
5. 上传文本附件，询问附件中的验收码和仓库，确认附件进入模型上下文；
6. 点击 Stop，确认请求取消；
7. 重启服务并刷新页面，确认历史仍可查看并能继续追问；
8. 打开 Files 面板，确认项目文件浏览沿用 PilotDeck 原有实现。

网页验收截图：

```text
/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime/browser-proof.png
```

Mint 后端不支持的编辑重跑和分叉操作在页面中保持禁用。

## 6. 主要证据位置

运行日志位于：

```text
/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime/
```

重点文件：

- `unified-compaction-restart.log`
- `unified-compaction-basic-followup.log`
- `unified-compaction-port-followup.log`
- `unified-retention-pruner-small.log`
- `unified-budget-block-final.log`
- `unified/request-evidence/`
- `unified/data/supervisor/installed-rust-loop.log`
- `fs-actual-source-contract.log`
- `run-manifest.json`

## 7. 当前边界

- 12 个包已在统一装配和真实页面流程中完成分能力验证。
- provider 实时流式输出依赖已记录的本地修复版，原发布制品保留。
- Compaction 已通过受控测试阈值触发；尚未实现产品化自动触发策略。
- 本次只做本机集成，不发布 MintHub 包，不部署云端。

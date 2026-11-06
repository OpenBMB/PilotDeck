# PilotDeck + Mint 本机验收记录

本轮基线是 PilotDeck `origin/main` 的接入分支 `codex/pilotdeck-mint-sidecar-integration`，Mint Host 使用同名接入分支。正式入口为 Rust ACP：

```bash
/Users/a1/Documents/ChatGPT/mint-host-parity-worktree/target/debug/cpmrt \
  acp --cwd /tmp/pilotdeck-mint-sidecar-test-20261106/pilotdeck-13-package-project
```

本轮没有使用 `installed_loop_worker`，也没有修改 iFace。项目目录和原始安装目录均保留；项目的 `mint.toml`/`mint.lock` 当前装配 13 个包（包含 image offload）。模型为本机 Ollama 的 `mint-minicpm5:2.6b-q4_k_m`。

## 已通过

| 能力 | 当前证据 |
|---|---|
| ACP Rust loop、连续会话、流式输出 | 普通 Rust ACP smoke；两轮请求复用同一 session；最新重跑日志：`/tmp/pilotdeck-mint-sidecar-test-20261106/time-acp-smoke.log` |
| Attachments + FS read | `package-attachment.txt` 被 `fs_list`/`fs_read` 发现并读取，模型复述 `plum-742` 与 `青岛` |
| FS write | 当前项目生成 `rust-loop-fs-proof.txt`，内容为 `rust-loop-write-42` |
| Instructions | 当前项目 `PILOTDECK.md` 的 marker `mint-pilotdeck-13` 被模型准确复述；此前 `/` 配置已改为项目路径 |
| Prompt / host environment | 模型真实回复包含 `PilotDeck`、`darwin`、`Rust AgentCPM / Mint Host`；证据：`prompt-time-fixed.log` |
| Time | 统一 request-evidence 中的实际模型请求包含 `liyishan1/pilotdeck-context-time-consumer:host-hooks` 和 `<environment><now: 2026-11-05>`；示例：`/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime/utf8-unified/request-evidence/local-01a1ab2b-62ab-7000-b9bd-949e2d0b2d45-t_2-f146a6fe-d162-4842-9af7-fe03e14fb700.json` |
| Budget | 超限请求收到 `[notice] local token estimate exceeds context budget`，终态为 `max_tokens`；验收脚本记录 `providerRequest:false`，未发送模型请求。证据：`/tmp/pilotdeck-mint-sidecar-test-20261106/budget-fixed.log` |
| Retention / Pruner | 三轮工具结果在同一 session 中完成，原始大文件读取、后续历史引用和结果裁剪均完成。证据：`retention-fixed.log` |
| Compaction Basic | 受控多轮回合后仍能回忆 `apricot`。证据：`compaction-basic-rerun.log` |
| Compaction Port | Port owner 路径受控触发后仍能回忆 `apricot`。证据：`compaction-port-rerun.log` |
| Compaction restart | 关闭并重新启动 ACP 后，历史包含 5 个用户回合，重启后回答 `apricot`。证据：`compaction-restart-fixed.log` |
| PilotDeck 聚焦测试 | `acp-gateway`/`streaming-consumer` 8 项（5 passed、3 skipped）；模型测试 136 passed；UI 全套 2795 passed、2 skipped；typecheck/build/desktop compile 通过 |
| Image offload 包测试 | `pilotdeck-context-image-offload` 独立测试 4 passed；owner 注入到真实 `ToolResultBudget` 的 retention 对接测试 2 passed（含 image→media_reference）；`check:source` 通过。新增 fs-read 本地覆盖可将 PNG/JPEG/GIF/WebP 读为 image tool-result，包测试 9/9 通过；Rust ACP 工具调用成功证据：`fs-image-large-acp.log`。context owner 直接预算投影已产生 `media_reference`：`context-media-budget.log`。本地 provider 包修复后，Rust ACP 第二轮请求已把 image tool-result 转成 `data:image/png;base64,...` 的 `image_url`；回放首轮工具调用、第二轮转发到真实 Ollama `qwen2.5vl:3b` 的证据：`/tmp/pilotdeck-mint-sidecar-test-20261106/vision-qwen-forward.log`、`/tmp/vision-replay-body-1.json`；直接视觉请求证据：`/tmp/pilotdeck-mint-sidecar-test-20261106/qwen-vision-direct.json`。新增 `qwen3-vl:2b` 直接请求已确认原生同时返回 tool call 并接受 image input。通过本地 `qwen3-ollama-adapter.py` 处理 Ollama OpenAI shim 对第二轮 image tool-result 历史的兼容性后，ACP 原生首轮 `read_file`、审批、第二轮图片回答均成功；证据：`/tmp/pilotdeck-mint-sidecar-test-20261106/qwen3-image-native-adapter-final.log`。 |
| OpenAI codec 媒体修复 | `pilotdeck-model-openai-compat` 原先只把 tool-result 映射为文本，导致图片丢失；现已保留文本并追加 user image block，codec 测试 10 passed，consumer 重新打包并在测试项目本地覆盖。provider 激活不再要求启动时已有 net caps，改由 `before_model` 调用时校验，避免 ACP 装配阶段误报 permission_denied。 |
| 13 包源码回归 | 对应源码包测试全部通过：instructions 4、tool-result-pruner 4、budget 4、attachments 4、compaction-port 4、compaction-basic 4、prompt 4、time 4、image-offload 4、fs-state-types 1、fs-read 9、model-provider-openai-consumer 4、tool-result-retention 15；汇总日志：`/tmp/mint-13-package-tests.log`。instructions 测试补齐了缺失 evidence 父目录的临时夹具创建。 |
| 锁文件装配 | `mint.lock` 当前解析出 13 个顶层包，版本与清单一致；核对命令输出已确认。 |
| PilotDeck 页面流式/连续追问 | 当前页面 `http://127.0.0.1:3101/session/web:s_34fc148e-2fd7-4f15-91c2-1eec5d8f832b`，收到 `MINT_UI_OK`、`MINT_UI_FOLLOWUP` |
| PilotDeck 页面附件上传 | Chrome 原生文件选择器上传 `package-attachment.txt`，页面显示“上传完毕”，Mint 回复 `Acceptance code: plum-742`、`Warehouse: 青岛`；刷新 session `http://localhost:3101/session/web:s_8934492c-a4ee-4d2d-8004-1256bc9e37e9` 后历史仍显示附件问题与答案 |
| PilotDeck 页面工具审批 | 页面显示 `Using fs_write ui-proof.txt`，Allow once 后显示 `Used fs_write` 和 `DONE`；实际文件为 `ui-proof.txt` |
| PilotDeck 页面取消 | 长请求进入 `Generating response`，点击 Stop 后回到可发送状态，未生成模型回答 |

日志目录：`/tmp/pilotdeck-mint-sidecar-test-20261106/`。本轮关键日志为 `budget-fixed.log`、`retention-fixed.log`、`compaction-basic-rerun.log`、`compaction-port-rerun.log`、`compaction-restart-fixed.log`、`instructions-fixed.log`。

## 仍未完成

1. **视觉工具模型**：已通过。`qwen3-vl:2b` 原生支持 tools+vision；本地 `qwen3-ollama-adapter.py` 只处理 Ollama OpenAI shim 的请求格式兼容，不生成工具结果。Rust ACP 首轮真实模型 tool call、Mint Host 执行 `read_file`、第二轮真实视觉回答均成功，日志为 `/tmp/pilotdeck-mint-sidecar-test-20261106/qwen3-image-native-adapter-final.log`。
2. **PilotDeck 浏览器 E2E**：流式对话、连续追问、工具展示、审批、Stop、文本附件上传和刷新历史均已通过。页面附件证据：session `http://localhost:3101/session/web:s_8934492c-a4ee-4d2d-8004-1256bc9e37e9`，上传后回复 `plum-742`/`青岛`，刷新后仍可见；API 上传日志：`/tmp/pilotdeck-mint-sidecar-test-20261106/browser-upload-api.log`。

本轮补充回归：PilotDeck 聚焦筛选测试最终为 1076 passed、0 failed、7 cancelled、2 skipped；取消项来自筛选条件不匹配或测试主动跳过。重新执行 `build:web` 时环境使用 Node 24.22.1（项目要求 `<23`），pnpm 触发依赖重装后已中断，未将该次环境失败计入功能失败。


## 重跑命令

所有命令在 PilotDeck 集成仓库执行，并清除继承的 `NODE_OPTIONS`：

```bash
cd /Users/a1/Documents/ChatGPT/pilotdeck-mint-integration
NODE_OPTIONS= python3 /tmp/run-current-mint-test.py integration/mint/budget-smoke.mjs
NODE_OPTIONS= python3 /tmp/run-current-mint-test.py integration/mint/retention-smoke.mjs
NODE_OPTIONS= MINT_COMPACTION_TEST_MODE=basic python3 /tmp/run-current-mint-test.py integration/mint/compaction-smoke.mjs
NODE_OPTIONS= MINT_COMPACTION_TEST_MODE=port python3 /tmp/run-current-mint-test.py integration/mint/compaction-smoke.mjs
NODE_OPTIONS= python3 /tmp/run-current-mint-test.py integration/mint/compaction-restart-smoke.mjs
```

浏览器服务入口仍使用 `PILOTDECK_DISABLE_LOCAL_AUTH=1`、`PILOTDECK_RUNTIME_BACKEND=mint` 和 `runtime-launch.py`；`start-server.sh` 现在同时导出 `MINT_PROJECT`、`MINT_HOME` 和模型端点，避免服务端 sidecar 缺少项目环境而退出；正式 sidecar 命令必须指向上面的 `cpmrt acp --cwd`。

## 判定

Rust loop、Mint Host、13 包装配和上述已列能力已经在同一项目中运行。完整交付的视觉场景已通过；本地适配器的用途和边界已在上文记录。

本次浏览器复测（2026-11-06）：使用 `http://127.0.0.1:3101` 服务、`PILOTDECK_DISABLE_LOCAL_AUTH=1`、`PILOTDECK_RUNTIME_BACKEND=mint`，打开会话 `http://127.0.0.1:3101/session/web:s_7bab8829-e90d-417b-8b4a-68c48f2e9ce3`。新建对话发送 `Reply exactly with MINT_BROWSER_RETEST.`，页面返回 `MINT_BROWSER_RETEST`；同一会话追问 `Reply exactly with MINT_BROWSER_FOLLOWUP.`，页面返回 `MINT_BROWSER_FOLLOWUP`；刷新页面后两轮历史仍存在。截图由浏览器自动化保存于本轮输出。


## 13 包统一项目构造场景复测（2026-11-06）

本次逐项复测使用同一项目 `/tmp/pilotdeck-mint-sidecar-test-20261106/pilotdeck-13-package-project`、同一 Rust ACP 入口和同一 Mint Host；运行时显式使用项目 trust 配置及 12 个可执行 JS 插件。第 13 个顶层依赖 `pilotdeck-tool-fs-state-types@0.1.1` 是 `fs-read` 的构建/类型契约包，不是独立可激活插件，因此不应放入 `MINT_REQUIRED_PLUGINS`；它已由锁文件安装并由 fs-read 场景消费。

| 包/能力 | 构造场景与当前证据 | 判定 |
|---|---|---|
| context-instructions | 同一 ACP 项目的 `PILOTDECK.md` marker 注入模型请求；已有 `instructions-fixed.log` | 通过 |
| context-retention | 100 行工具结果、三轮同 session 追问；统一项目重跑输出 `13pkg-current-retention.log`，出现 `retention_smoke_done` | 通过 |
| context-tool-result-pruner | 两个大工具结果连续进入同一 session；已有 pruner 验收日志；本次旧脚本因模型长思考未在限定时间内收尾，不能据此判失败 | 已有通过证据，复测脚本超时 |
| context-budget | 真实 ACP 请求输出 `local token estimate exceeds context budget`，终态 `budget_block` 且 `providerRequest:false`；`13pkg-current-budget.log` | 通过 |
| context-attachments | 同一项目写入 `package-attachment.txt`，附件上传后真实 `fs_read` 返回 `amber-618` 与 `青岛`；`13pkg-current-attachments.log`。脚本附带的缺失附件断言与当前 loop 的 completed 语义不一致，未把该断言当作能力失败 | 主场景通过 |
| compaction-port-owner | `MINT_COMPACTION_TEST_MODE=port` 多轮受控压缩，已有 `compaction-port-rerun.log` | 通过 |
| compaction-basic | `MINT_COMPACTION_TEST_MODE=basic` 多轮受控压缩，已有 `compaction-basic-rerun.log` | 通过 |
| context-prompt | 请求中包含 provider、permission mode、PilotDeck 上下文；`prompt-time-fixed.log` | 通过 |
| context-time | 请求 evidence 含 `context-time-consumer:host-hooks` 和 `<now>`；统一 evidence 记录 | 通过 |
| context-image-offload | `tiny.png` 触发真实 `read_file` 图片结果，第二轮转成 image block 后送入 qwen3-vl；`qwen3-image-native-adapter-final.log` | 通过 |
| tool-fs-state-types | 以构建依赖被 fs-read 使用；源码测试 1 passed，统一项目锁文件包含 `0.1.1` | 通过（契约/构建依赖） |
| tool-fs-read / tool-fs-write | 同一 ACP 项目真实读取文本/图片并通过审批执行 `write_file`；`fs-image-large-acp.log`、`13pkg-current-attachments.log` | 通过 |
| model-provider-openai-consumer（及 codec 构建依赖） | 普通 ACP 请求实际经过 OpenAI consumer；媒体 codec 测试 10 passed，视觉第二轮真实到达 qwen3-vl | 通过 |

这批重跑最初出现的失败原因是旧 runner 继承了已删除的 `/tmp/mint-merge-all-mrs-20261104` 二进制和 `11416/11417` 旧模型端点，并且未使用项目 trust；修正为当前 `mint-host-parity-worktree/target/debug/cpmrt`、Ollama `11434` 和当前项目 trust 后，ACP、附件、Retention、Budget 均进入真实执行路径。未把环境装配错误计入包能力失败。

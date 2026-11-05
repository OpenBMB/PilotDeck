# PilotDeck + Mint 本机集成

页面：http://127.0.0.1:5273/ 。使用上游免账号配置 `PILOTDECK_DISABLE_LOCAL_AUTH=1`。
前端基线 origin/main `6a16ccccfa57b1a8e4ceaded3fddfc4bbf17985d`，分支
`codex/mint-acp-12-package-integration`。Mint 基线 `15354d81`，分支
`codex/pilotdeck-12-package-integration`。

执行链：网页 bridge → 服务端 ACP gateway → cpmrt → 外部 Kernel →
Rust builtin-turn-loop → iface 服务适配 → Mint Host → 安装包。
`context-owner.mjs` 复用上游 DefaultContextRuntime，不运行 TypeScript loop。
11 个 JS 包为必需依赖，缺失/注册错误阻止就绪；第12个是构建依赖类型包。

## 启停

在此仓库根目录运行：

```sh
sh integration/mint/build-runtime.sh
python3 integration/mint/setup-local.py
node --import tsx integration/mint/build-streaming-override.mjs /Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime/provider-probe-project
sh integration/mint/start-local.sh
# 停止此独立实例
sh integration/mint/stop-local.sh
```

依赖已安装的 Rust、Node22、仓库 pnpm 依赖和本地模型服务。
当前实例 `/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime`；原安装目录
`/tmp/mint-pilotdeck-curated-install-20261105-28489` 保留。
模型 `http://127.0.0.1:11434/v1`、`mint-minicpm5:2.6b-q4_k_m`。
运行配置 `unified/env.json`、`kernel.toml`、`components.json`，仓库保存对应模板。
`PILOTDECK_MINT_COMMAND/PROJECT/STATE_DIR/MODEL` 在 start-server.sh 配置。
密钥通过 `MINT_MODEL_API_KEY` 环境提供；本机模型无密钥，模板为占位值。
更换端点还需同步 Kernel 路由与 Host net grants。默认只监听本机。
固定私有 UDS 供这一个实例使用，不同时启动多个 runtime。

## 12包验收

所有场景使用同一安装项目、同一外部 Rust loop 装配；压缩与保留场景通过环境变量
调整触发阈值。日志均位于运行目录。模型复述不作为单独验收依据。

| 包及版本 | 实际消费证据 |
|---|---|
| pilotdeck/context-instructions@0.1.5 | 模型请求包含项目 PILOTDECK.md 标记 MINT-CURATED-12 |
| pilotdeck/context-retention@0.2.3 | 原工具结果落盘，后续请求替换为保留引用；retention-pruner-request-evidence.json |
| pilotdeck/context-tool-result-pruner@0.1.7 | 历史工具结果3272→817字符并截断，最新结果保持；unified-retention-pruner-small.log |
| pilotdeck/context-budget-production@0.3.4 | 真实请求预算评估；450KB输入被拒且无provider调用；unified-budget-block-final.log |
| liyishan1/pilotdeck-attachments-consumer@0.1.0 | 网页上传文本，安装包投影附件，回答plum-742/青岛；web会话日志 |
| liyishan1/pilotdeck-compaction-port-owner@0.2.3 | 真实摘要模型结算、lease/fence及正式Kernel收据；unified-acp-compaction-port-fences.log |
| liyishan1/pilotdeck-compaction-basic@0.1.3 | 真实摘要、正式收据、后续追问和跨进程恢复；unified-compaction-restart.log |
| liyishan1/pilotdeck-context-prompt-consumer@0.1.2 | 实际发送请求的system提示；unified/request-evidence |
| liyishan1/pilotdeck-context-time-consumer@0.1.0 | 实际发送请求中的日期及环境；unified/request-evidence |
| liyishan1/pilotdeck-tool-fs-state-types@0.1.1 | 原read/write源码用已安装d.ts编译通过；fs-actual-source-contract.log（成功时为空） |
| liyishan1/pilotdeck-tool-fs-read@0.1.3 | 包同时提供read_file/write_file；网页审批后创建browser-proof.txt并读取；Kernel工具记录 |
| pilotdeck/model-provider-openai-consumer@0.1.2 | 实际本地模型流式响应；明确的本地覆盖，见下文 |

网页已验证流式、连续追问、服务重启恢复、审批、工具展示、文本附件、取消和刷新历史。
Mint不支持的编辑重跑和分叉已禁用。高级工作流不属于本次验收。

## 本地修复与边界

仅 provider 使用 `streaming-consumer.mjs` 本地覆盖，仍使用发布codec0.1.2；
原制品保存为 `.published`，项目 LOCAL-OVERRIDE.md 记录范围。结果依赖此覆盖，
不代表未经修改的发布provider已满足实时增量要求。未发布任何MintHub包。

压缩使用 `MINT_COMPACTION_TEST_MESSAGES` 与 `MINT_COMPACTION_TEST_MODE=basic|port`
受控触发，已验证正式收据和继续对话；尚未实现产品化的自动压缩策略。
压缩替换视图以稳定ACP会话保存，保留正式Kernel收据，原始历史由Mint journal保存。
类型包不执行JS，其运行语义由组合fs-read制品消费。原源码编译证据放在运行目录
`fs-source-contract`，不会替换发布FS制品。

聚焦检查：gateway 5项、external events 8项、streaming 3项、外部输入协议1项、
UI TypeScript和文件工具实际源码类型检查通过。原失败日志保留用于追踪。

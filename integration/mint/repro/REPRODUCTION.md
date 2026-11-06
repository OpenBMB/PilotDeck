# 独立复现报告

日期：2026-11-06；本轮使用修复后发布版，精确版本以同目录 mint.toml / mint.lock 为准。

**结论：5 个包的激活错误已解决，干净实例可以启动 ACP 和 PilotDeck 对话；13 包完整端到端验收仍未通过。**

## 环境与来源

- Host 从远端 Git 新克隆并构建：`0598599ef99671c1f03e7451b663a9f85428bc73`；CLI 同样从远端构建：`437dece108b9a2843f7fea4b0d662a5e45fa20e6`。
- 本轮新项目、新 Mint home、新 Mint 安装缓存、新状态目录。在线 locked 安装 13 包成功，同 lock 离线安装成功。[安装日志](evidence/fixed-20261106/install.log)。未复制旧安装目录，未修改下载后 JS。
- macOS、Node 22、pnpm 10.32.1、Rust 1.99.1、Python 3，原始 Ollama OpenAI-compatible 接口，模型 `mint-minicpm5:2.6b-q4_k_m`。Rust/npm 下载缓存沿用宿主工具链缓存，不声称验证了整机零缓存。
- 使用透明请求记录代理，原始请求 body 转发至 Ollama，不改写提示词/工具/历史；不是历史 Ollama adapter。
- 运行路径为 `cpmrt acp --cwd PROJECT`，没有 installed_loop_worker，没有 PilotDeck TypeScript turn loop。本次未修改 Host 或公共 iFace。

## 包验收

| 包 | 版本 | 本轮结果与证据 |
|---|---|---|
| Instructions | 0.1.7 | 通过：最终 system 含 project-instructions 和 MINT_REPRO_13；配置修正为 workspace `/`。旧错误配置下模型自行 read_file 不计作注入通过。 |
| Prompt | 0.1.4 | 请求注入通过：有包名段和环境提示；模型自称 Mint 导致旧回答断言失败，不代表请求未注入。 |
| Time | 0.1.6 | 通过：最终 system 含 time consumer host-hooks、environment 日期。 |
| Attachments | 0.1.3 | ACP 通过：最终 user 消息含 attachment 块、plum-742 / 青岛；本轮浏览器上传未覆盖。 |
| FS Read | 0.1.5 | 文本读写通过：真实 write_file/read_file、审批、中文和 emoji 文件内容；图片读取失败。 |
| FS State Types | 0.1.2 | iface 安装通过；FS consumer 文本操作通过。未额外记录独立类型契约调用轨迹。 |
| Retention | 0.2.10 | 激活及普通工具场景通过；新发布版改为只读 projection，尚无足够隔离证据验证其截断/保留边界，不继承旧落盘验收结论。 |
| Pruner | 0.1.10 | 通过：最终请求旧工具结果 967 字符、带 Old tool result content compacted，新结果 3065 字符；原始源文件各 100 行。 |
| Budget | 0.3.7 | 超限拒绝通过：max_tokens + exceeds context budget，捕获请求中无该超长输入；估算 exact=false，不能写成精确 token 计数。 |
| Compaction Port | 0.2.5 | 工具调用成功；只投影 budget intent，正式压缩/持久化收据未覆盖。 |
| Compaction Basic | 0.1.5 | 失败：真实调用 readOnly 分支即返回 service not registered；ACP 装配未提供所需 compaction 服务。 |
| Image Offload | 0.1.4 | 未通过：激活仅延迟绑定 owner；无替换证据；read_file tiny.png 返回失败，最终请求无 image_url；真实视觉回答未覆盖。 |
| OpenAI Consumer | 0.1.6 | 激活通过、模型联网成功；固定 ACP Agent 从 config 加载内置 provider，未接 InstalledCompletionProvider，不能计为包调用通过。 |

[请求证据检查](evidence/fixed-20261106/checks.jsonl)；[context 请求](evidence/fixed-20261106/context-request.json)；[附件请求](evidence/fixed-20261106/attachments-request.json)；[Pruner 请求](evidence/fixed-20261106/pruner-request.json)；[场景事件](evidence/fixed-20261106/scenarios.jsonl)；[压缩调用](evidence/fixed-20261106/compaction.jsonl)；[预算拒绝](evidence/fixed-20261106/budget.jsonl)。这些只含构造测试数据，无 API key。

## 浏览器与恢复

独立 server 3197、web 5397，空 pilot-home 经免账号 onboarding 进入工作区。

- 流式回答 `MINT_FIXED_BROWSER_OK`、连续追问通过。
- 页面显示 read_file browser-proof.txt 的审批请求，Allow once 后显示 `MINT_REPRO_FS 青岛 🙂`，通过。
- 页面刷新后保留历史，通过。
- run.py stop/start 重启本实例后刷新，历史及工具回答仍存在，通过；重启后的继续追问尚未单独覆盖。
- 浏览器上传附件、取消、本轮真实视觉场景未覆盖；不能引用旧实例结果代替。

## 验证入口与剩余接线

Gateway 聚焦测试 5/5 通过，新增 Python 入口编译、scenarios Node 语法检查通过。
scenarios 的 scenario_completed 只表示回答/文件断言完成；新增工具失败检查，压缩无正式收据时明确 NOT_COVERED，绝不把普通 OK 回答算压缩成功。最终请求用 check-evidence.py 单独检查。

后续需补 ACP composition root 的 provider、compaction owner 服务和媒体 owner 接线；优先应用/包层，确需时改 Mint，禁止改公共 iFace。当前部署文档可复现基本对话及上述失败，不承诺“照着即可完整跑通13包”。

旧版 5 包激活失败证据仍保留在 evidence 根目录，仅作历史对照。本轮固定交付 tag：`codex/pilotdeck-mint-repro-fixed-20261106`（完整提交由 Git tag 解析）。

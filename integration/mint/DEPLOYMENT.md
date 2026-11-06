# 从干净环境部署 PilotDeck + Mint

适用日期：2026-11-06。本文的输入仅为 Git、MintHub 和模型服务。完整验收状态见 [REPRODUCTION.md](repro/REPRODUCTION.md)；历史实例测试见 [TESTING.md](TESTING.md)，两者不能互相替代。

## 1. 获取固定源码

需要 macOS、Xcode Command Line Tools、Git、Python 3.11+（使用 tomllib）、Node `>=22.13 <23`、pnpm `10.32.1`、rustup，以及 CodeHub 仓库的 SSH 读取权限。模型测试默认使用 Ollama。

从 Git 获取 PilotDeck 接入分支：

```sh
mkdir -p "$HOME/pilotdeck-reproduction"
cd "$HOME/pilotdeck-reproduction"
git clone --branch codex/pilotdeck-mint-reproducible-deploy \
  https://github.com/openbmb/pilotdeck.git pilotdeck
cd pilotdeck
# 固定为本次交付的代码锚点（部署报告记录完整提交）：
git checkout codex/pilotdeck-mint-repro-fixed-20261106
pnpm install --frozen-lockfile
```

源码基线记录在 [sources.json](repro/sources.json)。PilotDeck 上游 main 基线为 `32a291f65417af9358a54e13072f5a8a1752ad18`。

| 用途 | Git 分支 | 固定提交 |
|---|---|---|
| Rust ACP + Mint Host | agent-kernel / `codex/pilotdeck-mint-sidecar-integration` | `0598599ef99671c1f03e7451b663a9f85428bc73` |
| Mint 安装 CLI | agent-kernel / `codex/mint-iface-kind` | `437dece108b9a2843f7fea4b0d662a5e45fa20e6` |

Host 提交包含 parity 基线及 !37–!40，不需要部署者自行组合 MR。CLI 是另一个源码 checkout：它支持 `kind=iface` 的安装和锁文件解析，并非 ACP 执行器。构建遵循仓库 rust-toolchain（当前 `1.99.1`）。不修改公共 iFace 源码。

## 2. 准备模型

在独立终端运行已安装的 Ollama 服务（服务已运行时无需再次启动）：

```sh
ollama serve
```

另一个终端获取文本模型并检查接口：

```sh
ollama pull mint-minicpm5:2.6b-q4_k_m
curl http://127.0.0.1:11434/api/tags
```

若该模型名在接收方不可下载，选择可获取且支持工具调用的模型，通过下节 `--model` 指定。替换模型后必须重新验收，不能继承原模型结果。

## 3. 构建与安装独立实例

在 PilotDeck 根目录执行：

```sh
python3 integration/mint/repro/bootstrap.py \
  --root "$HOME/pilotdeck-reproduction/runtime" \
  --model mint-minicpm5:2.6b-q4_k_m \
  --base-url http://127.0.0.1:11434/v1
```

该命令从 CodeHub 克隆两个固定提交，分别构建 `mint` CLI、`cpmrt` 和 `mint-host`，再建立 `runtime/instance`。Rust 构建可能下载 V8 预编译依赖；无需预先准备本机二进制。

安装输入为仓库中的 [mint.toml](repro/mint.toml) 和 [mint.lock](repro/mint.lock)，13 个包均精确锁定。安装过程先在线 `install --locked`，再使用刚下载的缓存执行 `install --offline --locked`；不复制任何已有安装目录、不修改制品内容。

| 包 | 版本 |
|---|---|
| pilotdeck/context-instructions | 0.1.7 |
| pilotdeck/context-retention | 0.2.10 |
| pilotdeck/context-tool-result-pruner | 0.1.10 |
| pilotdeck/context-budget-production | 0.3.7 |
| liyishan1/pilotdeck-attachments-consumer | 0.1.3 |
| liyishan1/pilotdeck-compaction-port-owner | 0.2.5 |
| liyishan1/pilotdeck-compaction-basic | 0.1.5 |
| liyishan1/pilotdeck-context-prompt-consumer | 0.1.4 |
| liyishan1/pilotdeck-context-time-consumer | 0.1.6 |
| liyishan1/pilotdeck-context-image-offload | 0.1.4 |
| liyishan1/pilotdeck-tool-fs-state-types | 0.1.2 |
| liyishan1/pilotdeck-tool-fs-read | 0.1.5 |
| pilotdeck/model-provider-openai-consumer | 0.1.6 |

`state-types` 是 iface 类型/构建依赖；其他 12 个包列入必需 JS 插件检查。项目 Instructions 配置、canonical project trust、文件权限 grants 和模型端点由 configure.py 按真实路径生成，不读取用户旧 Mint 配置。

生成目录：

```text
runtime/
  host-source/          # 固定 Host Git checkout、target/debug/{cpmrt,mint-host}
  cli-source/           # 固定 CLI Git checkout、target/release/mint
  instance/
    env.json            # 路径、插件清单、grants、模型、端口；不保存 API key
    project/            # mint.toml、mint.lock、.mint/packages、Mint journal
    mint-home/          # 独立 config.toml、trust.toml
    cache/              # 独立安装缓存
    bridge-state/       # PilotDeck → Mint 会话映射
    pilot-home/         # PilotDeck 展示历史及应用数据
    logs/               # web/server 日志
```

可通过 bootstrap 参数 `--server-port 3102 --web-port 5274` 使用另一组端口。默认 server `3101`、web `5273`、模型 `11434`。远端模型使用 `--base-url` 和环境变量 `MINT_MODEL_API_KEY`；相应网络访问必须与 grants 一致。

## 4. 验证 ACP，再启动网页

所有命令仍在 PilotDeck 根目录执行：

```sh
INSTANCE="$HOME/pilotdeck-reproduction/runtime/instance"
python3 integration/mint/repro/run.py --root "$INSTANCE" exec -- \
  node integration/mint/repro/scenarios.mjs provider
python3 integration/mint/repro/run.py --root "$INSTANCE" start
```

访问 `http://127.0.0.1:5273/`。server 通过 Mint ACP gateway 启动 `cpmrt acp --cwd <project>`；未配置外部 kernel 或 installed_loop_worker。该固定 ACP 路径直接加载 Host hooks；配置中的历史 Node context-owner 变量没有被固定 Host 消费，不能据此声称图片或压缩 owner 已接线。

本机实例设置 `PILOTDECK_DISABLE_LOCAL_AUTH=1`，免首次注册，绑定本机地址。空 pilot-home 仍会显示语言、模型和工作目录引导；免账号不等于跳过产品引导。引导中的连接探测不能替代前面的真实 ACP 冒烟结果。配置或插件启动失败直接进入日志/页面，不回退其他后端。

停止并保留状态：

```sh
python3 integration/mint/repro/run.py --root "$INSTANCE" stop
# 使用相同目录再次 start，保留项目 journal、bridge-state 和 pilot-home
```

不要再次 configure 已有实例；它会拒绝覆盖 env.json。创建第二套实例时使用新 root。

## 5. 构造测试与判定

```sh
python3 integration/mint/repro/run.py --root "$INSTANCE" exec -- \
  node integration/mint/repro/scenarios.mjs \
  > "$INSTANCE/scenarios.jsonl" 2>&1
```

也可以在 scenarios.mjs 后传入一个或多个场景名：`instructions prompt time attachments fs retention pruner budget provider image compaction_basic compaction_port`。FS 场景覆盖 state-types 被实际工具实现消费。每项保存真实事件，模型响应完成只标记 `scenario_completed`，不能替代包调用证明。

Instructions 的 `projectRoot` 和 `cwd` 必须配置成工作区内 `/`，不能写宿主绝对目录。

必须检查：Instructions marker、Prompt/Time 的实际模型输入、attachments 投影、FS 工具与文件、Retention 引用和 Pruner 前后长度、Budget 拒绝前没有模型调用、Compaction owner/实现收据、provider 调用及媒体替换。压缩用例目前只建立对话输入；若固定 Host 未提供正式可控触发入口，报告“未覆盖实际压缩”，不能使用 example-only 环境变量声称通过。

浏览器逐项操作：发送短消息观察流式；连续追问；要求写入并读取文件，批准后核对文件；上传附件并核对 `plum-742 / 青岛`；长请求 Stop；刷新并检查历史；停止和重启同实例后再检查历史及追问。任何 ACP 启动失败都先记录原错误，不继续声称浏览器能力通过。

图片需要 tools+vision 模型，可新建实例并设置 `--model qwen3-vl:2b`。默认走原始 OpenAI-compatible 请求。历史 `qwen3-ollama-adapter.py` 会改写系统提示、缩减工具及历史，不属于默认部署路径；它的通过结果只能作为受控适配测试，不能视为原始请求等价验证。

## 6. 排查与限制

- trust 错误：检查生成的 canonical 路径，macOS `/tmp` 常解析为 `/private/tmp`。
- iface lock 解析失败：确认使用固定 `437dece1` CLI，而非 PATH 中旧 mint。
- JS 插件激活失败：查看原始错误及发布包入口。禁止给下载后的文件补 default export 来绕过验收。
- 模型访问旧端口：只使用本实例 env.json 和 mint-home/config.toml；不要运行历史 runner。
- 端口冲突：停止本实例或创建新端口配置；不会终止其他运行实例。
- 新发布包的启动或调用失败：记录具体包、版本和错误，交由包修复/发布后再更新 lock。

独立复现的结果和未完成项以 [REPRODUCTION.md](repro/REPRODUCTION.md) 为准。

## 7. 透明记录模型请求

需要检查最终请求时，在独立终端运行：

```sh
python3 integration/mint/repro/model-recorder.py --output "$INSTANCE/model-requests"
```

新建实例时使用 `--base-url http://127.0.0.1:11428/v1`。该代理将请求 body 原始字节转发到 `11434`，保存请求和响应，不改写提示词、工具或历史。只用于受控测试；请求内容会写入指定目录。通过 `--upstream` 和 `--port` 修改地址。

用 `python3 integration/mint/repro/check-evidence.py "$INSTANCE/model-requests"` 检查 Instructions/Prompt/Time 注入和 Pruner 替换证据；其他项目仍按复现报告逐项判定。

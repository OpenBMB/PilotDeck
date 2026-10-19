# 独立 KM / SOP 源码部署验收

2026-10-19，在 `codex/km-sop-compose-exporter` 隔离 checkout 完成本地源码部署验证。基线仍为 PR #660 的 `b436dddbf4575b938c20295dca59110f04b87a0e`，包含当前 exporter 修复。本次 PilotDeck、KM、SOP 均为宿主进程，未使用 Docker 镜像启动服务。

## 安装与启动

- 新建空数据目录 `~/.local/share/pilotdeck/km-sop-source-20261019`，独立账号、数据库、token 与日志；未复用原 3312 或 Compose 数据。
- PilotDeck 使用隔离 checkout 已安装的 pnpm 依赖，Node 22.23.1 / pnpm 10.32.1；本次没有重做全新 npm 缓存或宿主依赖安装验收。
- KM 独立源码复制到验收目录，执行 `npm ci`、UI build，再通过 `pnpm start:local --prepare-only --km-package <source> ...` 在新 Python 3.12 venv 安装，幂等准备 local space。
- KM 开启认证，使用独立 service/capability bearer；配置宿主 parse/model callback，没有 KM modelConfig 或模型 key。
- `pnpm build:web` 成功，前端与运行时使用同一新版 profile，正常登录模式；SOP 首启自动在新 venv 中 editable 安装仓库内独立 package。
- Web `3315`、Gateway `18815`、KM `18895`、SOP `18915` 均仅监听 loopback；supervisor 管理 SOP，Web/Gateway 管理 KM。

源码命令与配置见 [部署文档第 8 节](DEPLOYMENT.zh-CN.md#8-源码部署无-docker)。本机保留的 `control.mjs start|stop|status` 用于启动及停止本次实例。

## 实测结果

| 检查 | 结果 |
| --- | --- |
| 健康与模块 | KM ready、SOP lifecycle/v3/ownership runtime；宿主 Gateway ready，unavailableSlots 为空；前端包含 knowledge-core 和 pilotdeck-sop |
| 正常身份 | API 注册新 owner ID 1，浏览器登录表单成功；审批使用 owner 登录 JWT |
| KM 导入 | Markdown 经宿主 parse capability，job succeeded，生成知识库、文档、bucket、chunk |
| 真实模型查询 | `deepseek-v4-flash-0731` 经宿主 capability，trace 包含 document_route_model、bucket_route_model，无 fallback，返回文档 chunk |
| Citation | resolve 返回原始片段及 `SOURCE-KM-SOP-1019` 标记 |
| SOP | 管理 API 发布 `compose_approval@1.0.0`，浏览器聊天启动并进入 owner handoff，回复恢复后 completed、revision 4 |
| 去重 | 同一 resume 请求重放 duplicate=true；continuation accepted input 数量为 1 |
| 停止与恢复 | SIGTERM 后 Web/Gateway/KM/SOP 四端口全部释放；相同数据目录重启后登录、真实查询、citation、SOP completed、会话与单次 continuation 均保留 |
| 浏览器 | 1440x1000 与 390x844 检查 Knowledge、SOP、会话；重启后重新使用表单登录并恢复会话；无 pageerror，截图检查未发现内容重叠 |
| 原有部署 | 3312 `/health` 仍为 200；3314 Compose 三服务继续运行、KM/SOP healthy |

## 修复与测试

源码 `pnpm build:web` 首轮暴露 exporter 测试断言的 TypeScript 可选字段错误（TS18048）；已改为可选访问。完整源码构建随后通过，Exporter 回归测试 9/9。

显式开启 `SOP_TEST_REAL_RUNTIME=1`、指定 Python 3.12 后，本地 SOP launcher 测试 2/2 通过、无跳过，覆盖首次源码安装、重复进程拒绝、数据库重启保留与随父进程退出。

验收脚本首轮使用简化 dotenv 读取方式，把包裹引号带入模型 key，造成 provider 鉴权失败和查询词法 fallback。已更正私有测试配置，后续初始查询、重启前和重启后查询均验证真实模型 trace 且无 fallback；失败输出保留，不计入通过结果。重复运行脚本产生的三份成功导入文档保留。

## 证据与限制

本机证据目录：`~/.local/share/pilotdeck/km-sop-source-20261019`，包含 `acceptance.json`、`browser-acceptance.json`、`persistence-before.json`、`persistence-restart.json`、`browser-restored.json`、`evidence/` 和服务日志。凭据、owner 登录文件与私有 profile 不作为共享证据提交。

本次为 macOS 本地源码验收，未验证 Linux systemd、生产域名、历史生产数据迁移或数据库跨版本升级。源码准备器使用 pip 当前解析依赖，与 Compose 的冻结 uv 依赖安装分开记录。当前实例保留在 `http://127.0.0.1:3315`，原 3312 和 Docker 3314 均未替换。

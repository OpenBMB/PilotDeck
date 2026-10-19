# SOP v4 / KM 解耦与启动验收

日期：2026-10-19。工作区 `/Users/a1/.codex/worktrees/sop-v4-backend/PilotDeck`，分支 `codex/sop-v4-backend`，基线 `06c29176b2cf3d6db811994c02853c49c93d0fdb` 加本地未提交修改。保留原工作区、原数据库与之前验收记录。本报告只声明本机实际执行结果。

## 实现范围

- `SopApprovalAuthority` 可注入，凭据经宿主认证后提交不透明 subject ID；Runtime 不查用户库。默认关闭审批，预检拒绝审批节点。可选 PilotDeck owner JWT 适配器保留既有调用方式，自定义实现不需要 owner 数据库。
- 正式 YAML 支持 `sop.lifecycle/v4` / `sop-http-v4`、endpoint、credentialEnv、timeout、approval、托管 Python/dataDirectory/maxConcurrency，默认上限 32。v4 直接接执行客户端和工作宿主，不加载 v3 定义；旧 v2/v3 保持原路径。旧环境入口与显式 YAML 冲突时拒绝启动，包括显式关闭 SOP。
- 模块接口准确返回 v4 enabled/contract/ready，Gateway 声明 `sop_execution`。后端启用 v4 不启用旧 SOP 页面。
- 本机/外部两份 YAML、SOP-only/KM-only/组合源码控制器与独立 Compose 导出。安装仅需 SOP package 与独立 Knowledge Core package，不复制 SD backend。源码 KM 保留 namespace、spaces 与服务凭据，不依赖 SD 用户库。
- prepare 可用 `--build` 单独记录 Python 安装及 Node/Web 构建；start 不安装、不构建、不下载。两个托管服务并行，通过 SOP 认证数据库探测、KM 数据库/空间初始化、Gateway 协议绑定后返回就绪。失败仅清理本次启动的组件。
- 动态扩展仍限定为固定版本 subSOP 的 foreach 列表展开，不支持任意运行时图编辑。

## 确定性检查

根构建通过；配置/执行宿主/export 聚焦测试 44/44，模块状态接口 30/30，Python v4 状态机/API 11/11。最终 exporter 健康检查调整后另复跑 v4 和独立组合导出 2/2，`docker compose config --quiet` 通过。旧 v3 配置和导出在 44 项内覆盖，未迁移旧数据。

最终另跑配置/托管运行测试 2/2：由 createLocalGateway 实际启动准备好的 Python，验证并发上限 7、认证数据库探测、不创建 auth.db；第二个宿主遇端口占用拒绝启动，dispose 不停止第一个宿主的 Runtime；原宿主 dispose 后端口关闭。

模块插拔矩阵复跑 33/33：原生、stdio/TCP、工具白名单、技能关闭、Knowledge 关闭、服务断开/重连及组合。证据 `/var/folders/xd/mml9c6fj2g95x40hgf_n6lrr0000gn/T/sop-v4-modules-SgJ0q9/report.json`。该矩阵的外部 KM 是协议夹具，与下面真实 KM 结果分开。无关标题生成的不可达 fixture 日志不计业务成功。

## 真实业务与身份

真实模型 `deepseek-v4-flash-0731` 和 `qwen3.6-flash-distill`，无模型替身。源码 Web 组合 `/Users/a1/.local/share/pilotdeck/sop-km-v4-web-20261019/acceptance-aa475351.json` 在最终审批适配器改动后完整复跑通过：实际上传 12 个 UTF-8 发票文件，Agent 用 execute_code 批量 run_sop 并决定并发，12 个结果与合计 78 匹配；模型识别 Alice/Bob/Carol，串行及并行嵌套 subSOP、结果汇总、Bob 单项失败后显式 retry 均通过；检查实际模型请求证实各项输入隔离与两模型使用。owner 审批在全部服务停止重启后保持 callId/waitId，登录 JWT 恢复，重复请求不重复执行。模块接口实际返回 v4 ready=true，无 unavailable slot。batch `7afb466f132543108f8387e2339d1519`，approval `5d0846af0f3f4a1ebfe8324b9fed1e6d`。

自定义审批 `/Users/a1/.local/share/pilotdeck/sop-km-v4-complete-20261019/custom-approval-1792394232107/report.json` 通过：无用户数据库；无适配器预检拒绝、错误凭据拒绝、伪造 subject 拒绝、审批等待、宿主 PID 53817 -> 53825 后恢复原等待、幂等恢复和真实模型完成。此为宿主编程接口注入，不是企业 HTTP 审批系统。

真实 KM `/Users/a1/.local/share/pilotdeck/sop-km-v4-timing-final-20261019/km-acceptance-f0f2acce.json` 通过：认证服务实际导入文档、解析入库、模型查询、citation resolution，SOP 节点轨迹实际调用 knowledge_query 和 knowledge_resolve_citation，输出 deadlineDays=30/code=KM42。run `6b9b6f94686444ac9e1b676300258539`。从开始入库到首次真实查询/citation 完成 15.73 秒，单独统计，不计启动门槛。该实例没有 Web 或用户数据库。

## 拓扑与 Compose

`/Users/a1/.local/share/pilotdeck/sop-v4-topologies-complete-20261019/report.json` 三组通过：SOP-only 真实模型完成、KM-only 带服务认证创建知识库、外部 SOP+真实 KM 连接完成。全部无用户库；外部模式停止自己的 Gateway 后，外部 SOP/KM PID 仍相同。依赖安装使用独立 KM package 路径，不需要 SD 服务。

Compose 导出目录 `/Users/a1/.local/share/pilotdeck/sop-km-v4-compose-latest-20261019`，项目 `pd-v4-final`。PilotDeck、SOP v4、KM 三镜像实际构建和启动，独立持久卷；没有复制 SD 后端。最终审批适配器改动重建后，`v4-compose-acceptance.json` 再次通过真实模型入库、查询、citation、SOP 节点调用 KM，run `a9d36c7b6bfe4cb193a7ddfb9e52cbec`。脚本直接检查节点轨迹包含 knowledge_query、knowledge_resolve_citation 和 structured_output。全部 stop/up 后，再查询相同 run 完成状态及相同 chunk citation 成功。PilotDeck 健康检查等待 Web 与 Gateway，避免只看到 Web ready 就开始业务。

镜像构建使用本机已缓存 `node:22-bookworm-slim`，通过 build arg 替换默认 builder；本机 Docker build 代理不可达，单次构建清空 proxy build args 后通过。首次下载/安装/镜像构建与启动耗时分开。

## 启动门槛

环境为当前 macOS、Node 22.23.1、pnpm 10.32.1、Python 3.12；SOP+真实认证 KM+Gateway，无 Web。依赖和构建已准备，首次启动新数据库，加九次完整 stop/start。每轮包括服务协议、SOP 认证数据库、KM 初始化、Gateway SDK SOP 路由探测。总耗时从子进程启动命令发出到命令返回，包含控制器加载时间。

准备阶段另实际执行 `prepare --build --without-web`：总计 30.04 秒，其中 Python 安装 10.78 秒、Node 构建 16.87 秒，其余为 venv/配置准备；证据 `/Users/a1/.local/share/pilotdeck/sop-km-v4-prepare-build-20261019/prepare-timing.json`。已有 Node 依赖复用，不宣称全新系统安装；选定 headless 拓扑未构建 Web。

证据 `/Users/a1/.local/share/pilotdeck/sop-km-v4-timing-final-20261019/startup-benchmark.json`，10/10 <=10 秒，最大 2.099 秒、中位数 1.099 秒。首轮 SOP 0.547 秒、KM 1.252 秒、Gateway 2.032 秒、命令总计 2.099 秒；其余轮见 JSON。不是 OS 冷缓存测试，不承诺其他主机性能，也不包含模型响应。

## 重跑与边界

源码准备/启动命令与两套 YAML 见 [部署说明](SOP_V4_BACKEND.zh-CN.md)。使用新的部署目录，私有模型 YAML 只放本机。可重跑入口：

```sh
node scripts/benchmark-sop-v4-startup.mjs /absolute/prepared-stopped-combined
node scripts/accept-sop-v4-km.mjs /absolute/running-combined
node scripts/accept-sop-v4-approval.mjs /absolute/prepared-combined
node scripts/accept-sop-v4-topologies.mjs /absolute/stopped-combined /absolute/new-evidence /absolute/knowledge_core
node scripts/accept-sop-v4-source.mjs /absolute/running-web-combined
node scripts/accept-sop-v4-compose.mjs /absolute/exported-compose
```

Compose 脚本默认项目 `pd-v4-final`，可用 `COMPOSE_PROJECT_NAME` 覆盖；会停止重启该项目。批量/审批脚本会停止重启其源码实例。不要指向其他业务部署。

失败尝试保留在原部署目录：拓扑初次脚本用了错误的 `/bases` 路径，修正到 `/spaces`；另一次同时构建清空 dist 导致启动失败，按 build 后 start 重跑；早期进程身份探测在 exec 窗口误判退出，改为本次 PID 存活检查；Compose 初次重启先读 token，增加 Gateway 就绪检查。上述失败未计 PASS。

未验收公网生产域名/TLS、企业外部审批、真实支付核账、PDF/OCR、分布式多宿主。文件与股东任务是本地业务资料夹具，模型调用真实；没有互联网企业尽调。旧 parity 证据保留在原报告，不当作本轮真实 KM 证据。

交付时保留源码 Web `http://127.0.0.1:53591` 与 Compose Web `http://127.0.0.1:63681`；后者三个容器均 healthy。源码登录信息位于对应部署目录的私有 owner-login.json，报告不记录密码。headless 基准实例在十轮后额外启动进行真实业务，仍可按控制器 stop 停止；拓扑和自定义审批测试进程均已清理。

备份包含 SOP/KM SQLite、Pilot home、workspace、profile、私有 identity/model 配置；停止写入后备份。禁止 `down -v`。回退使用原版本及原数据目录。改动尚未提交/推送，部署目录含凭据与轨迹，不能整体加入版本库。

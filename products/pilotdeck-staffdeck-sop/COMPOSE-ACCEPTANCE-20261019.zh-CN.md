# 独立 KM / SOP Compose 本地验收记录

日期：2026-10-19。基线为 PR #660 的 `b436dddbf4575b938c20295dca59110f04b87a0e`，修复位于隔离分支 `codex/km-sop-compose-exporter`。本记录覆盖本地 Compose；不代表生产部署或整个 PR 的全面验收。

## 环境与构建

- Node.js 22.23.1、pnpm 10.32.1、Docker Desktop / Compose v2。
- 新版 profile：`native-five-independent.yaml`；KM 使用独立 `knowledge_core` 源码，SOP 使用仓库内 `packages/sop-runtime`。
- 独立 project：`pd-independent-export-1019`；入口：`http://127.0.0.1:3314`。
- 导出目录移动后，从移动后的目录构建并运行；Compose context、配置与源码均在导出目录内，不依赖原 checkout。
- 三个镜像均实际构建成功，PilotDeck 构建包含 TypeScript 与 Vite；KM 构建包含 UI、冻结的 Python 依赖与 wheel。
- 由于本机 Docker 注入了不可达代理，构建时显式清空 proxy build args；使用 `node:22-bookworm-slim` 作为宿主 builder。未修改全局 Docker 配置。

在完成导出并填入私有 `.env` 后，实际构建命令为：

```bash
docker compose -p pd-independent-export-1019 config --quiet
docker compose -p pd-independent-export-1019 build \
  --build-arg NODE_BUILDER_IMAGE=node:22-bookworm-slim \
  --build-arg HTTP_PROXY= --build-arg HTTPS_PROXY= --build-arg ALL_PROXY= \
  --build-arg http_proxy= --build-arg https_proxy= --build-arg all_proxy=
docker compose -p pd-independent-export-1019 up -d
```

## 结果

| 类别 | 结果与证据 |
| --- | --- |
| 三服务健康 | KM `/health/ready`、SOP `/healthz` 成功；两者在宿主启动前即可健康，初始化不依赖模型回调 |
| 模块一致性 | `/api/modules/runtime` 为 `knowledge-core/v1`、`sop.lifecycle/v3`，Gateway ready，`unavailableSlots=[]`；前端产物包含 knowledge-core 与 pilotdeck-sop 模块 |
| 正常身份 | 正常注册 owner，浏览器登录表单成功；构建期、运行期均启用登录，审批使用 owner JWT |
| KM 导入 | Markdown 经宿主 parse capability 导入，job succeeded，生成文档、bucket 和 chunk |
| 真实模型查询 | `deepseek-v4-flash-0731` 经宿主 capability 完成 document/bucket route；trace 有两类 model 调用且无 fallback，返回实际 chunk |
| Citation | resolve 返回原始文档片段，含验收标记 `COMPOSE-KM-SOP-1019` |
| 凭据边界 | KM 容器持有 service/capability bearer，不持有模型 key 或 PilotDeck API key；SOP 发布 token 与 owner 登录凭据分离 |
| SOP 发布与恢复 | 管理 API 发布 `compose_approval@1.0.0`；浏览器聊天启动、等待 owner handoff、回复恢复，最终 completed、revision 4 |
| 重试去重 | 同一 resume 请求重放返回 `duplicate=true`；continuation 对应的 accepted input 数量保持 1 |
| 重建恢复 | 三容器 force-recreate 后，账号登录、KM 数据/query/citation、SOP completed 状态、会话与去重结果保留 |
| 重启恢复 | `docker compose restart` 后再次验证上述数据与去重结果；浏览器重新登录后再次完成真实模型查询 |
| 浏览器 | 1440x1000 与 390x844 的 Knowledge、SOP、恢复会话页面检查通过，无 pageerror；截图检查未发现内容重叠 |
| 既有服务 | 原 3312 部署最终 `/health` 返回 200；既有 3301/3001 容器保留，未替换 |

三份命名卷分别为 `pilotdeck-home`、`knowledge-core-data`、`sop-runtime-data`，均属于独立 project。未执行 `down -v`。

## 聚焦检查

- Exporter：9/9，覆盖三服务、KM-only、SOP-only、已有镜像、外部 endpoint、缺失源码、路径转换与拒绝、生成 profile、Dockerfile 所需共享文件，以及旧协议回归。
- Knowledge composition / local runtime：12/12。
- UI server Knowledge / capability / native SOP 与审批组件：10/10。
- 本地 SOP launcher：1 通过、1 跳过；跳过的是需显式开启的源码安装测试，独立 Compose 镜像启动已另行实测。
- `docker compose config --quiet` 与 `git diff --check` 通过。

## 失败记录与边界

首轮 profile 缺少 `defaultSopId`，Web 可启动但 Gateway 未就绪，导致一次 KM parse capability 502。已增加必填校验并在新版 profile 设置默认 ID，重新导出、构建后完成全流程。该失败 job 保留在验收数据库及截图中；后续成功 job、真实查询与引用结果单独记录，未删除失败历史。

已有镜像、外部 endpoint 与旧协议的导出配置经过聚焦测试；本次未对这些模式的真实远程 release、网络和认证执行部署验收。未执行生产上线、生产域名验证或历史生产数据迁移，也未测试数据库版本升级迁移。默认完整 `node:22` builder 未完成下载，本次实际成功构建使用上述 slim override。

本机原始 JSON 与桌面/移动端截图保留在部署目录的 `acceptance.json`、`browser-acceptance.json`、`persistence-recreate.json`、`persistence-restart.json`、`final-browser.json`、`final-evidence/`。`.env` 与 owner 登录文件为私有本机配置，不应提交或作为共享证据发送；本记录不包含真实模型地址、key、token 或密码。

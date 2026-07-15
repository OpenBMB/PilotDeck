# og-pilotdeck-integration

Outline Graph (OG) Framework A 服务 + PilotDeck「记忆图谱」即插即用插件。

本仓库是一个**独立服务**：跑 FastAPI（端口 8000）提供 OG 图谱生成 + embed 页面，PilotDeck 通过插件包以 iframe 嵌入。PilotDeck 侧仅需 1 处通用改动（顶栏显示 plugin tabs）。

## 架构

```
PilotDeck (顶栏「记忆图谱」Tab = plugin:og-memory-graph)
        │ iframe
        ▼
og-pilotdeck-integration (FastAPI @ 8000)
  ├── /embed/memory-graph       ← iframe 加载的页面（frontend/）
  ├── /api/pd/*                 ← PilotDeck 专用 REST（init/sync/rebuild/status/graph）
  ├── /api/clusters/*/graph     ← 图谱 JSON
  ├── /api/clusters/*/reports   ← polished7 报告
  └── og run a (子进程)          ← Framework A pipeline：build→curate→balanced→polish
```

**插件包**（`plugins/og-memory-graph/`）部署到 `~/.pilotdeck/plugins/og-memory-graph/`：
- `server.js`：PilotDeck spawn 的 Node 进程，healthcheck og6 服务（已运行则复用，否则 spawn uvicorn），暴露 `/config`。
- `index.js`：前端 bundle，rpc 拿 og6 地址后渲染 iframe。

## 目录

```
og-pilotdeck-integration/
├── og/                    # Framework A
│   ├── agents/            # 19 个 LLM Agent（build/modify/propagate/render/rewrite…）
│   ├── core/              # OutlineGraph / OGNode / OGEdge
│   ├── pipeline/          # run_cluster / curate / balanced / polish / simulation
│   ├── storage/           # GraphStore / VectorStore(ChromaDB+BM25+rerank) / YamlStore
│   ├── config/            # paths / models / constants
│   ├── cli/               # python -m og run a（仅 Framework A）
│   └── mcp_server/        # MCP stdio 工具 + watcher(60s 轮询同步) + locks(跨进程互斥)
├── server/                # FastAPI（embed 页 + REST）
├── frontend/              # React embed 页（dist/ 已构建）
├── plugins/og-memory-graph/  # PilotDeck 插件包
├── plugin.json            # PilotDeck 插件清单（声明）
├── pyproject.toml
└── .env.template
```

## 安装

```bash
# 1. 安装 og 服务
cd og-pilotdeck-integration
pip install -e .
cp .env.template .env   # 填 API key

# 2. 构建前端（若 frontend/dist 缺失）
cd frontend && npm install && npm run build && cd ..

# 3. 部署插件包到 PilotDeck
cp -R plugins/og-memory-graph ~/.pilotdeck/plugins/
# 编辑 ~/.pilotdeck/plugins/og-memory-graph/config.json：og_root / python / port / model
```

## 运行

```bash
# 方式 A：手动起 og6 服务（开发）
uvicorn server.main:app --port 8000 --host 127.0.0.1

# 方式 B：由 PilotDeck 插件自动管理（生产）
# 启用 PilotDeck 插件后，server.js 自动 healthcheck/spawn og6
```

启动 PilotDeck → 顶栏出现「记忆图谱」Tab → 选中项目 → iframe 加载 og6 embed 页 → 自动 init cluster + 全量 build → 显示图谱/报告。

## 核心机制

- **同步与 PilotDeck memory 轮询对齐**：og6 服务启动时 `rebuild_watchers_from_clusters()` 为所有 `pd-*` cluster 注册 60s 轮询，检测 memory `.md` 变化即触发增量 `sync_changes`。PilotDeck 侧无需改动。
- **跨进程互斥**：`og/mcp_server/locks.py`（fcntl.flock + manifest pid）保证 init/sync/rebuild 不并发；pipeline pid 死亡时 `reap_if_dead` 自动推断终态。
- **5 次同步后自动重建**：累计 5 次实质性同步后置 `pending_rebuild`，下次 sync 改做全量 `rebuild`（清空历史 + vector DB，从当前 memory 重建），重置计数。
- **cluster_id**：`pd-{md5(workspace_path)[:8]}`，同一 project 路径稳定唯一。

## 配置

`og/config/models.py` 顶部可改 API key / 模型路由（优先级高于 `.env`）。默认：
- 主模型 `deepseek-v4-pro`，辅助/裁判 `deepseek-v4-flash`。

`~/.pilotdeck/plugins/og-memory-graph/config.json`：
```json
{ "og_root": "<本仓库路径>", "python": "<python 解释器>", "port": 8000, "model": "deepseek" }
```

# og-memory-graph 集成说明

本仓库在 PilotDeck 基础上集成了 **og-memory-graph**（Outline Graph 记忆图谱服务）作为即插即用插件。

## 改动概览

相对 upstream PilotDeck，本仓库的改动：

1. **`og-memory-graph/`**（新增子目录）：OG Framework A 服务 + PilotDeck 插件包。独立 Python FastAPI 服务，与 PilotDeck 主进程解耦。
2. **`ui/src/components/app-shell/MainAreaV2.tsx`**（唯一 PD 源码改动）：顶栏追加 enabled 插件的 Tab 渲染，让 `plugin:<name>` 能从顶栏进入。这是通用插件能力增强，不局限于 og-memory-graph。

> 其余 PilotDeck 源码均未修改。

## og-memory-graph 子目录

```
og-memory-graph/
├── og/                    # Framework A（agents/core/pipeline/storage/config/cli）
├── server/                # FastAPI（embed 页 + REST）
├── frontend/              # React embed 页（dist/ 已构建）
├── plugins/og-memory-graph/  # PilotDeck 插件包
│   ├── manifest.json
│   ├── config.json        # ← 部署时填写本机路径
│   ├── server.js          # Node：og6 生命周期 + /config
│   └── index.js           # 前端 bundle：rpc /config → 渲染 iframe
├── plugin.json
├── pyproject.toml
└── README.md
```

## 启用步骤

### 1. 安装 og-memory-graph 服务

```bash
cd og-memory-graph
pip install -e .
cp .env.template .env   # 填 API key（DeepSeek 等）
```

构建前端（若 frontend/dist 缺失）：
```bash
cd frontend && npm install && npm run build && cd ..
```

### 2. 部署插件包到 PilotDeck

```bash
cp -R plugins/og-memory-graph ~/.pilotdeck/plugins/
```

编辑 `~/.pilotdeck/plugins/og-memory-graph/config.json`，填本机路径：
```json
{
  "og_root": "<og-memory-graph 绝对路径>",
  "python": "<python 解释器绝对路径>",
  "port": 8000,
  "model": "deepseek"
}
```

### 3. 运行

启动 PilotDeck → 顶栏出现「记忆图谱」Tab → 选中项目 → 插件 server.js 自动 healthcheck og6 服务（已运行则复用，否则 spawn uvicorn）→ iframe 加载 embed 页 → 自动 init cluster + 全量 build → 显示图谱/报告。

## 机制

- **同步与 PilotDeck memory 轮询对齐**：og6 服务启动时为所有 `pd-*` cluster 注册 60s 轮询，检测 memory `.md` 变化即触发增量同步。PilotDeck 侧无需改动。
- **跨进程互斥**：fcntl.flock + manifest pid 保证 init/sync/rebuild 不并发。
- **5 次同步后自动重建**：累计 5 次实质性同步后下次改做全量 rebuild，重置基线。
- **cluster_id**：`pd-{md5(workspace_path)[:8]}`，同一 project 路径稳定唯一。

详见 `og-memory-graph/README.md`。

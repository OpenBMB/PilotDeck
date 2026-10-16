# PR #655 审查与修复验收

审查基线：`cf7fb5abc439e90dcc1d339bf7685441dc0f582c`。修复在独立 worktree
`/Users/a1/.codex/worktrees/review-pr-655/PilotDeck` 完成。

## 已修复的问题

| 问题 | 触发与影响 | 修复与回归 |
| --- | --- | --- |
| 恢复意图无法纠正 | Runtime 明确拒绝 resume 后，持久化 intent 仍阻止新命令 | 4xx（408 除外）释放 intent；网络、408、5xx 保留原命令恢复，覆盖重载 |
| 审批续跑相互阻塞 | 一个长模型调用占用全局 drain，后续会话审批不执行 | 按记录去重并发交付，持久化输入接受后结束交付等待；覆盖接受前后阻塞和重复 drain |
| 原生 host 接受不兼容配置 | pilotdeck host 配 legacy/v2，执行时缺少 Runtime | 配置加载时要求 lifecycle/v3 + sop-http-v3 |
| 子流程自身重试边损坏 | subflow 同时为边两端，展开留下已删除占位节点引用 | 将每个子终点连回子起点，保留条件和优先级；覆盖多个终点 |
| 生成终态续读挂起 | after_seq 已包含终态事件，SSE 永不结束 | 先补发事件，再按已读取任务终态关闭；回归先失败后通过，部署接口也实测关闭 |
| HTTP 验收依赖缺失文件 | PR 未带 StaffDeck 旁边的 conformance fixture | 仓库自带十项 fixture，从本仓库读取；源码和编译后测试均通过 |

## 聚焦验证

- 当前代码 `pnpm run build:web` 通过，含 SDK、memory、TypeScript 和 Vite 构建。
- 编译后恢复、审批 authority、AgentLoop、配置四个测试文件：120/120 通过。
- 独立真实 Python HTTP Runtime + TypeScript AgentLoop：1/1 通过，内部含十项 conformance、原生能力、子流程模型选择、等待、重复恢复和权威状态恢复。
- 托管 Python Runtime：2/2 通过，含首次安装、端口占用拒绝、持久化、重启、token 复用和退出释放端口。
- 队列、原生路由、生成 worker：13/13；启动 supervisor、交互绑定、审批 authority：17/17；原生前端审批与功能开关：8/8。
- 本仓库新增 Python nesting 回归：1/1；补充使用已有 StaffDeck portable_sop 五个独立测试文件，实际导入本 worktree 的 Python 包，共 41/41 通过。后者的测试源未复制入本 PR。
- `git diff --check` 通过。Vite 有既有大 chunk 警告；FastAPI TestClient 有依赖弃用警告。

定向命令使用 Node 22.23.1；Python 为 `/tmp/pilotdeck-pr655-review-venv/bin/python`。
HTTP 测试显式设置 `SOP_RUNTIME_PYTHON` 和本仓库 `packages/sop-runtime/src` 的 `SOP_RUNTIME_SOURCE`。
Vitest 从 `ui/node_modules/vitest/dist/node.js` 启动，排除 `dist/**`，前端测试加载仓库的 setup 与 React aliases。

## 本轮真实验收

独立目录 `/Users/a1/.local/share/sop-pr655-review-1016`，新数据库、新 owner、端口
28491/28493/28495，运行当前 worktree。复用私有模型配置，未更改旧部署的数据或服务。
模型为 `qwen3.6-flash-distill` 和 `deepseek-v4.1-flash`，浏览器为真实 Chrome headless。

| 浏览器场景 | 会话 | 结果 |
| --- | --- | --- |
| 1440px 高风险 | `web:s_8b624290-e385-481b-9126-e88b789f6692` | 完成，revision 11 |
| 1440px 低风险 | `web:s_206dda56-f93d-473c-bb25-b7af27657aae` | 完成，revision 11 |
| 390px 低风险 | `web:s_d3a7096d-f9c1-448d-b0ed-f0ee8a11e75e` | 完成，revision 11，无水平溢出 |
| 等待期间发布 1.0.1 并重启三服务 | `web:s_45f4bc7d-d700-47d4-9176-797b44b6ae3b` | 保持父/子 1.0.0，审批后完成，revision 11 |

真实覆盖：手动创建、模型生成、JSON 与名称编辑、普通及全屏节点模型选择、保存与发布、
信息收集、Skill 读取、文件读取和写入、动态分支、固定子流程、owner 人工审批、第二模型、
父流程完成、页面重载、重复 resume。四条 outbox 均 accepted，各有独立 run。
部署态另通过缺字段、缺 receipt、非法后继、错误节点/turn、未声明能力六项拒绝且状态不变，
以及 CAS 冲突与重复提交原结果重放。

原始报告、状态快照、输出文件和截图在上述独立目录的 `evidence/eight-1015`、
`evidence/restart-1016` 与 `project`。已人工查看桌面和移动端完成截图。
重启脚本仅重启本轮隔离 supervisor，未调用历史 LaunchAgent。

## 边界与收敛

已复查修复后的错误分类、原命令恢复、队列并发/去重、展开图和 SSE 终态竞态，当前没有新增可复现发现。
以上为本地真实验收，不代表生产部署、真实知识查询或 GitHub CI 全绿。
CI 诊断连接器要求登录 ChatGPT，未取得失败日志，未把历史红色 CI 声称为已解决。

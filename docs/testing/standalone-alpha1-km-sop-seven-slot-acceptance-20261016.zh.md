# standalone_alpha1 KM/SOP 与七槽插拔回归验收

日期：2026-10-17
主基线：`origin/standalone_alpha1` @ `b5cbfec8f2d63ae2e782297a71575d1c700b6bb6`
KM ref：`origin/standalone_alpha1_decouple_km_1013` @ `0f823db4c5b34a28394d0b54b039706c4f2a62ac`
SOP ref：`origin/standalone_alpha1_decouple_sop_1013` @ `a602283db6167771556a883f12ee660ffffd7e91`
七槽 ref：`origin/codex/frontend-seven-slot-composition` @ `3f1dbe9f129b5b5dedcbfd81facecde36f24ddd5`

## 执行边界

- 原工作区 `/Users/a1/Desktop/claw/openbmb/PilotDeck` 保持原样，未执行 pull、reset、merge 或代码修改。
- 测试 worktree：`/Users/a1/Desktop/claw/openbmb/PilotDeck-standalone-alpha1-test`，detached HEAD，初始状态干净。
- 运行时固定为 Node `v22.23.3`，仓库要求 `>=22.13.0 <23`；pnpm 固定为 `10.32.1`。构建和测试通过 `/tmp/pilotdeck-node22-bin` shim 确保嵌套脚本也不落到 Node 24 fallback。
- `corepack pnpm install --frozen-lockfile` 在隔离 worktree 成功完成，锁文件未修改。
- 所有产物和对拍输出写入 `/tmp` 或测试 worktree 产物目录，不提交临时数据库、截图或日志。

## 状态总览

| 区域 | 状态 | 证据 |
|---|---|---|
| 主分支包含 KM/SOP 合入 | PASS | `git merge-base --is-ancestor` 对两 ref 均通过 |
| TypeScript 核心编译 | PASS | `tsc -p tsconfig.json --pretty false`，exit 0 |
| KM/SOP/模块运行时聚焦套件 | PASS | 235/235，见下方命令 |
| AgentLoop parity trace 单测 | PASS | 56/56 |
| UI typecheck | PASS | `ui/tsconfig.json`，无错误输出 |
| UI Vite 构建 | PASS | `test-results/ui-dist/index.html` 与 `composition-modules.json` |
| 七槽静态生成 | PASS | 四 profile 构建矩阵通过；未选择的 SOP/KM 源不进入 Rollup graph，replacement 只保留 replacement 实现 |
| `frontend-g3-matrix` | PASS | 6/6 状态通过，Knowledge 使用 `knowledge-core` 命名 |
| 正式浏览器验收 | NOT RUN | formal 10 项、real-auth 3 项全部 skip，缺少 URL/profile/真实服务 |
| Gateway native/sidecar parity | PASS | Node 22 重跑的 53 场景轮次（`/tmp/pilotdeck-standalone-alpha1-parity-node22/summary.json`）`failed=[]`、`blocked=[]`、`oracleFailures=[]`；仅 3 个已声明并验证的 transport extension |

## 已通过的聚焦验证

执行：

```bash
node --test --test-force-exit --test-timeout 300000 \
  dist/tests/sop/staffdeck-sop-agent-loop.spec.js \
  dist/tests/sop/staffdeck-sop-client.spec.js \
  dist/tests/sop/staffdeck-sop-definitions.spec.js \
  dist/tests/pilot/config/modules-config.spec.js \
  dist/tests/composition/knowledge-public-read.spec.js \
  dist/tests/composition/citation-lifecycle-observation.spec.js \
  dist/tests/composition/knowledge-core.spec.js \
  dist/tests/composition/knowledge-core-operations.spec.js \
  dist/tests/composition/knowledge-modular.spec.js \
  dist/tests/composition/knowledge-agent.spec.js \
  dist/tests/composition/local-knowledge-runtime.spec.js \
  dist/tests/composition/http-module-runtime.spec.js \
  dist/tests/composition/limited-profile.spec.js \
  dist/tests/composition/runtime-ports.spec.js \
  dist/tests/composition/unknown-agent-loop-conformance.spec.js
```

结果 235/235 PASS，覆盖配置拒绝、Knowledge 全管理操作、权限/取消/超时/unknown outcome、Agent tool 投影、SOP 节点模型与 context、等待/审批/继续、重启恢复、重复 resume 幂等、版本快照和 SIGKILL 后可见回复重放。

`python3 -m unittest discover -s tools/agent-loop-parity -p 'test_trace.py'` 结果 56/56 PASS。

Node 22 重跑同一套 KM/SOP/模块测试为 235/235 PASS；SOP HTTP E2E 为 4 PASS、7 SKIP（缺少真实 StaffDeck 服务）。UI typecheck、根构建、UI Vite build 和组合单测（3/3）均通过。

## 七槽插拔结果

- 直接生成最小 profile：只生成必需核心槽和通用管理模块，未引入 SOP/Knowledge 业务 import。
- 直接生成 `native-five-staffdeck.yaml`：生成 `staffdeck-sop` 与 `knowledge-core`，并保留独立 slot、contract、transport 和方法声明。
`frontend-build-matrix.mjs` 在 Node 22/pnpm 10 下四 profile 全部 PASS，证据目录为 `/tmp/fbm-final`；运行时不再通过静态 import 把未选择的 SOP/KM 实现重新带入 bundle。

## Gateway parity

最终 Node 22 隔离全量证据：`/tmp/pilotdeck-standalone-alpha1-parity-node22/summary.json`。旧的 `/tmp/pilotdeck-alpha1-complete-d/summary.json` 使用共享 runtime root，不能作为完成证据。聚焦修复复跑证据：`/tmp/pd-cancel-fix/summary.json`、`/tmp/pd-full-fix2/summary.json`、`/tmp/pd-proj-fix2/summary.json`。

预算终态文本已在 sidecar `agent_status` 投影中保留完整用户可见错误；continuable follow-up 的 host-control 插入顺序按审查后的状态集合做位置独立比较，事件值、数量、模型请求、工具结果、终态和 sidecar evidence 仍严格比较。隔离 harness 已确保 native/sidecar 不共享 transcript、session 或 operation ledger。`cancel_during_tool` 已补齐取消后的 `tool.finish/tool.result`；两类 request-level compaction budget 已统一 provider-visible cwd 并通过 token/ratio 严格比较。全量结果无未解释 semantic FAIL。

残留的是 adapter/运行调度造成的 format warnings，不构成 semantic difference；sidecar 的 `transport_selected`、`handshake_completed`、`module_call_received` 证据仍由每个场景校验。

结论：format warnings 仅为 transport envelope/序列化差异；53 个场景无 semantic FAIL，七槽 Gateway 对拍达到本轮自动化门槛。

## 真实浏览器与持久化闭环

`formal-composition.config.mjs` 的 10 项和 `real-auth-composition.config.mjs` 的 3 项均被测试框架识别，但全部 skipped：

- formal 需要 `FORMAL_COMPOSITION_URL`，并依赖真实 Web + StaffDeck 部署；
- real-auth 需要 `REAL_COMPOSITION_URL`、`REAL_COMPOSITION_PROFILE` 和认证/服务 fixture；
- 本轮没有伪造 URL、认证或服务端状态，因此 KM 导入/异步任务/刷新回读/引用定位和 SOP 编辑发布/重载/审批真实闭环均为 NOT RUN。

## 未完成边界

1. 提供真实 StaffDeck/KM/SOP 服务、认证 profile 和浏览器 URL，再执行 formal/real-auth 套件，补齐真实持久化与 AgentLoop 运行证据。

当前自动化验收状态：**PASS（自动化边界内）**。KM/SOP 聚焦、七槽静态插拔与 Gateway 53 场景隔离对拍均通过；真实浏览器闭环、真实 StaffDeck 服务和部署对拍为 **NOT RUN/BLOCKED**，因此不报告整体生产端到端完成。

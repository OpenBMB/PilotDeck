# StaffDeck 跨宿主红线回归（2026-09-20）

## 范围与基线

本报告覆盖 StaffDeck legacy Harness 与 PilotDeck production stdio sidecar 的
已收口红线。它记录本轮全矩阵中仍未验收的 fixture/oracle 项，不将其标作 PASS。

| 项目 | 固定值 |
| --- | --- |
| PilotDeck 本轮起始提交 | `1d222bc313fcb7ebe57fc93e35ac13dc655ff3a5` |
| PilotDeck 产品基线 | `origin/main` `cd52c9af812a84c27a9dd1b7ccf246f48540045f` |
| PilotDeck 分支 | `codex/integrate-sdk-0901` |
| Node | `v22.23.1` |

## 行为契约

| 场景 | legacy 与 sidecar 的契约 | owner | 结果 |
| --- | --- | --- | --- |
| `max_turns` | terminal 为 `action_budget`，code/stop reason 均为 `ACTION_BUDGET_EXHAUSTED`/`action_budget`，不泛化为 `HARNESS_V2_ERROR` | StaffDeck Harness result 与 PilotDeck host glue | PASS |
| `sop_blocked_transition` | terminal 为 `blocked`，保留用户可见 blocked message；无 tool side effect | StaffDeck SOP TaskFrame | PASS |
| `sop_multi_action_budget` | 两个真实 capability 调用后进入 `action_budget`；tool history、error code、final message 一致 | StaffDeck capability bridge；sidecar 只经 canonical module calls | PASS |
| `sidecar_restart_before_effect` | host dispatcher 在 effect acknowledgement 前围栏该 operation，terminal 为 `result_unknown`/`RESULT_UNKNOWN`；不继续模型循环，不产生 effect | PilotDeck canonical sidecar terminal；StaffDeck bridge/invocation durable record | PASS（host-fence） |
| `sidecar_restart_after_effect` | host dispatcher 在 effect acknowledgement 后围栏该 operation，terminal 为 `result_unknown`/`RESULT_UNKNOWN`；effect 恰好一次 | 同上 | PASS（host-fence） |
| `sop_unknown_requeue` | SOP frame 保持待协调状态；最终消息、`RESULT_UNKNOWN`、权限和一次 effect 一致 | StaffDeck TaskFrame/invocation owner | PASS |
| `sop_knowledge_budget_exhausted` | 第三次 knowledge search 在 host bridge 拒绝；终态准确保留 `KNOWLEDGE_SEARCH_BUDGET_EXHAUSTED`，无第三次外部 tool execution | StaffDeck Harness/bridge/checkpoint | PASS |
| `sop_task_dependency` | child TaskFrame 只在 durable prerequisite 完成后运行，并收到前置 capability result | StaffDeck TaskFrame store | PASS |
| `sop_scheduled_task` | 已固定 snapshot 只在可见 SOP 上应用；trace 记录实际应用版本 `7` | StaffDeck Harness scheduled snapshot | PASS |
| `sop_step_advance` | provider 按当前 SOP step 发出 `collect -> review`；两条路径执行 review 后完成 | StaffDeck Harness/SOP state owner | PASS |
| `sop_conditional_transition` | provider 在 check 节点选择 `branch_a`；两条路径执行分支后完成 | StaffDeck Harness/SOP state owner | PASS |
| `sop_team_task` | TL 只通过可信 roster 选择成员；两条路径均持久化一个 `TeamRun`、一个 `pending` TeamTask 和一个 pending wake，assignee 为 roster 中的 member | StaffDeck Team/TeamRun/TeamTask/wake owner；sidecar 只经 canonical host modules | PASS |
| built TCP child restart after host effect | production deployment profile 启动的 child 在 host effect 已提交、capability acknowledgement 未写回时退出；替代 child 完成新 handshake，旧 operation durable terminal 为 `result_unknown`，无第二次 tool execution 或可见成功 | Session operation ledger 与 host capability dispatcher；TCP child 不拥有 effect | PASS（fail-closed） |

`PilotDeckAgentLoopClient` 仅把 sidecar 的 canonical module failure 和 capability
exchange 投影回 StaffDeck-owned `TaskExecutionResult`。显式 `RESULT_UNKNOWN` 不得被
AgentLoop 降级成可恢复 tool error；StaffDeck 将该结果持久化为 `outcome_unknown`，避免重放
外部 effect。Router、permission、tool policy、TaskFrame persistence owner、dispose owner
和 Module Protocol 2.0 均未改变。

## 验证

```sh
env -u NODE_OPTIONS PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH \
  backend/.venv/bin/python tools/agent-loop-parity/run.py \
  --pair staffdeck --scenario max_turns --comparison same-version ...

env -u NODE_OPTIONS PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH \
  backend/.venv/bin/python tools/agent-loop-parity/run.py \
  --pair staffdeck --scenario sop_blocked_transition --comparison same-version ...

env -u NODE_OPTIONS PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH \
  backend/.venv/bin/python tools/agent-loop-parity/run.py \
  --pair staffdeck --scenario sop_multi_action_budget --comparison same-version ...
```

三条命令均为 `failed=[]`、`blocked=[]`、`oracleFailures=[]`。下面两条命令验证的是
host dispatcher 围栏导致的 unknown-outcome，不是 sidecar 进程终止、重新握手和 durable ledger
reconciliation；两条命令同样为 `failed=[]`、`blocked=[]`、`oracleFailures=[]`：

```sh
env -u NODE_OPTIONS PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH \
  backend/.venv/bin/python tools/agent-loop-parity/run.py \
  --pair staffdeck --scenario sidecar_restart_before_effect ...

env -u NODE_OPTIONS PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH \
  backend/.venv/bin/python tools/agent-loop-parity/run.py \
  --pair staffdeck --scenario sidecar_restart_after_effect ...

env -u NODE_OPTIONS PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH \
  backend/.venv/bin/python tools/agent-loop-parity/run.py \
  --pair staffdeck --scenario sop_unknown_requeue ...
```

在当前提交上，以下三条目标场景已分别重跑，均为
`failed=[]`、`blocked=[]`、`oracleFailures=[]`：

```sh
env -u NODE_OPTIONS PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH \
  backend/.venv/bin/python tools/agent-loop-parity/run.py \
  --pair staffdeck --comparison same-version --scenario max_turns \
  --pilotdeck-root /Users/a1/Desktop/claw/openbmb/PilotDeck-sdk-core-integration \
  --staffdeck-root /Users/a1/Desktop/claw/openbmb/StaffDeck-pilotdeck-agent-loop \
  --output /tmp/pilotdeck-sdk-core-max-turns-v45-20260920
```

对应 `sop_blocked_transition` 与 `sop_multi_action_budget` 产物为
`/tmp/pilotdeck-sdk-core-sop-blocked-v45-20260920/` 和
`/tmp/pilotdeck-sdk-core-sop-budget-v45-20260920/`。

Raw traces:

- `/tmp/pilotdeck-sdk-core-goal-max-turns-20260920/`
- `/tmp/pilotdeck-sdk-core-goal-sop-blocked-20260920/`
- `/tmp/pilotdeck-sdk-core-goal-sop-budget-20260920/`
- `/tmp/pilotdeck-sdk-core-restart-before-v18-20260920/`
- `/tmp/pilotdeck-sdk-core-restart-after-v18-20260920/`
- `/tmp/pilotdeck-sdk-core-sop-unknown-v19-20260920/`
- `/tmp/pilotdeck-sdk-core-knowledge-budget-v28-20260920/`
- `/tmp/pilotdeck-sdk-core-sop-dependency-v34-20260920/`
- `/tmp/pilotdeck-sdk-core-sop-scheduled-v32-20260920/`
- `/tmp/pilotdeck-sdk-core-sop-slots-v36-20260920/`
- `/tmp/pilotdeck-sdk-core-sop-step-v39-20260920/`
- `/tmp/pilotdeck-sdk-core-sop-conditional-v40-20260920/`

附加验证：PilotDeck Node `v22.23.1` 下 `pnpm build` 通过，
`capability-tool-port.spec.ts` 与 `sidecar.spec.ts` 为 `30/30`；StaffDeck
`test_harness_v2.py` 与 `test_pilotdeck_agent_loop_client.py` 为 `110` passed；trace tests
为 `9` passed；两个工作区 `git diff --check` 通过。

补充 transport 证据：

```sh
env -u NODE_OPTIONS PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH \
  pnpm exec tsx --test \
  tests/agent/modules/sidecar-client.spec.ts \
  tests/agent/modules/tcp-sidecar-transport.spec.ts
```

结果 `59/59`。其中 built stdio CLI 测试证明正式 child、handshake 与 host model/tool
dispatcher；built TCP CLI 测试证明正式 child 的 Protocol `2.0` handshake。TCP restart
测试证明新 module instance 后 host ledger 记录 `result_unknown`、reconcile 已知 terminal，且
`execute` 不重放。stdio 的 one-turn/one-child 边界不提供同一 stream 的 reconnect，因此它的
进程中断契约是 fail-closed `result_unknown`，而非伪造 generation resume。

本轮新增 built-child evidence 由同一命令中的
`built TCP sidecar restart after a host effect fails closed without replaying it` 提供：它使用
正式 `AgentLoopDeploymentProfile`、built CLI child、host model/capability dispatcher 和
session transcript ledger。在 capability response 尚未写回时终止 child，启动替代 child 并完成
新的 TCP handshake。断言 effect 与 capability dispatch 均为一次，operation terminal 为
`result_unknown`，且观察到 `result_unknown_fail_closed`。默认 production manifest 不宣称跨实例
resume，因此该场景不把未知 effect 伪装为已完成或重放给替代 child。

固定 main 对拍补充命令：

```sh
env -u NODE_OPTIONS PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH \
  backend/.venv/bin/python tools/agent-loop-parity/run.py \
  --pair pilotdeck --comparison baseline \
  --pilotdeck-root /Users/a1/Desktop/claw/openbmb/PilotDeck-sdk-core-integration \
  --staffdeck-root /Users/a1/Desktop/claw/openbmb/StaffDeck-pilotdeck-agent-loop \
  --output /tmp/pilotdeck-sdk-core-pilotdeck-baseline-v44-20260920
```

`v44` 的 33 个 PilotDeck 场景没有 `failed`、`blocked` 或 oracle failure。固定 main 缺失的
seed-state projection 已由 parity adapter 在 adapter 边界映射到 main 的公开
`AgentLoopSeedState` 形状；该映射不进入 PilotDeck 产品代码。

生产部署补充命令：

```sh
env -u NODE_OPTIONS PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH \
  backend/.venv/bin/python tools/real-deployment-e2e.py \
  --staffdeck-root /Users/a1/Desktop/claw/openbmb/StaffDeck-pilotdeck-agent-loop \
  --pilotdeck-root /Users/a1/Desktop/claw/openbmb/PilotDeck-sdk-core-integration
```

产物 `/var/folders/xd/mml9c6fj2g95x40hgf_n6lrr0000gn/T/staffdeck-e2e-kqn8gkex/REAL_DEPLOYMENT_E2E.zh.md`
为 `PASS`：正式 Gateway 的 `hello_ok`/Protocol `1.1`、StaffDeck Web proxy、多 turn、并发、
handoff/reply/resume、scheduled worker 和 Team roster/TeamRun/member worker 均通过；
`coverageGaps=[]`。数据库记录 1 个 team、1 个 team task、6 个 team task event，终态为
`review`，证明生产 sidecar 路径已经执行真实 team worker，而不是 parity adapter 的伪造路径。

最新 StaffDeck workflow same-version matrix：

```sh
env -u NODE_OPTIONS PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH \
  backend/.venv/bin/python tools/agent-loop-parity/run.py \
  --pair staffdeck --comparison same-version --suite staffdeck-workflow \
  --pilotdeck-root /Users/a1/Desktop/claw/openbmb/PilotDeck-sdk-core-integration \
  --staffdeck-root /Users/a1/Desktop/claw/openbmb/StaffDeck-pilotdeck-agent-loop \
  --output /tmp/pilotdeck-sdk-core-staffdeck-workflow-v50-20260920
```

该产物的 `24` 个场景为 `failed=[]`、`blocked=[]`、`oracleFailures=[]`。其中
`sop_team_task` 不再是双方共同 oracle failure：fixture 建立了真实的 `Team`、leader/member
`TeamMember`、TL `ChatSession`，并严格比较 TeamRun、TeamTask 和 wake 的 durable state。

## 限制

最新同版本全量产物为 `/tmp/pilotdeck-sdk-core-full-parity-v51-20260920/summary.json`：`62` 场景、
`failed=[]`、`blocked=[]`、`oracleFailures=[]`；历史的 `sop_team_task` oracle failure 已由上面的
`v50` workflow matrix 取代。deadline 两项仅保留已枚举的精确内部时序差异。

未验收范围仍明确保留，不计入 PASS：

- PilotDeck main 对拍：`/tmp/pilotdeck-sdk-core-pilotdeck-baseline-v44-20260920/summary.json`
  不再有 adapter `BLOCKED`。`plan_mode_host_policy` 和
  `plan_mode_bypass_host_policy` 是固定 main 的已确认缺陷：main 在成功的
  `exit_plan_mode` 后仍把第四轮留在 `plan`，再度拒绝 `parity_write_probe`；current 在该点
  恢复 `default` 或 `bypassPermissions`，得到一次批准和一次副作用，符合场景的公开
  `policyModes` / `sideEffectCount: 1` 契约。该差异涉及 permission、tool execution 和最终
  用户可见结果，按红线不能列为已验收的精确差异；它保持原始 raw trace 与失败对照，等待明确
  产品决策，未使用 normalization 或白名单掩盖。
- 跨进程 effect 的成功 reconciliation：本轮已证明 production TCP child crash 后的 exactly-once
  fail-closed terminal；没有具体产品 tool/provider 的 idempotency/status-query owner 时，不虚构
  “已知完成”状态查询。此 provider-specific success reconciliation 保持 unsupported，不计为 PASS。
- 原有 `SKIPPED_NOT_APPLICABLE` 仍以精确能力边界保留；特别是
  `unsupported_capability` 没有被删除、扩展 normalize 或改写为 PASS。

因此本报告不声称全量验收完成，也不将上述范围归为 PASS。

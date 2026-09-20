# StaffDeck 跨宿主红线回归（2026-09-20）

## 范围与基线

本报告覆盖 StaffDeck legacy Harness 与 PilotDeck production stdio sidecar 的
已收口红线。它记录本轮全矩阵中仍未验收的 fixture/oracle 项，不将其标作 PASS。

| 项目 | 固定值 |
| --- | --- |
| PilotDeck 当前提交 | `59169a6bd875d470a977d28c9bb43e98e37e8b94` |
| PilotDeck 产品基线 | `origin/main` `cd52c9af812a84c27a9dd1b7ccf246f48540045f` |
| PilotDeck 分支 | `codex/integrate-sdk-0901` |
| Node | `v22.23.1` |

## 行为契约

| 场景 | legacy 与 sidecar 的契约 | owner | 结果 |
| --- | --- | --- | --- |
| `max_turns` | terminal 为 `action_budget`，code/stop reason 均为 `ACTION_BUDGET_EXHAUSTED`/`action_budget`，不泛化为 `HARNESS_V2_ERROR` | StaffDeck Harness result 与 PilotDeck host glue | PASS |
| `sop_blocked_transition` | terminal 为 `blocked`，保留用户可见 blocked message；无 tool side effect | StaffDeck SOP TaskFrame | PASS |
| `sop_multi_action_budget` | 两个真实 capability 调用后进入 `action_budget`；tool history、error code、final message 一致 | StaffDeck capability bridge；sidecar 只经 canonical module calls | PASS |
| `sidecar_restart_before_effect` | host 在 effect acknowledgement 前失联，terminal 为 `result_unknown`/`RESULT_UNKNOWN`；不继续模型循环，不产生 effect | PilotDeck canonical sidecar terminal；StaffDeck bridge/invocation durable record | PASS |
| `sidecar_restart_after_effect` | host 在 effect acknowledgement 后失联，terminal 为 `result_unknown`/`RESULT_UNKNOWN`；effect 恰好一次 | 同上 | PASS |
| `sop_unknown_requeue` | SOP frame 保持待协调状态；最终消息、`RESULT_UNKNOWN`、权限和一次 effect 一致 | StaffDeck TaskFrame/invocation owner | PASS |

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

三条命令均为 `failed=[]`、`blocked=[]`、`oracleFailures=[]`。本轮 restart/reconciliation
命令也均为 `failed=[]`、`blocked=[]`、`oracleFailures=[]`：

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

Raw traces:

- `/tmp/pilotdeck-sdk-core-goal-max-turns-20260920/`
- `/tmp/pilotdeck-sdk-core-goal-sop-blocked-20260920/`
- `/tmp/pilotdeck-sdk-core-goal-sop-budget-20260920/`
- `/tmp/pilotdeck-sdk-core-restart-before-v18-20260920/`
- `/tmp/pilotdeck-sdk-core-restart-after-v18-20260920/`
- `/tmp/pilotdeck-sdk-core-sop-unknown-v19-20260920/`

附加验证：PilotDeck Node `v22.23.1` 下 `pnpm build` 通过，
`capability-tool-port.spec.ts` 与 `sidecar.spec.ts` 为 `30/30`；StaffDeck
`test_harness_v2.py` 与 `test_pilotdeck_agent_loop_client.py` 为 `110` passed；trace tests
为 `9` passed；两个工作区 `git diff --check` 通过。

## 限制

全量产物为 `/tmp/pilotdeck-sdk-core-full-parity-v19-20260920/summary.json`：`62` 场景、
`blocked=[]`。其中 restart/reconciliation 已不再出现 semantic diff 或 oracle failure。

未验收范围仍明确保留，不计入 PASS：

- `cancel`、`cancel_late_completed`：sidecar 在取消获胜前可观察到一次无 tool 的 model
  request/response；legacy 在此之前取消。两端 final message 都是“已停止生成”，无 tool
  execution、permission decision 或 side effect。按本轮红线这是已声明的内部时序差异。
- 两端共同 oracle failure：SOP active step/slot/knowledge budget/dependency/team/scheduled
  fixture projection。这些不是 legacy/sidecar 差异的证据，仍须独立修正 fixture 或产品契约。
- 原有 `SKIPPED_NOT_APPLICABLE` 仍以精确能力边界保留；特别是
  `unsupported_capability` 没有被删除、扩展 normalize 或改写为 PASS。

因此本报告不声称全量验收完成，也不将上述范围归为 PASS。

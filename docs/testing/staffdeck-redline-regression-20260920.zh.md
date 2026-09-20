# StaffDeck 跨宿主红线回归（2026-09-20）

## 范围与基线

本报告只覆盖 StaffDeck legacy Harness 与 PilotDeck production stdio sidecar 的
`max_turns`、`sop_blocked_transition`、`sop_multi_action_budget` 红线收口，不能替代
SDK/Core 全矩阵验收报告。

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

`PilotDeckAgentLoopClient` 仅把 sidecar 的 canonical module failure 和 capability
exchange 投影回 StaffDeck-owned `TaskExecutionResult`。Router、permission、tool policy、
TaskFrame persistence、dispose owner 和 Module Protocol 2.0 均未改变。

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

三条命令均为 `failed=[]`、`blocked=[]`、`oracleFailures=[]`。Raw traces:

- `/tmp/pilotdeck-sdk-core-goal-max-turns-20260920/`
- `/tmp/pilotdeck-sdk-core-goal-sop-blocked-20260920/`
- `/tmp/pilotdeck-sdk-core-goal-sop-budget-20260920/`

附加验证：PilotDeck `pnpm build`、`tests/agent/modules/sidecar.spec.ts` 为 `16/16`；
StaffDeck `test_pilotdeck_agent_loop_client.py`、`test_harness_v2.py`、
`test_agent_loop_parity.py` 为 `132` passed；trace tests 为 `8` passed；两个工作区
`git diff --check` 通过。

## 限制

这份子集报告不声称 full matrix 已验收。`sidecar_restart_*`、SOP lifecycle
projection、team/scheduled 和外部 provider/deployment 覆盖仍须由全量矩阵独立验收；它们
既不被归为 PASS，也没有加入 normalization 或 allowlist。

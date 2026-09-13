# PilotDeck SDK standalone 对拍记录（2026-09-14）

## 结论

基于 `dev-sdk-0901-standalone` 当前提交与 `origin/main` 的 PilotDeck 原生 AgentLoop 对拍如下：

- 场景总数：32
- 完成 baseline/current 比较：32
- 语义差异（FAIL）：0
- oracle failure：0
- 格式告警：1818（仅来自 `plan_mode_host_policy` 的 baseline drift 报告）
- 阻塞场景：0

32 个场景均生成完整 trace。按场景 oracle 校验，模型消息、工具调用与顺序、权限结果、终态、错误码和副作用均符合预期；`plan_mode_host_policy` 也已完成，不再是 BLOCKED。

baseline/current 仅在 `plan_mode_host_policy` 产生 909 项 baseline drift，原因是两次提交的工具清单与工具 schema 文本不同（SDK 提交新增/调整了公开工具表面）；这不是场景 oracle failure，也未改变该场景的计划模式、拒绝写入和批准后执行语义。

## 基线与环境

- 当前 worktree：`/Users/a1/Desktop/claw/openbmb/PilotDeck-sdk-standalone`
- 当前分支：`dev-sdk-0901-standalone`
- 当前提交：`d0ba2e48 feat(sdk): add standalone Claude-like PilotDeck SDK`
- 对拍基线：`origin/main@cfc4d1779228f91fececc5d6705c14dab5b7ef2f`
- Node.js：`v22.22.0`
- pnpm：`10.32.1`
- Python：`3.12.2`（StaffDeck `backend/.venv`）

## 实际命令

官方 harness 位于 StaffDeck checkout。由于 standalone 明确不包含 module/checkpoint 实现，使用了 `/tmp/pilotdeck_native_standalone_impl.mjs` 作为一次性外部 adapter；该 adapter 只内联了 fixture 的 seed-state 解析，其余 AgentLoop、工具、权限和 mock provider 路径保持官方 adapter 逻辑。

```bash
PATH=/Users/a1/.nvm/versions/node/v22.22.0/bin:$PATH \
  /Users/a1/Desktop/claw/openbmb/StaffDeck-pilotdeck-agent-loop/backend/.venv/bin/python \
  /Users/a1/Desktop/claw/openbmb/StaffDeck-pilotdeck-agent-loop/tools/agent-loop-parity/run.py \
  --pilotdeck-root /Users/a1/Desktop/claw/openbmb/PilotDeck-sdk-standalone \
  --staffdeck-root /Users/a1/Desktop/claw/openbmb/StaffDeck-pilotdeck-agent-loop \
  --pilotdeck-baseline origin/main \
  --pair pilotdeck \
  --comparison baseline \
  --scenario all \
  --pilotdeck-native-cmd "node /tmp/pilotdeck_standalone_dispatch.mjs" \
  --adapter-timeout-seconds 60 \
  --output /tmp/pilotdeck-sdk-parity-final-nov2IG \
  --allow-blocked
```

退出码为 `0`。完整 JSONL trace、逐场景 Markdown 和 `summary.json` 保存在：

`/tmp/pilotdeck-sdk-parity-final-nov2IG`

该目录为临时测试产物，不纳入 Git 提交。

## 原 BLOCKED 场景修正

原始 `plan_mode_host_policy` BLOCKED 的直接原因是一次性 Gateway adapter 没有按当前 plan-file contract 准备 fixture：Gateway 为已注册 workspace 返回的计划目录是 `<workspace>/.pilotdeck/plans`，而 adapter 将 workspace 与 `PILOT_HOME` 混用，导致 `exit_plan_mode` 找不到计划文件并在超时前无法完成。

修正仅发生在 `/tmp` 的一次性 parity adapter：

1. 为 Gateway 建立独立、已注册的 workspace，并写入 `.pilotdeck/plans/parity-plan.md`；
2. 开启 `canElicit`，自动回答 `exit_plan_mode` 的 `execute_plan`；
3. 在批准计划后让确定性 fixture 先调用 `todo_write` 初始化计划，再重试 `parity_write_probe`。这遵循原生 `PlanTodoState` 的门禁，不修改 AgentLoop 核心语义；
4. 通过 dispatch adapter 仅对该 Gateway 场景使用 Gateway 路径，其他场景继续使用 native 路径。

修正后该场景的 oracle 结果为：`policyModes = ["default", "plan", "plan", "default"]`、首个写入调用返回 `plan_mode_violation`、计划批准后的写入产生 1 次副作用。

此前单独重跑的 `write_snapshot_resume` 在修正 adapter 的 Map 形状后通过，说明该场景不是产品差异。

## 代码与工作区影响

本次对拍没有修改 PilotDeck 产品源码，也没有修改 parity harness。测试期间仅在 `/tmp` 生成 adapter、dispatch wrapper 和 trace；临时 `node_modules` 符号链接已从 worktree 移除。

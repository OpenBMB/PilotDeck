# Background Task TRD

状态：评审中　维护者：Runtime 团队　目标读者：后端、CLI 和测试维护者

## 代码边界

本 TRD 定义 `src/task/runtime/BackgroundTaskRuntime.ts` 与 `src/task/storage/TaskOutputStore.ts` 的后台进程任务边界。它不定义 AgentLoop 的前台工具调用，也不替代 Gateway 的 turn 生命周期。

## 核心契约

- `start` 必须创建唯一 task ID、记录 session/agent 归属并立即返回可查询状态。
- `list/get/output/wait/stop` 必须对未知 task 返回明确的空结果或错误，不得伪造完成。
- 任务达到并发上限时必须拒绝新任务；子进程退出只能产生一次 completion。
- 输出读取按 offset 单调推进，环形缓冲淘汰必须显式返回 `truncated`，磁盘 spill 失败不得使 runtime 崩溃。
- 本地命令通过共享 shell resolver 启动：Unix 优先 `/bin/bash`，缺失时回退 `/bin/sh`；Windows 优先 Git Bash，缺失时依次回退 `cmd.exe`、PowerShell 7 (`pwsh.exe`)，不使用 Windows PowerShell 5。可用 `PILOTDECK_SHELL_PATH` 显式指定 shell；Windows 非标准 Git Bash 路径可用 `PILOTDECK_GIT_BASH_PATH`。

## 流程与恢复

正常流程为 `created -> running -> completed|failed`。`stop` 先发 graceful signal，超过 grace period 后强制终止并进入 `cancelled`。等待支持 timeout 和 AbortSignal，二者都必须释放监听器。进程重启后的持久化恢复属于延期能力，不得把内存 registry 写成可恢复。

## 测试与证据

源码映射：`src/task/runtime/BackgroundTaskRuntime.ts`、`src/task/storage/TaskOutputStore.ts`、`src/task/protocol/types.ts`。测试映射：`tests/task/background-task-runtime.spec.ts`、`tests/task/task-output-store.spec.ts`、`tests/tool/session-tools-display.spec.ts`。runtime/store 的确定性行覆盖已纳入 `pnpm test:coverage`；测试使用 fake child、受控 stream 和临时 spill 目录，真实 shell 归 `DEFER_EXTERNAL`。CI 归属：根 Node deterministic gate。

## 验收与变更

验收覆盖并发上限、输出截断、spill、完成回调、stop、wait abort 和重复 stop。证据状态：`CURRENT_ONLY`，当前模块行覆盖率门槛已通过；timeout escalation、mutation proof 和 built artifact smoke 仍待补齐。

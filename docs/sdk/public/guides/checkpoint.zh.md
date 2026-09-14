# Checkpoint 与 Rewind

## 适用场景

需要撤销某个已接受 turn 对工作区文件的修改时使用 checkpoint。它是 Gateway/Native 持有的文件历史，不是 SDK 本地缓存。

## 推荐流程

```ts
const preview = await run.rewindFiles(userMessageId, { dryRun: true });
if (preview.conflicts?.length) throw new Error("工作区已被外部修改");
const restored = await run.rewindFiles(userMessageId, { dryRun: false });
console.log(restored);
```

先 `dryRun`，确认 diff 和冲突为空后再执行恢复。`seedReadState(path, mtime)` 只在 mtime 一致时写入原生 read state，不能绕过 workspace 或 freshness 校验；后续 edit 仍需重新 read。

## 边界

- Gateway 重启可以恢复已持久化 checkpoint，不能恢复旧 AgentLoop 或 active tool promise。
- 外部文件 mtime/content 与 checkpoint 不一致时拒绝覆盖，调用方应重新读取并创建新 turn。
- `close()` 不会回滚文件；取消 run 也不等于恢复 checkpoint。

详见 [Sessions、Runs 和恢复](../concepts/sessions-and-runs.zh.md)、[TypeScript Reference](../reference/typescript.zh.md) 和 [Errors](../reference/errors.zh.md)。

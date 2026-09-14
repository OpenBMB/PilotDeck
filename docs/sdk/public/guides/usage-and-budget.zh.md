# Usage 与 Budget

`usage()`、`modelUsage()`、`maxBudgetUsd` 和 `taskBudget` 读取或设置 Gateway-owned 计量边界：

```ts
const run = query({ prompt: "运行报表", options: {
  maxBudgetUsd: 0.50,
  taskBudget: { total: 1.00, scope: "project" },
} });
for await (const event of run) { /* 正常消费事件 */ }
console.log(await run.usage(), await run.modelUsage());
```

SDK 只提交 ceiling，不在客户端自行累计 cost。跨 Gateway 重启的 durable ledger、幂等 run 结算和 project scope 由 Gateway 持有。达到预算时返回明确 budget error/result；不要把预算停止误报为 `completed`。

在 `result_unknown` 后先查询 Gateway session/run，再决定是否继续；不要自动重放有副作用请求。

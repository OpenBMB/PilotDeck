# Quickstart

## 前置条件

当前 package 要求 Node.js `>=22.13.0 <23`。准备一个可访问的 PilotDeck Gateway URL 和 token。

```bash
pnpm add @pilotdeck/sdk
```

## 第一个 query

```ts
import { query } from "@pilotdeck/sdk";

const gatewayUrl = process.env.PILOTDECK_GATEWAY_URL!;
const authToken = process.env.PILOTDECK_GATEWAY_TOKEN!;

const run = query({
  prompt: "列出项目中的测试命令",
  options: {
    gatewayUrl: process.env.PILOTDECK_GATEWAY_URL!,
    authToken: process.env.PILOTDECK_GATEWAY_TOKEN!,
  },
});

try {
  for await (const event of run) console.log(event.type, event);
  console.log(await run.result());
} finally {
  run.close();
}
```

`for await` 消费流式事件，`result()` 返回唯一终态。真正取消服务端任务使用 `await run.abort()`；`close()` 只释放 SDK transport。终态必须区分 `completed`、`failed`、`aborted` 和 `result_unknown`。

## 预热连接

```ts
import { startup } from "@pilotdeck/sdk";

const gatewayUrl = process.env.PILOTDECK_GATEWAY_URL!;
const authToken = process.env.PILOTDECK_GATEWAY_TOKEN!;

const warm = await startup({ options: { gatewayUrl, authToken } });
const run = warm.query("检查最近一次构建");
console.log(await run.result());
warm.close();
```

更多主题见 [Sessions](guides/sessions.zh.md)、[Tools](guides/custom-tools.zh.md) 和 [Errors](reference/errors.zh.md)。

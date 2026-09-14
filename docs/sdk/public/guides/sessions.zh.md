# Session 管理

```ts
import { createPilotDeckClient } from "@pilotdeck/sdk";

const gatewayUrl = process.env.PILOTDECK_GATEWAY_URL!;
const authToken = process.env.PILOTDECK_GATEWAY_TOKEN!;
const projectKey = process.env.PILOTDECK_PROJECT_KEY ?? "demo";

const client = createPilotDeckClient({ gatewayUrl, authToken, projectKey });
const session = await client.sessions.create();
const run = client.runs.start({
  sessionId: session.sessionId,
  input: { type: "text", text: "分析最近的构建" },
});

for await (const event of run.events()) console.log(event.type);
console.log(await run.result());
client.close();
```

使用 `listSessions()`、`getSessionMessages()`、`forkSession()`、`exportSessionTranscript()` 和 `restoreSessionTranscript()` 完成查询和显式迁移。transcript 是 Gateway 权威数据；`SessionStore` 只是可选事件镜像。

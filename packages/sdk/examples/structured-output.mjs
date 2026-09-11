import { query } from "@pilotdeck/sdk";

const run = query({
  prompt: "返回一个 JSON，对字段 summary 给出一句总结。",
  options: {
    gatewayUrl: process.env.PILOTDECK_SDK_GATEWAY_URL,
    authToken: process.env.PILOTDECK_SDK_AUTH_TOKEN,
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  },
});

try {
  for await (const _event of run) { /* consume */ }
  const result = await run.result();
  console.log(JSON.stringify(result.output ?? result, null, 2));
} finally {
  run.close();
}

# Structured Output

使用 `outputFormat: { type: "json_schema", schema }` 要求模型结果满足指定结构：

```ts
const run = query({
  prompt: "输出发布摘要",
  options: { outputFormat: { type: "json_schema", schema: {
    type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false,
  } } },
});
const result = await run.result();
```

schema 由 Gateway/Native 做最终校验并决定 result/error；SDK 不应自行把不符合 schema 的文本伪装成成功对象。结构化输出只约束当前 run，不改变 transcript 的 ownership。旧 Gateway 或不支持的 schema 形状必须返回 `unsupported_capability` 或 `validation_error`。

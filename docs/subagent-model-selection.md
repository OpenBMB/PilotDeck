# Selecting a model for a subagent

The parent agent can choose a model for an individual `agent` tool call:

```json
{
  "description": "Review screenshot layout",
  "prompt": "Read /workspace/screenshot.png and review the layout, spacing, and visual hierarchy.",
  "subagent_type": "explore",
  "model": "my-provider/my-vision-model"
}
```

Replace `my-provider/my-vision-model` with an exact reference listed under **Available subagent models** in the tool description. Model IDs containing additional slashes are supported. The list includes models from the configured model pool whose provider has an API key and whose capabilities support streaming and tool use. Descriptions use matching `router.tokenSaver.tiers.<name>.description` (or `label`), otherwise the model display name, alongside configured input modalities. Capability descriptions do not infer quality, cost, or latency from model names.

`model` is optional. Omitting it preserves the configured subagent default and existing automatic routing. Providing it uses the existing explicit model override path: the child uses that model throughout its tool loop, with its own context/output limits and multimodal capabilities. Judge routing and cross-model fallback do not override the selection. The parent session and other subagents keep their own model settings.

The same selection is available in ask mode; read-only tool restrictions, permissions, timeouts, and cancellation still apply. An unknown or unavailable model returns an `invalid_tool_input` error before a child starts. Standalone legacy single-shot tool runtimes do not have a model catalog and reject explicit selection with `unsupported_tool`; calls that omit `model` still work as before.

Choosing a vision model does not forward the parent's images automatically. Include the relevant file paths and task context in `prompt` so the subagent can read them with its existing tools. Custom model definitions must declare their actual `multimodal.input` capabilities.

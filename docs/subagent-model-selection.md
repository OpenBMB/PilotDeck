# Configuring subagents

Open **Settings → Agent → Subagents** to see the available subagent types, edit their descriptions, and bind each type to a model. The parent chooses a `subagent_type` based on its description; the runtime applies the model configured for that type. Model names are not added to the parent-facing catalog.

The built-in types are `general-purpose`, `explore`, `plan`, and `verify`. Existing configurations keep their defaults. You can override a built-in type, disable it, or add a custom type such as `vision` or `consultant`. Resetting a built-in type restores its preset. Custom types can be deleted.

The editor previews the enabled type IDs and descriptions that form the subagent catalog. This is the catalog section of the tool description, not the entire system prompt. Changes are applied on save; descriptions should explain when a type is useful and what it can do. For example, distinguish careful review from routine extraction even when both use the same tools.

## Configuration

Settings are stored under the existing `agent.subagents` section:

```yaml
agent:
  subagents:
    # Existing default and timeoutMs settings continue to work.
    maxDepth: 1
    profiles:
      vision:
        description: Read image files and report visible text, shapes, and layout. Use when visual evidence is needed.
        model: my-provider/my-vision-model
        tools: [read_file]
        readOnly: true
      consultant:
        description: Review difficult questions, identify assumptions, and test conclusions with counterexamples. Prioritize completeness over speed.
        model: my-provider/my-reasoning-model
        tools: [read_file, grep, glob]
        readOnly: true
      explore:
        enabled: false
```

Replace model references with exact configured `provider/model` IDs. Model IDs may contain additional slashes. Omit `model`, or select **Inherit / automatic**, to keep the existing configured subagent default and automatic routing. A bound model remains selected throughout that child's tool loop, with its own token limits and input capabilities. Judge routing and cross-model fallback do not replace it; an unavailable binding produces a visible error.

Type IDs start with a lowercase letter and contain only lowercase letters, digits, and hyphens (1–64 characters). Custom types require a nonempty description and default to enabled, read-only, and the tools `read_file`, `grep`, and `glob`. Built-in overrides preserve omitted fields. Descriptions are limited to 2,000 characters.

## Tools and nested delegation

A profile's tool list is an allowlist intersected with the parent's available tools. A child cannot regain a tool excluded by its parent. Read-only profiles cannot write, and the built-in read-only presets cannot be widened to allow writes. Ancestor ask/plan restrictions continue to apply.

`maxDepth` is the maximum number of child levels below the main agent: `0` disables delegation, `1` allows direct children, and `2` also allows grandchildren. The default is `1`; the maximum is `5`. To allow a child to delegate, include `agent` in its tool list and set a sufficient depth. The runtime enforces the depth even if a caller bypasses the model-facing schema. Nested work shares the ancestor's cancellation and permission boundaries.

## Image tasks

Bind an image-reading profile to a model that actually accepts images, and ensure that model's `multimodal.input` configuration includes `image`. Describing a text-only model as visual does not add image support.

The parent passes the relevant file paths and task context in `prompt`; the child uses `read_file` to obtain the image. Uploaded files explicitly registered for reading by the parent remain readable by its children. Other files outside the workspace do not gain access through delegation.

```json
{
  "description": "Inspect screenshot",
  "prompt": "Read /path/to/uploaded-screenshot.png and report the visible error message.",
  "subagent_type": "vision"
}
```

This feature uses PilotDeck's existing synchronous child sessions. Resuming a completed child by `task_id` and background task management are outside its scope.

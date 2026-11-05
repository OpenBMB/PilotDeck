# Tool rendering

Shared chat rendering for tool calls and results. [ToolRenderer.tsx](ToolRenderer.tsx) selects a display from [toolConfigs.ts](configs/toolConfigs.ts).

- [OneLineDisplay](components/OneLineDisplay.tsx) handles compact actions such as opening files or copying values.
- [CollapsibleDisplay](components/CollapsibleDisplay.tsx) handles expandable arguments and results.
- [ContentRenderers](components/ContentRenderers) contains specialized diff, Markdown, file and task views.

Add a tool display through the shared configuration before adding conditionals in message components. Preserve error handling, accessible expansion and result-action behavior. Keep rendering changes covered by the existing chat tests; see [UI development](../../../../README.md).

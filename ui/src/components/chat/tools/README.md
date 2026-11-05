# Tool rendering

Shared chat rendering for tool calls and results. [ToolRenderer.tsx](ToolRenderer.tsx) selects a display from [toolConfigs.ts](configs/toolConfigs.ts).

- [OneLineDisplay](components/OneLineDisplay.tsx) handles compact actions such as opening files or copying values.
- [CollapsibleDisplay](components/CollapsibleDisplay.tsx) handles expandable arguments and results.
- [ContentRenderers](components/ContentRenderers) contains specialized diff, Markdown, file and task views.
- [toolIcons](toolIcons.ts) maps canonical tool names and activity phases to semantic Lucide icons. Tool rows retain their category while running; homogeneous process groups share that category, mixed groups use layers, and reasoning uses a brain. Keep icons decorative, 14px with a 1.8px stroke, inheriting the row color; respect reduced motion for activity feedback.
- Question and Todo tools own one compact disclosure each; their successful results update the original seat. Question answers retain string-array selections from live events and history.
- [AnimatedDisclosure](../../ui/AnimatedDisclosure.tsx) provides shared bidirectional motion, retained opened content and inert closed subtrees. Conversation panes reserve the scrollbar gutter to keep widths stable.
- [GeneratedMediaCard](GeneratedMediaCard.tsx) presents generated images/videos; [useVideoJobs](useVideoJobs.ts) refreshes durable job state within the originating session/turn. See [video generation](../../../../../docs/video-generation.md).

Add a tool display through the shared configuration before adding conditionals in message components. Preserve error handling, accessible expansion and result-action behavior. Keep rendering changes covered by the existing chat tests; see [UI development](../../../../README.md).

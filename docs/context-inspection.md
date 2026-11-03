# Context inspection

The composer ring opens a context panel inspired by DeepSeek Harness's
[ContextMeter](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx):
system prompt, tools and conversation are shown as a segmented bar and three
token counts. The ring and total retain PilotDeck's existing reported budget;
category counts are explicitly labeled local estimates, not provider-exact
measurements.

“Inspect context” opens searchable sections for the verbatim system prompt,
canonical tool definitions (including input schemas) and ordered canonical
messages, including synthetic instructions and tool calls/results. Refresh
reads the latest assembled model step. This is a read-only inspector; it does
not edit, exclude or compact messages. It shows the assembled canonical request
before provider-specific wire formatting. Binary media is replaced with an
explicit placeholder; original request objects are never mutated.

The agent captures context after routing and request preparation. The turn
runner atomically replaces one `<transcript>.context.json` sidecar with private
file permissions. It is not appended to every transcript event or broadcast
over the streaming connection. Authenticated history reads include it only
when `includeModelContext=true`. Normal history reads pay no snapshot I/O cost.
The reader reuses existing transcript path validation, including background
task boundaries, and rejects snapshots whose turn no longer matches the latest
accepted input. Deleting a conversation also removes its snapshot. Forked or
older conversations without a snapshot show an empty state until a new model
request is made.

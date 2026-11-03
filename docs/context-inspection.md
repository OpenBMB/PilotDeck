# Context usage summary

The composer ring opens a compact context-usage popover with one usage header,
a segmented bar and three token counts
for the system prompt, tool definitions and conversation messages. Gray,
purple and blue swatches match the bar. Counts use compact K/M notation with
`~` for estimates. The ring, percentage and bar use the same existing budget
percentage; the header retains the full model context-window total.

The card uses the active brand tint, a fine border and soft shadow, with
aligned tabular counts in light/dark themes. The occupied bar contains its
segment separators, so they cannot inflate the reported usage width. An
accessible meter exposes the percentage; overflowing usage remains bounded
visually while its text retains `100%+`. Keyboard dismissal returns focus to
the trigger, and reduced-motion mode disables the opacity entrance.

The popover has no inspector, tabs, search, copy/refresh controls or explanatory
paragraphs. Opening it, changing sessions or receiving updated token usage
fetches the category estimates. Missing/loading/unavailable estimates display
as dashes. The browser requests `includeModelContext=summary`, which returns
only `contextBreakdown`, omitting prompt/tool/message payloads. Normal history
and the existing explicit full-context diagnostic API remain unchanged.

The agent captures context after routing and request preparation. The turn
runner atomically replaces one `<transcript>.context.json` sidecar with private
file permissions. It is not appended to every transcript event or broadcast
over the streaming connection. Authenticated history reads include it only
when `includeModelContext=true`. Normal history reads pay no snapshot I/O cost.
The reader reuses existing transcript path validation, including background
task boundaries, and rejects snapshots whose turn no longer matches the latest
accepted input. Deleting a conversation also removes its snapshot. Forked or
older conversations without a snapshot show dashes until a new model request
is made. Category counts are local estimates from the latest assembled
canonical request, before provider-specific wire formatting; the total follows
the reported budget and need not equal the sum of these estimates.

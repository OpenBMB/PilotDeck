# Preserved Case 09 context-shape replay

The same content-silent replay script loaded the preserved V24R12 session and
ran against the built V24R12 and V24R13 `CompactionEngine` implementations.
The script emitted only counts, token estimates, ratios, and booleans. It did
not emit source content, prompts, reasoning, credentials, or tool-call IDs.

Command shape:

```text
node replay-preserved-case09-context.mjs <runtime-root> <preserved-session-jsonl>
```

Shared input metrics:

```text
durable messages: 27
estimated message tokens: 88,280
keepTailRatio: 0.35
exact-retention target: 30,897 tokens
```

V24R12 (`d2953974`):

```text
exact retained messages: 14
exact retained tokens: 42,098
exact retained ratio: 0.476869
projected post-message tokens: 42,157
summary input messages: 13
summary input tokens: 46,182
protected agent calls summarized: 0
protected agent calls retained: 2
summary tool pairs complete: true
retained tool pairs complete: true
newest tool pair retained: true
```

V24R13 working tree:

```text
exact retained messages: 8
exact retained tokens: 27,232
exact retained ratio: 0.308473
projected post-message tokens: 27,291
summary input messages: 19
summary input tokens: 61,048
protected agent calls summarized: 2
protected agent calls retained: 0
summary tool pairs complete: true
retained tool pairs complete: true
newest tool pair retained: true
```

The old planner exceeded its 35% target because count-selected tail and
protected-prefix retention were independent. The new planner stays below the
aggregate target, moves the older protected pairs into the summary input, and
retains the newest complete pair. This replay diagnoses compaction planning;
it does not by itself prove the final legal report or completion contract.

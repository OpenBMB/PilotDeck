# Convergence replay fixtures

These fixtures contain only sanitized runtime state transitions and aggregate
counts. They deliberately exclude legal source content, model messages,
deliverables, Judge inputs, rubrics, expected answers, ground truth, secrets,
and credentials.

`case-09-context-replay.json` records the minimum evidence needed to reproduce
the E2-Elite v6 Case 09 context-control failure. A compaction summary reported
as successful is not marked `applied` unless the Agent loop emitted an accepted
auto-compaction continuation for the resulting message set.


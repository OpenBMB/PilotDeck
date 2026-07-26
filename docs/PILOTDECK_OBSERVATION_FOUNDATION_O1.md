# PilotDeck Observation Foundation O1

Status: implementation contract

## Purpose

O1 supplies a minimum trustworthy observation spine for V23/V24 experiments.
It records facts at PilotDeck source boundaries and derives a deterministic
trajectory from those facts. Gateway events remain a user-interface projection;
they are not the authoritative evaluation record.

## Boundary

O1 is general Harness infrastructure. It does not contain legal rules, case
answers, validator changes, prompt text, routing changes, memory behavior, or
progress-lease policy changes.

O1 is disabled by default. When enabled, it writes beside the session transcript
under Pilot home, never inside the task workspace and never into Agent-visible
context.

## Captured facts

- session and turn lifecycle;
- final per-attempt Provider request fingerprints after routing and transforms;
- prompt injection source, placement, hash, byte size, and request linkage;
- routing, retry, and fallback decisions;
- model response/failure fingerprints and usage;
- tool start/result pairing without raw tool bodies;
- context budget and compaction state transitions;
- progress-lease decisions;
- subagent lifecycle;
- completeness and secret-bearing-key checks.

O1 uses a hash-only diagnostic profile. It does not persist prompt, message,
reasoning, tool input, or tool output bodies. Provider-private chain-of-thought is
out of scope.

## Bundle layout

```text
<pilot-home>/projects/<project>/chats/<session>/observability/
  observations.jsonl
  trajectory.json
  integrity.json
```

`observations.jsonl` is authoritative and append-only. `trajectory.json` and
`integrity.json` are rebuildable derived files.

## Configuration

```yaml
observability:
  enabled: true
  profile: diagnostic
  campaignId: e2-elite-v24
  variant: baseline
  queueCapacity: 4096
```

Baseline and candidate must use the same O1 code, profile, queue capacity, and
recorder settings. `campaignId` and `variant` label evidence only; they do not
change Agent behavior.

## O1 completion gates

1. Existing transcript and Gateway tests remain green with observability off.
2. A synthetic run records paired model and tool facts and verifies `complete`.
3. Dynamic context and PreModelRequest injection hashes link to the exact sent
   request attempt.
4. A corrupted or unpaired fixture is classified `partial` or `invalid` with a
   stable reason code.
5. No secret-bearing key or plaintext prompt/tool body is persisted.
6. Recorder queue and finalization overhead are measured in calibration.
7. Smoke, non-activation Case 05, and a complex V23 control run use the same O1
   profile before V24 is treated as a causal experiment.

## Deliberate O1 omissions

Content-addressed restricted blobs, encryption, retention automation, DuckDB,
MCP query access, OpenTelemetry export, and externally shared forensic bodies
belong to later observability phases. O1 preserves schema extensibility so those
features do not require replacing the raw event stream.

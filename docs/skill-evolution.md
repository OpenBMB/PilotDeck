# Skill Evolution

PilotDeck skill evolution is a consent-first learning loop inspired by Hermes' skill curator. It keeps operational evidence outside `SKILL.md`, stages model-generated improvements for review, and snapshots every applied revision.

## Workflow

1. `read_skill` records a best-effort usage event for standalone user and project skills.
2. Explicit outcomes add success, failure, or correction evidence.
3. An evolution run sends the current `SKILL.md` plus recent evidence to the configured PilotDeck model.
4. The result is stored as a proposal. The live skill is unchanged by default.
5. Applying a proposal validates it, checks that the source hash still matches, and saves the previous content as a revision.
6. Rollback restores any saved revision and first snapshots the current state, so the rollback is itself reversible.

Unlike an autonomous pruning pass, PilotDeck does not archive or delete skills during evolution. Model-driven writes require an explicit `apply` command or `run --apply`.

## CLI

```bash
# See usage, feedback counts, pending proposals, and revisions.
pilotdeck skills evo status
pilotdeck skills evo status my-skill --scope project

# Add outcome evidence from a completed task.
pilotdeck skills evo record my-skill \
  --scope user \
  --outcome failure \
  --feedback "The retry procedure did not cover rate limits."

# Generate a proposal without changing SKILL.md.
pilotdeck skills evo run my-skill --scope user --show-content

# Apply after review, or generate and apply in one command.
pilotdeck skills evo apply my-skill --scope user --proposal <proposal-id>
pilotdeck skills evo run my-skill --scope user --apply

# Restore the newest saved revision, or select one from status --json.
pilotdeck skills evo rollback my-skill --scope user
pilotdeck skills evo rollback my-skill --scope user --revision <revision-id>
```

Use `--project <dir>` to address another project and `--json` for automation. When no `--scope` is provided, the CLI selects the only matching skill; it requires an explicit scope if the slug exists in both user and project stores.

## Storage

Evolution metadata lives beside each skill store and is ignored by normal skill discovery:

```text
<skills-root>/.evo/
  events.jsonl
  proposals/<proposal-id>.json
  revisions/<slug>/<revision-id>.json
  locks/<slug>.lock
```

User metadata is under `$PILOT_HOME/skills/.evo/`. Project metadata is under `<project>/.pilotdeck/skills/.evo/`. The event log is append-only and corrupt partial lines are ignored, so telemetry failures never prevent a skill from loading.

## Gateway API

The in-process and WebSocket gateways expose the same operations used by the CLI:

- `skill_evo_status`
- `skill_evo_record`
- `skill_evo_propose`
- `skill_evo_apply`
- `skill_evo_rollback`

`skill_evo_apply` rejects stale proposals with `evolution_conflict` unless the caller explicitly passes `force: true`. Proposal and revision ids are scoped to the addressed user or project skill store.

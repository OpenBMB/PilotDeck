# Seven-slot frontend composition

Worktree baseline: `codex/merge-sdk-staffdeck`, `e2b4bdc7a`.

Recorded source baselines before implementation:

- PilotDeck `codex/merge-sdk-staffdeck` at `e2b4bdc7a72daf89a1f068b0539fcbe6ad8f25aa` (clean isolated worktree before these changes).
- StaffDeck `codex/portable-sop-runtime` at `b43fe67a07a258829a2046994b4e400f2b08e767` (clean worktree).

The original checkout at `/Users/a1/Desktop/claw/openbmb/PilotDeck` had unrelated
user changes, so implementation and verification were kept in the isolated
`PilotDeck-frontend-seven-slot` worktree.

## Delivery stages

1. Interactive prototype: `/composition.html`, backed entirely by mock data.
2. Production integration: static selected imports, the formal `App.tsx` /
   `AppShellV2` / `MainAreaV2` / `Settings` entry path, existing profile
   validation, runtime capability checks, host HTTP adapters, real StaffDeck
   SOP and Knowledge request paths, and focused regression verification.

The prototype is not a backend integration or a production module loader.
Its profile selector is a development tool. All candidate components are loaded
in this prototype; production builds must only import selected modules.

## Slot mapping

| Slot | Required when explicitly configured | Frontend contributions |
| --- | --- | --- |
| agentLoop | yes | Conversation, execution settings |
| skills | no | Skill management, source settings |
| tools | yes | Tool renderers, permission settings |
| context | yes | Context/compaction settings |
| modelProvider | yes | Model selection/settings |
| sop | no | Workflow page, approval extension, workflow settings |
| knowledge | no | Knowledge management/search, citations, version settings |

`parseModulesConfig.ts` permits explicit disable only for Skills, Knowledge and
SOP. Omitted native bindings preserve existing defaults; Knowledge and SOP are
off unless configured. Backend profile validation remains authoritative.

## Production ownership

The production shell owns layout, current navigation, theme/language, workspace
selection, and About/Privacy/Advanced/Office Preview. It does not own a module's
business form, transport call, or implementation-specific renderer. Settings
entries below are real existing forms unless explicitly marked read-only.

| Slot | Real surface and settings contribution | Read/write boundary | Disabled or replacement behavior |
| --- | --- | --- | --- |
| agentLoop | `ChatInterfaceV2` is injected as the selected chat surface; Agent routing, Always On, Schedules, and Integrations are at `/settings/module/agent-route`, `/agent-resident`, `/agent-schedule`, and `/integrations`. | Existing revision-aware `/api/config` forms and the session/WebSocket runtime. | AgentLoop is required. A different frontend must implement the public `ChatInterfaceProps`; the shell does not import a fallback client. |
| skills | Existing `SkillsV2` page at `/skills`. There is no fabricated settings form because the current Skills surface has no independent writable backend settings API. | Existing skills HTTP/WS host adapter. | The route, navigation item, request-producing page, and its static import disappear when disabled. |
| tools | Existing Tools/Search and MCP Server forms at `/settings/module/tools-search` and `/mcp-servers`; shared tool and permission renderer registries. | Existing `/api/config`, `/api/mcp`, and permission decision callbacks. | Tools is required; a replacement contributes its own renderer/settings contract. |
| context | Existing Memory form, including context/compaction-related configuration, at `/settings/module/context-memory`. | Existing revision-aware `/api/config` form and session context runtime. | Context is required. |
| modelProvider | Existing Model Providers and Agent Model forms at `/settings/module/model-providers` and `/agent-model`. | Existing `/api/config`, model catalog, and session model APIs. | Model provider is required. |
| sop | `/sop`, the real wait/resume banner in the composer, actionable approve/reject permission panel, and `/settings/module/sop`. | Existing SOP lifecycle/status/resume path; `defaultSopId` is read, written, and refreshed through `/api/config` for new runs. | SOP navigation, banner, approval panel, settings, and import disappear when disabled/replaced. |
| knowledge | `/knowledge` query/citation page, citation artifact renderer, and `/settings/module/knowledge`. | Authenticated `/api/modules/knowledge/*` calls; `defaultBaseId` is read/written through `/api/config` and is injected into queries that do not choose a base. | A replacement provides its own page/form. The StaffDeck Knowledge source and request text are absent from the replacement build. |

Historical messages tagged with a removed module are rendered by a shell-owned
read-only fallback. This avoids importing the removed module just to open an
old session.

## Acceptance matrix

| Requirement | Actual entry | Evidence |
| --- | --- | --- |
| Native business settings read, save, and refresh | Selected Settings contributions wrap `ModelPoolSections`, `AgentModelSections`, `AgentRouteSections`, `AgentMemorySections`, `AgentResidentSections`, `AgentScheduleSections`, `AgentSearchSections`, `McpServersSection`, and `IntegrationsSections`. | Existing component regression tests plus `ui/src/composition/settings-behavior.test.tsx`; each uses the shared revision-aware `/api/config` client. |
| StaffDeck SOP/Knowledge behavior | `/sop`, real composer wait/resume, `/knowledge` query/citation, `/settings/module/sop`, `/settings/module/knowledge`. | Formal browser and cross-process artifacts retained under `test-results/formal-knowledge/` and `ui/test-results/formal-composition/`; component behavior coverage exercises approval decision and profile save/refresh. |
| JWT-safe module calls | Runtime projection and both Knowledge operations use `authenticatedFetch`. | `ui/src/composition/runtime.test.ts` asserts the authenticated host client is used. |
| Disabled module behavior | Generated profile preserves `enabled: false`; shell resolves only generated selections. | `scripts/generate-frontend-modules.test.mjs`, build manifests, and route-matrix browser tests. |
| Replacement behavior | `replacement-knowledge.yaml` selects `fixture.knowledge-search`; its profile-backed `resultLimit` is used by the module proxy. | Independent replacement process calls plus replacement build manifest. |
| Mismatch safety | Assembly is constructed from generated static intent, then compared independently with `/api/modules/runtime`. | `ui/src/composition/runtime.test.ts`; mismatch removes module-owned pages/settings/operations while the shell stays available. |

## Prototype combinations

- StaffDeck: reads `native-five-staffdeck.yaml` directly.
- Native: derives from the above by disabling SOP and Knowledge.
- Minimal: reads `pilotdeck-only.yaml` directly.
- Replacement: uses `replacement-knowledge.yaml`, an independently started
  `module-http-v2` Knowledge conformance process, and its paired search UI.
  The profile changes both `implementationId` and `frontendModule`; query and
  citation resolution are verified through that replacement process.
- Invalid: explicit Context disable or unsupported Knowledge contract.

The registry assembles pages, settings, chat extensions, tool and artifact
renderers. The shell only consumes contributions. Prototype actions update
in-memory state; no edits are persisted, and no model or approval is invoked.

## Static frontend entrypoint

Generate selected browser imports from the same profile used by the backend:

```sh
node scripts/generate-frontend-modules.mjs \
  --profile products/pilotdeck-staffdeck-sop/profiles/native-five-staffdeck.yaml
```

The output is `ui/src/composition/generated/frontend-modules.ts`. Disabled
slots are omitted from both the module list and the generated import graph.
Backend implementation IDs must either map to a registered public adapter or
carry an explicit `frontendModule` key; unknown IDs fail generation. The
composition exporter runs this step
into the exported PilotDeck tree so the web artifact and backend profile stay
aligned.

Normal `ui` `dev` and `build` run this generator automatically. Profile
resolution is shared by the generator, root dev launcher, and exporter, in
this order: `PILOTDECK_FRONTEND_PROFILE`, then `PILOTDECK_CONFIG_PATH`, then
the checked-in `profiles/native.yaml`. The default deliberately disables SOP
and Knowledge. If both environment variables name different files, generation
fails rather than building a browser bundle for a runtime it cannot serve.
Root `npm run dev` generates the static entrypoint before it starts the
supervisor and sets `PILOTDECK_CONFIG_PATH` to that same resolved profile.

The UI server exposes `/api/modules/runtime`, returning only module identity,
contract, transport, methods, and Gateway capabilities. Endpoint URLs and
credentials never cross this boundary. Browser code can compare this projection
with the generated assembly through `validateRuntimeCapabilities` and must show
an assembly error instead of rendering a stale entry point.

Runtime verification is a gate, not a warning. While `/api/modules/runtime`
is pending, the common shell remains available but the assembly is `null`:
there are no module pages, settings, lifecycle hooks, permission panels, or
Knowledge operations to activate. Chat reports that runtime modules are being
verified until the exact static profile is accepted.

Module-owned transcript rows carry a durable `moduleId` (the backend
implementation id) in canonical message metadata, the Web history DTO, server
normalization, and `ChatMessage`. A removed implementation therefore uses the
host-owned historical fallback instead of requiring its old renderer to remain
in the build. Older transcripts have no trustworthy ownership marker and are
rendered as ordinary host history; they are never guessed to belong to a
disabled module.

StaffDeck adapters use the same host boundary: SOP wait/resume uses the existing
`SopWaitBanner` lifecycle, and Knowledge query and citation resolution are
proxied through `/api/modules/knowledge/query` and
`/api/modules/knowledge/citation` to the configured
`staffdeck.knowledge/v1` module. For StaffDeck's public Knowledge protocol, a
profile can also project `tenantId`, `actorUserId`, and `defaultBaseId`; the
bridge supplies the tenant/actor and maps the saved default base to
`knowledgeBaseIds` for real queries. These contributions are mounted by the formal
application shell: generated pages become sidebar routes, settings get dynamic
module sections, and chat extensions render below the real
`ChatInterfaceV2` without replacing its session/timeline runtime. The
replacement profile is an independent conformance backend, not a mock
substitute for StaffDeck integration.

The standalone `/composition.html` page is retained as a development preview
and module experiment bench. It is not a production entry point and is excluded
from normal builds so its all-candidate fixture registry cannot leak disabled
module code. Set `PILOTDECK_INCLUDE_COMPOSITION_PROTOTYPE=true` only when
building that developer preview deliberately. Normal Web and Desktop launches
use `ui/src/main.jsx` -> `App.tsx` -> `AppShellV2`, and both consume the same
generated module entrypoint.

## Production verification

Formal UI build and profile import checks:

```sh
env -u NODE_OPTIONS pnpm --dir ui run typecheck
env -u NODE_OPTIONS pnpm --dir ui run build
node scripts/generate-frontend-modules.mjs --profile products/pilotdeck-staffdeck-sop/profiles/pilotdeck-only.yaml --out /tmp/pilotdeck-only-frontend.ts
node scripts/generate-frontend-modules.mjs --profile products/pilotdeck-staffdeck-sop/profiles/native-five-staffdeck.yaml --out /tmp/native-five-frontend.ts
node scripts/generate-frontend-modules.mjs --profile products/pilotdeck-staffdeck-sop/profiles/replacement-knowledge.yaml --out /tmp/replacement-frontend.ts
```

The PilotDeck-only generated entry contains no Skills, SOP, or Knowledge
imports; the native five-slot + StaffDeck profile contains all three selected
contributions. The formal UI build completed for the generated StaffDeck
profile. Desktop loads this same Vite/Web build through its existing renderer
entry, so no second module registry is maintained. Desktop TypeScript
compilation passes after relinking the workspace dependencies.

The repeatable four-profile matrix is run with:

```sh
env -u NODE_OPTIONS node scripts/frontend-build-matrix.mjs
```

Constrained runners can execute the same checks one profile at a time:

```sh
node scripts/frontend-build-matrix.mjs --profile minimal
node scripts/frontend-build-matrix.mjs --profile replacement
```

It builds native, native-five-staffdeck, minimal, and replacement profiles into
isolated Vite outputs and records selected imports and emitted chunks in
`test-results/frontend-build-matrix/*/manifest.json`. Exporter consistency and
an exported UI build are recorded in `test-results/export-verification.json`.

Formal browser evidence was captured at
`test-results/formal-knowledge/browser-resolved.png` using the normal Web UI route
`/knowledge` (not `composition.html`). The browser typed a query, received
real StaffDeck Knowledge chunks through `/api/modules/knowledge/query`, then
clicked `Resolve citation`, which called the real module's
`resolve_citation` operation through `/api/modules/knowledge/citation` and
rendered the returned source snapshot. The StaffDeck lifecycle runner also
passed its cross-process query/citation/restart checks at
`test-results/formal-knowledge/staffdeck-knowledge-lifecycle.json`.

The full Docker Compose browser smoke remains environment-limited when the
Docker API socket is unavailable. The direct formal Web browser check above
does not require Docker and uses the real local StaffDeck Knowledge process.

Repeatable formal browser checks are in `ui/e2e/formal-composition.spec.mjs`.
Run them against a started formal Web+StaffDeck deployment with:

```sh
FORMAL_COMPOSITION_URL=http://127.0.0.1:5188 \
  pnpm --dir ui exec playwright test -c e2e/formal-composition.config.mjs
```

`ui/e2e/formal-route-matrix.spec.mjs` runs the normal application shell for
the native and minimal profiles on desktop and mobile. It verifies that the
native Skills route is present and that disabled Skills, SOP, and Knowledge
routes do not render module pages. Runtime manifests and traces are retained
under `ui/test-results/`; replacement process calls are retained in
`ui/test-results/replacement-module-calls.jsonl`.

Fresh authenticated browser evidence is retained separately per profile:

- `ui/test-results/real-auth-staffdeck/` records JWT-authenticated runtime and
  config calls, saved/reloaded SOP and Knowledge settings, plus a real seeded
  StaffDeck query and citation resolution. The current report is
  `real-auth-composition-auth-29477--the-real-Knowledge-runtime/staffdeck-real-knowledge-report.json`:
  it saves `kb_preset_sales_001`, queries `客户拓展`, resolves
  `kchunk_preset_sales_001`, then saves `operator_approval_alternate`.
  SOP module configuration is intentionally restart-required, so the test uses
  the supervised `/api/update/restart` path before beginning a new handoff /
  resume flow. The live SOP status then reports
  `selected_skill_id: operator_approval_alternate`; the test restores the
  original SOP and Knowledge settings and restarts again before it exits.
- `ui/test-results/real-auth-minimal/` records direct disabled Knowledge/SOP
  route checks with no Knowledge operation request.
- `ui/test-results/real-auth-replacement/` records the replacement UI save and
  query; `ui/test-results/replacement-runtime-browser-calls.jsonl` records the
  replacement runtime receiving `resultLimit: 3`.

Run a selected authenticated profile with:

```sh
REAL_COMPOSITION_URL=http://127.0.0.1:15101 \
REAL_COMPOSITION_PROFILE=staffdeck \
pnpm --dir ui exec playwright test -c e2e/real-auth-composition.config.mjs
```

The isolated worktree uses the already-installed workspace dependencies from
the SDK merge worktree. To recreate those local links after a clean worktree
setup, run:

```sh
ln -s /Users/a1/Desktop/claw/openbmb/PilotDeck-sdk-staffdeck-merge/node_modules \
  /Users/a1/Desktop/claw/openbmb/PilotDeck-frontend-seven-slot/node_modules
ln -s /Users/a1/Desktop/claw/openbmb/PilotDeck-sdk-staffdeck-merge/ui/node_modules \
  /Users/a1/Desktop/claw/openbmb/PilotDeck-frontend-seven-slot/ui/node_modules
```

Focused consumer coverage in `ui/src/composition/consumption.test.tsx` proves
that an active assembly reaches custom Tool, permission, artifact, lifecycle,
and historical fallback consumers rather than only producing assembly metadata.

## Reuse and next integration

The prototype uses existing PilotDeck Button/Input, global style pipeline,
brand assets, React, Vite, and YAML profiles. StaffDeck's KnowledgePage currently
depends on its router, tenant/auth, enterprise UI, scope and data clients; its
React compatibility alone does not make it an independent module. Production
adapters target the published StaffDeck capabilities while preserving host
ownership. Existing chat timeline and lifecycle logic remain the source of
truth; generated contributions add only module-owned surfaces and adapters.

The current assembly helper checks frontend contracts and contributions,
including tool, permission, artifact, and history-fallback registries. The
active assembly is installed for lifecycle initialization and cleanup, while
native rendering remains the fallback when a contribution is absent.
Production profile loading invokes backend profile validation before generation
and validates runtime capabilities at startup; the browser helper intentionally
does not validate endpoint, transport, deployment, or provider credentials.

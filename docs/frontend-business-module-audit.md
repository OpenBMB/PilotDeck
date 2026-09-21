# Frontend Business Module Audit

This audit distinguishes the seven backend protocol slots from optional product
business capabilities. A backend slot answers who owns a protocol. A business
module answers which product surface, client code, and requests are present in
one browser build.

The audit was taken from the production shell, not `composition.html`. Source
paths below are the trace points used by the generator and browser tests.

## States

`frontend.businessModules.<id>` has two independent meanings:

- A module omitted from the profile is **not installed**. Its entrypoint is
  not statically imported; its navigation, direct and legacy routes, settings,
  requests, timers, subscriptions, and extension registrations do not exist.
- An installed module can retain its existing backend runtime switch, such as
  `router.enabled`, `memory.enabled`, or a channel's `enabled` setting. Its
  settings remain available so an operator can turn it back on. A false runtime
  switch is never treated as browser-module removal.

Legacy profiles that have no `frontend.businessModules` select the documented
`legacy-default` set of capabilities migrated so far (routing, resident,
scheduling, and integrations in this change). New product profiles use an
explicit map. Remaining audit rows are the next migration groups; they are not
claimed to be statically removable until their slot/host aggregate imports have
been split. This makes compatibility deliberate while preventing an omitted
entry in a new profile from silently enabling a migrated business capability.

## Ownership Matrix

| Current source and surface | Business module / backend dependency | Requests, hooks, and polling | Installed behavior / absent behavior |
| --- | --- | --- | --- |
| `AppShellV2`, project/session selection, authentication, WebSocket bridge, layout, `/`, `/p/:project/c/:session`, `/session/:session` | `host.shell`; public host API only | Projects/session HTTP and WebSocket state are host-owned | Always present. It may not import a business settings form or feature renderer. |
| `ChatInterfaceV2`, composer, stream timeline, cancel, reconnect, queue, subagents | `chat.core`; `agentLoop`, `tools`, `context`, `modelProvider` | Existing session HTTP/WS runtime | Always present for an enabled `agentLoop`. It must not import routing, Always On, schedules, integrations, MCP, Knowledge, or SOP UI. |
| `SkillsV2`, sidebar page, `/skills` | `skills.catalog`; `skills` | Skills page HTTP/WS adapter | Existing slot module; disabled Skills removes navigation, page, deep link content, and its static module import. |
| `ModelPoolSections`, `/settings/module/model-providers` and legacy `/settings/models` | `model.providers`; `modelProvider` | `/api/config`, connection-test task polling, model-reference calls | Installed model-management UI. An absent module has no model form or connection-test polling. |
| `AgentModelSections`, `/settings/module/agent-model`, legacy `/settings/agent-model` | `agent.model-selection`; `agentLoop`, `modelProvider` | `/api/config` | Separate from provider management so an alternate agent-selection UI can replace it. |
| `AgentRouteSections`, `/settings/module/agent-route`, legacy `/settings/agent-route`, old `?tab=config:router` | `agent.routing`; `agentLoop`, `modelProvider` | `/api/config` only when this form mounts | **Known leak:** `pilotdeck-chat.tsx` imported this unconditionally. An absent module must have no route, settings item, router form, or router config request. `router.enabled: false` is the installed module's runtime state, not removal. |
| `AgentResidentSections`, `/settings/module/agent-resident`, legacy `/settings/agent-resident`, old `?tab=config:alwaysOn` | `agent.resident`; `agentLoop` | `/api/config` | **Known leak:** imported by `pilotdeck-chat.tsx`. An absent module has no Always On form; installed-but-empty `alwaysOn.projects` remains editable. |
| `AgentScheduleSections`, scheduled task page `/cron`, legacy `/settings/agent-schedule`, old `?tab=config:cron` | `agent.scheduling`; `agentLoop` | `/api/config`, schedule page request/subscription ownership | **Known leak:** its settings form is imported by `pilotdeck-chat.tsx`; the dedicated `/cron` route must use the same assembled capability and resolve absent deep links without mounting schedule code. |
| `IntegrationsSections`, legacy `/settings/integrations`, old `?tab=gateway` | `channels.integrations`; `agentLoop` and Gateway capability | `/api/gateway/status`; Feishu/Weixin/WeCom QR begin/poll/cancel/test/save/disable timers | **Known leak:** imported by `pilotdeck-chat.tsx`. Removing it stops status polling and all channel QR timers. |
| `McpServersSection`, `/settings/module/mcp-servers`, legacy `/settings/mcp`, old `?tab=mcp` | `tools.mcp`; `tools` and Gateway MCP capability | `/api/mcp/config` reads/writes | Separate from generic Tools/Search. An absent module has no MCP settings route or MCP request. |
| `AgentSearchSections`, `/settings/module/tools-search`, legacy tools/search links | `tools.search`; `tools` | `/api/config/test-web-search` and config form activity while mounted | Installed search configuration only; absent module does not import its test UI/API client. |
| Common tool result and permission renderers | `tools.core`; `tools` | Existing permission decision callback, no polling | Required slot contribution. Optional renderers are separate business modules and must be registered only by the final assembly. |
| `AgentMemorySections`, `/settings/module/context-memory`, legacy `/settings/agent-memory`, old `?tab=config:memory` | `context.memory`; `context` | `/api/config`, `/api/memory/export/*`, import, clear | Installed memory/compaction management. `memory.enabled: false` leaves it installed and editable; absent removes memory endpoints and UI. |
| `SopWaitBanner`, SOP page `/sop`, SOP approval panel, SOP setting | `workflow.sop`; `sop`, `agentLoop` | Existing SOP status/prepare/resume lifecycle | Existing StaffDeck contribution. Disabled/replaced SOP removes its page/settings/banner/panel, while historical transcript rows use the host fallback. |
| Knowledge page, citation artifact renderer, Knowledge setting | `knowledge.search`; `knowledge` | `/api/modules/knowledge/query`, `/citation` | Existing StaffDeck/replacement contribution. An absent module makes neither request; replacement owns its own form and query UI. |
| `OfficePreviewSections`, legacy `/settings/office`; binary-file Office preview controls and status | `workspace.office-preview`; host workspace/file API | `officePreviewStatus`, preview/preflight/download requests and refresh effects | Optional workspace renderer/settings pair. Absent means no Office setting/legacy route and no Office-specific renderer or status request. Generic text/image/PDF file viewing remains host-owned. |
| `GeneralSections`: project sorting, chat input preferences, code-editor preferences | `host.preferences`, `chat.preferences`, `workspace.editor-preferences` | Local settings controller only | Split before composition: project sorting is host shell; input preferences require chat; editor preferences require workspace editor. None may be hidden inside an omnibus General import. |
| `PrivacySections`: tool permission rules and telemetry | `tools.permissions` (`tools`), `system.telemetry` (host) | Permission settings fetch/persist; config save | Permission UI follows Tools; telemetry is an explicit system module. Removing permissions stops its settings fetch/listeners. |
| `AdvancedSections`: retry policy, service/runtime settings, custom environment | `system.advanced`; declared host/runtime capabilities | `/api/config` on form save | Explicit administrative module, never a fallback bucket for omitted product features. |
| `AboutSections`: version check, apply/restart status polling | `system.updates`; host deployment capability | `/api/update/check`, `/status` interval, apply/restart | Explicit system module. If excluded, no update polling or restart action is mounted. |

## Route Rules

All routes are resolved from the final assembly: sidebar navigation, direct
URLs, old settings aliases, `window.openSettings`, commands, and dedicated
routes such as `/cron`. When a route belongs to a module that is not installed,
the shell renders its generic unavailable/not-found state. It does not import
or mount the feature component, and therefore cannot start a feature request
or timer.

## Static Build Rules

The profile generator emits imports for selected backend-slot adapters and
selected business module adapters only. It must not import an aggregate such as
`pilotdeck-chat` or `SettingsContent` that statically imports an unselected
feature. Host code receives final `pages`, `settings`, chat extensions,
renderers, lifecycle hooks, and route aliases as data. Rollup module-list
checks, rather than marker-string checks alone, prove that each absent module's
source is outside the produced graph.

## Migration Order

1. Make the host settings shell contribution-only and remove hard imports of
   General, Office, Privacy, Advanced, and About pages.
2. Split existing slot adapters so `pilotdeck.chat` contains only chat core;
   move routing, resident, scheduling, and integrations into business modules.
3. Add explicit business selections and static generator imports, then migrate
   model, tools, context, Office, privacy, and system settings.
4. Route legacy settings paths through the same assembled aliases, with a
   generic unavailable result for an absent capability.
5. Add bundle-graph, request absence, direct-route, replacement, and lifecycle
   tests for each matrix group.

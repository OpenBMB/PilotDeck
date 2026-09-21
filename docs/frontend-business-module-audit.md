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
scheduling, integrations, model providers, agent model selection, tool search,
MCP, context memory, Office preview, advanced settings, tool permissions,
telemetry, updates, host preferences, chat preferences, and editor preferences).
New product profiles use an explicit map. Remaining
audit rows are the next migration groups; they are not claimed to be statically
removable until their slot/host aggregate imports have been split. This makes
compatibility deliberate while preventing an omitted entry in a new profile
from silently enabling a migrated business capability.

## Ownership Matrix

| Current source and surface | Business module / backend dependency | Requests, hooks, and polling | Installed behavior / absent behavior |
| --- | --- | --- | --- |
| `AppShellV2`, project/session selection, authentication, WebSocket bridge, layout, `/`, `/p/:project/c/:session`, `/session/:session` | `host.shell`; public host API only | Projects/session HTTP and WebSocket state are host-owned | Always present. It may not import a business settings form or feature renderer. |
| `ChatInterfaceV2`, composer, stream timeline, cancel, reconnect, queue, subagents | `chat.core`; `agentLoop`, `tools`, `context`, `modelProvider` | Existing session HTTP/WS runtime | Always present for an enabled `agentLoop`. It must not import routing, Always On, schedules, integrations, MCP, Knowledge, or SOP UI. |
| `SkillsV2`, sidebar page, `/skills` | `skills.catalog`; `skills` | Skills page HTTP/WS adapter | Existing slot module; disabled Skills removes navigation, page, deep link content, and its static module import. |
| `ModelPoolSections`, `/settings/module/model-providers` and legacy `/settings/models` | `model.providers`; `modelProvider` | `/api/config`, connection-test task polling, model-reference calls | Migrated. Installed model-management UI; an absent module has no model form or connection-test polling. |
| `AgentModelSections`, `/settings/module/agent-model`, legacy `/settings/agent-model` | `agent.model-selection`; `agentLoop`, `modelProvider` | `/api/config` | Migrated separately from provider management so an alternate agent-selection UI can replace it. |
| `AgentRouteSections`, `/settings/module/agent-route`, legacy `/settings/agent-route`, old `?tab=config:router` | `agent.routing`; `agentLoop`, `modelProvider` | `/api/config` only when this form mounts | Migrated. An absent module has no route, settings item, router form, or router config request. `router.enabled: false` is the installed module's runtime state, not removal. |
| `AgentResidentSections`, `/settings/module/agent-resident`, legacy `/settings/agent-resident`, old `?tab=config:alwaysOn`, page `/always-on` | `agent.resident`; `agentLoop` | `/api/config`; Always On requests only while its page mounts | Migrated. An absent module has no Always On form, page, badge poller, or Always On code; installed-but-empty `alwaysOn.projects` remains editable. |
| `AgentScheduleSections`, scheduled task page `/cron`, legacy `/settings/agent-schedule`, old `?tab=config:cron` | `agent.scheduling`; `agentLoop` | `/api/config`, schedule page request/subscription ownership | Migrated. The dedicated route comes from the assembled module and an absent deep link resolves generically without mounting schedule code. |
| `IntegrationsSections`, legacy `/settings/integrations`, old `?tab=gateway` | `channels.integrations`; `agentLoop` and Gateway capability | `/api/gateway/status`; Feishu/Weixin/WeCom QR begin/poll/cancel/test/save/disable timers | Migrated. Removing it excludes the status poller and all channel QR timers. |
| `McpServersSection`, `/settings/module/mcp-servers`, legacy `/settings/mcp`, old `?tab=mcp` | `tools.mcp`; `tools` and Gateway MCP capability | `/api/mcp/config` reads/writes | Migrated separately from generic Tools/Search. An absent module has no MCP settings route or MCP request. |
| `AgentSearchSections`, `/settings/module/tools-search`, legacy tools/search links | `tools.search`; `tools` | `/api/config/test-web-search` and config form activity while mounted | Migrated. An absent module does not import its search test UI/API client. |
| Common tool result and permission renderers | `tools.core`; `tools` | Existing permission decision callback, no polling | Required slot contribution. Optional renderers are separate business modules and must be registered only by the final assembly. |
| `AgentMemorySections`, `/settings/module/context-memory`, legacy `/settings/agent-memory`, old `?tab=config:memory`, page `/memory` | `context.memory`; `context` | `/api/config`, `/api/memory/export/*`, import, clear | Migrated. `memory.enabled: false` leaves it installed and editable; absent removes memory settings, dashboard page, endpoints, and UI. |
| `SopWaitBanner`, SOP page `/sop`, SOP approval panel, SOP setting | `workflow.sop`; `sop`, `agentLoop` | Existing SOP status/prepare/resume lifecycle | Existing StaffDeck contribution. Disabled/replaced SOP removes its page/settings/banner/panel, while historical transcript rows use the host fallback. |
| Knowledge page, citation artifact renderer, Knowledge setting | `knowledge.search`; `knowledge` | `/api/modules/knowledge/query`, `/citation` | Existing StaffDeck/replacement contribution. An absent module makes neither request; replacement owns its own form and query UI. |
| `OfficePreviewSections`, legacy `/settings/office`; binary-file Office preview controls and status | `workspace.office-preview`; host workspace/file API | `officePreviewStatus`, preview/preflight/download requests and refresh effects | Settings migrated. Absent means no Office setting or legacy route; Office-specific file renderers remain a separate follow-up. Generic text/image/PDF file viewing remains host-owned. |
| Appearance, language, and project sorting | `host.preferences` | Local preference storage and `pilotdeck-settings-changed` event | Migrated. Settings root resolves through this module; an omitted module does not mount or persist host preference controls. |
| Chat input and message display preferences | `chat.preferences`; `agentLoop` | `uiPreferences` local preference storage/event | Migrated. The module requires the chat core and is absent with it. |
| Code editor preferences | `workspace.editor-preferences` | Editor localStorage keys and `codeEditorSettingsChanged` event | Migrated. An omitted module does not mount its preference writer or event dispatch. |
| Tool permission rules | `tools.permissions` (`tools`) | `/api/settings/permissions`, localStorage and `pilotdeck-settings-changed` subscription | Migrated. An omitted permissions module has no settings surface, permission fetch, or browser listeners. |
| Telemetry setting | `system.telemetry` (host deployment capability) | Config parse/save only | Migrated separately from tool permissions. An omitted telemetry module has no settings surface or config toggle. `system.privacy` remains a compatibility-only implementation for old explicit profiles. |
| `AdvancedSections`: retry policy, service/runtime settings, custom environment | `system.advanced`; declared host/runtime capabilities | `/api/config` on form save | Migrated explicit administrative module, never a fallback bucket for omitted product features. |
| `AboutSections`: version check, apply/restart status polling | `system.updates`; host deployment capability | `/api/update/check`, `/status` interval, apply/restart | Migrated. The settings shell no longer imports update actions; if excluded, no update check, polling, apply, or restart action is mounted. |

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
   Office, privacy, and system settings after the model, tools, and context
   groups.
4. Route legacy settings paths through the same assembled aliases, with a
   generic unavailable result for an absent capability.
5. Add bundle-graph, request absence, direct-route, replacement, and lifecycle
   tests for each matrix group.

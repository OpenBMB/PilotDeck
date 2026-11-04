# UI architecture audit

The production route is `main.jsx → App → AppShellV2 → MainAreaV2 →
MainContent → ChatInterfaceV2`. The `V2` suffix identifies the active surface;
it is not evidence of an obsolete implementation.

`components/chat/` is a shared feature layer: its hooks own streaming,
session recovery, permissions, input queues, attachments and provider state.
Its tool renderers, Markdown and permission panels are also used by the active
chat surface. Keep their regression tests with the code they exercise.

The audit removed modules without production **or test** consumers: the old
project wizard shell (the folder browser, GitHub token controls and workspace
API are still used), CLI-provider sign-in shell, unused onboarding steps,
old outlet context, duplicate navigation/statistics/update hooks, unused
permission settings panel and redundant UI wrappers. No active feature was
removed based on its directory or version name.

Run `node scripts/audit-ui-reachability.mjs` to inspect local import reachability
from the HTML entry points and ambient declarations. The script follows static
imports, re-exports and literal dynamic imports. It is an audit aid, not an
automatic deletion rule: barrel exports can retain unused modules, external
consumers and nonliteral imports require manual review, and test-only helpers
(such as `i18n/testInstance.ts`) are intentionally separate from production.

Use `node scripts/audit-ui-reachability.mjs --exports` for the second pass.
It resolves named/default imports through re-export chains with the TypeScript
checker, includes test consumers, and retains namespace, dynamic and side-effect
imports conservatively. `barrelOnly` lists reachable implementation modules
whose exports have no resolved consumers; pure barrels are excluded. These
candidates still require a side-effect and dynamic-usage review before deletion.

## Follow-up: account screens and hidden exports

The "Welcome Back / Sign in to your PilotDeck self-hosted account" screenshot
is `auth/view/LoginForm.tsx`, reached through
`App → AuthProvider → ProtectedRoute → LoginForm`. It is an active account
entry point, not a second application shell. A self-hosted server with an
existing account requires login; a new server uses `SetupForm`. Successful
authentication proceeds to the same `AppShellV2`. Account routes, JWT/session
handling, WebSocket authentication and the database remain in use.

Desktop starts the local UI server with `PILOTDECK_DISABLE_LOCAL_AUTH=1` by
default (an explicit environment override can require authentication). The
frontend also reads `/api/auth/status`, so a production bundle built without
that flag still honors the runtime server's `authDisabled` response. Deleting
the account forms or forcing a desktop-only bypass would break supported
deployments. Authentication-status failures now show a retryable startup error
instead of being mistaken for the signed-out state. A user-service outage
preserves the stored session; a 401/403 rejection clears it and returns to login.

The export-level pass found five more unused implementations hidden behind
barrels. Repository-wide reference searches found no runtime, test, dynamic
import or preload consumers:

| Removed module | Only incoming reference before removal |
| --- | --- |
| `shared/view/ui/DarkModeToggle.tsx` | `shared/view/ui/index.ts` re-export |
| `shared/view/ui/ScrollArea.tsx` | `shared/view/ui/index.ts` re-export |
| `shared/view/ui/PillBar.tsx` | `shared/view/ui/index.ts` re-export |
| `components/settings/shared/view/SettingsRow.tsx` | settings shared barrel re-export |
| `components/settings/shared/view/PageSectionHeader.tsx` | settings shared barrel re-export |

Their barrel entries were removed together. The current export-level report
has no `barrelOnly` implementations, and the only file outside production
reachability is the intentional i18n test helper.

The stylesheet pass removed 41 unused selectors and their exclusive tokens:
the retired glass/mobile navigation, old chat input placeholder/expanded
styles, unused transitions, old JavaScript PWA marker overrides, and unused
layout helpers. The current CSS-based standalone safe-area support remains.
Active shell/message styles and xterm's externally generated classes remain;
their directory names or absence from JSX class literals do not establish
that they are obsolete.

Validation includes production compilation, UI type checking, the complete
client suite, and integration coverage of self-hosted login/setup, runtime
authentication bypass, status-request errors, session expiry and retry.

Keep UI composition in `app-shell`, `chat-v2` and `main-content-v2`; keep shared
behavior in the existing feature hooks. A wholesale directory rename would
create test/import churn without improving these boundaries. Prefer small
extractions when a component gains a distinct responsibility (for example,
context inspection) and colocate its tests. Backend session protocol versions,
database migrations, provider API versions and asset variants are independent
of the UI generations and must not be removed by a `v1`/`v2` text search.

New profiles use a managed `PilotDeckGeneral` working directory: the system
Documents folder on Windows, and the user's home directory on macOS/Linux.
Windows desktop passes Electron's known Documents folder to the server;
standalone Web resolves the same system folder, including redirected folders.
A custom `WORKSPACES_ROOT` still selects a different parent directory. The
default project-browsing root (home) uses the platform convention above.
Session storage remains keyed by `PILOT_HOME`; sidebar folder actions open
the current managed workspace even when older sessions have stale cwd metadata.
General settings can select an exact absolute or home-relative directory through
`webui.runtime.generalWorkspaceDirectory`. Switching to a different nonempty
folder is rejected, including folders containing hidden user files. Existing
files are not moved when the setting changes.

The selected default and its identity are recorded in
`PILOT_HOME/general-workspace.json`, with a matching `.pilotdeck-workspace`
marker in the workspace. Custom directory claims are also recorded under
`PILOT_HOME/general-workspace-identities`, so manually configured YAML paths
remain usable after the first turn creates files, without rewriting user YAML.
Existing General history, a saved location or a workspace marker identifies the
previous `PilotDeck` location for migration into `PilotDeckGeneral`. An existing safe unnumbered
default can be reused on first install, even when populated. Installation
overlap, a file or a link at that path causes first-run selection of the first
safe empty `PilotDeckGeneral2`, `PilotDeckGeneral3`, etc. The UI reports this
choice. Subsequent launches reuse the registered location; a missing or changed
identity reports an error instead of silently switching directories. The
Windows installer checks the complete installation tree, its parents and nested
workspaces before preparation and again before replacement. The runtime rejects
workspaces overlapping the complete installation, including siblings of
`resources/runtime`. These guards do not recover files
overwritten by older installers or external processes.

Before publishing that cwd to the sidebar or dispatching a General turn, merge
the previous `<WORKSPACES_ROOT || home>/general` and recognized `PilotDeck`
directories into the new location. Registered numbered `PilotDeck2` locations
are migrated too. Independent projects retain their existing paths and defaults.
This also handles the Windows home-to-Documents move and an existing default
directory. Keep the original directory; copy missing files, reuse identical
files, and preserve differing old versions as `name (from general).ext` (with
numbered suffixes when needed); files from `PilotDeck` use ` (from PilotDeck)`.
Workspace markers are not copied. Merge directories and preserve file/directory
collisions the same way. The new copy is independent of the original.

Publish each complete file without overwriting an existing name. Interrupted
copies cannot expose a partial file under its final name, and failed migrations
remain retryable. The target filesystem must support atomic hard-link publication;
otherwise preparation reports the error and retains the original data. Do not
follow source links or destination junctions, copy special files, or allow a
workspace to overlap `PILOT_HOME`. Retain a completion/conflict/skipped-entry
report under `PILOT_HOME/migrations/general-workspace-v1-*.json`, outside the
agent workspace. Repeated requests share the migration and completed work is
not reimported on restart. A removed registered workspace must be restored or
replaced explicitly through General settings. Existing transcript/session
identities remain unchanged.

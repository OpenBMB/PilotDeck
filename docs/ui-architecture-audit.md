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

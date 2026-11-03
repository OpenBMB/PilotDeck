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

Keep UI composition in `app-shell`, `chat-v2` and `main-content-v2`; keep shared
behavior in the existing feature hooks. A wholesale directory rename would
create test/import churn without improving these boundaries. Prefer small
extractions when a component gains a distinct responsibility (for example,
context inspection) and colocate its tests. Backend session protocol versions,
database migrations, provider API versions and asset variants are independent
of the UI generations and must not be removed by a `v1`/`v2` text search.

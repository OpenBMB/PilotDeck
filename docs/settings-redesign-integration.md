# Settings redesign integration

This branch integrates the net changes from PR #557 (`22c81f8f`) on top of
`upstream/main` (`12ed4a21`), preserving the redesigned settings routes and simpler
controls. The original PR branch is not rewritten.

## Permission preference

The chat composer's **Default Permissions / Full Access** picker owns one global
preference, persisted through `/api/settings/permissions` in the active PilotDeck
home's `permissions.json`:

- `skipPermissions: true` selects Full Access; `false` selects Default Permissions.
- Projects and sessions share the latest saved choice. Legacy browser session
  preferences are ignored. A fresh application reads the server preference.
- Opening Security & Privacy does not write this preference. That page edits tool
  rules and telemetry. Existing allow, ask and deny rules are retained.
- Loading/saving failures block new submissions and provide a retry. Manual writes
  are serialized; failed writes roll back the displayed choice.
- Plan mode remains a per-turn override. Submitted and queued turns retain their
  captured permission mode; changing the preference affects subsequent requests.
- Other windows refresh from the server on the preference storage signal or focus.

## Integration fixes

- The redesigned About page uses main's Release schema and Electron IPC update
  service, retaining clean-Git eligibility, disabled reasons, progress polling,
  interrupted-stream recovery and restart handling.
- Settings CSS is scoped to its layout and notification container, including dark
  and responsive rules, so common class names do not style the chat/onboarding UI.
- Retry settings show their target provider and keep the redesign's primary-model
  provider scope. Switching providers clears an unsaved retry draft. Saving retries
  no longer creates an incomplete, enabled token-saver configuration. A separately
  edited judge timeout keeps an unconfigured token saver disabled.
- Two pre-existing type errors in the redesign were corrected without changing the
  resident-task or model-deletion interactions.

## Model pool behavior

- Provider badges describe configuration completeness: **Configured** when required
  connection fields and models are present, **Pending** when they are missing.
  Connection testing is optional, including when selecting the primary model.
- Provider IDs retain their exact spelling through credential lookup, connection
  tests, saves and model references. Catalog aliases only choose default settings;
  they never rename the stored provider. Custom display names also retain their case. `HXAPI` and `hxapi` remain separate keys.
- Providers may retain valid connection settings with an empty model map. Removing
  the final default model clears its default reference in the same confirmed save;
  references from other features remain protected. Adding the first model to an
  empty pool restores the default on save without requiring a connection test.
- An explicitly saved empty pool keeps the application open across refreshes rather
  than returning to onboarding. Send/model-picker controls are disabled without new
  explanatory copy. Gateway and model-dependent memory scheduling stop; authenticated
  project/session history reads use Gateway's shared disk readers without starting
  another agent runtime. Adding a model resumes normal Gateway operation.
- A successful probe is shown as healthy only after its result is saved. Save
  failures offer a retry using the same test record, without another model probe,
  or a fresh test if the record has expired. Credential and endpoint matching,
  record ownership/expiry checks and model-reference validation remain enforced.

## Connection test tasks

- The server owns each user's running connection test, including saving and manual
  image confirmation. The settings card polls its status; switching providers,
  leaving settings, or refreshing the browser does not stop the task or lose it.
- Test buttons are disabled while reading status, submitting, testing, confirming
  image capabilities, cancelling or saving. Other providers show only a disabled test button. Cancellation aborts the probe and releases the slot after it settles.
- Successful results bind to the latest on-disk config under the config write lock.
  Unrelated edits are preserved; changed credentials/endpoints or removed models
  reject the binding. A failed save can retry without another probe.
- Task snapshots are scoped to the authenticated user and contain no credentials.
  Terminal results are retained in memory for one hour; pending manual confirmation
  and failed-save records expire after ten minutes. Restarting the backend ends
  in-memory tasks. Browser refresh reconnects to the still-running backend task.
- Manual image choices survive repeated polling and equivalent model lists. New
  task IDs reset the dialog; unchanged snapshots do not rerender the card. Slow
  browser checks wait multiple polling cycles between selections and before submit.
- Chromium checks cover provider/page switching, refresh, completion with settings
  closed, grey disabled test buttons, save-failure recovery, cancellation and manual
  image confirmation across navigation.

## Invalid provider recovery

- Provider saves reject malformed URLs and schemes other than HTTP/HTTPS before
  writing, in both the settings form and config API. Connection tests remain optional;
  URL syntax validation does not verify credentials or contact the provider.
- The runtime excludes providers that fail model configuration parsing and records
  a warning, without deleting their stored settings. Valid providers can still run.
  References to an excluded provider remain errors; the primary model is never
  silently switched to another provider.
- Authenticated users can always enter Settings to repair configuration, even when
  the Gateway cannot start. The model configuration error screen links to Model Pool.
- Isolated Chromium checks cover an invalid unused provider with a healthy Gateway,
  rejected saves without file changes, and restarting with an invalid primary
  provider then repairing it through Settings without model API calls.

## Review follow-up

- Service edits merge only service fields into the latest config, preserving retry
  settings saved while the service form was open. Cancelling a new MCP server
  removes its draft before any subsequent service save or removal.
- Custom search endpoint/key edits and connection tests preserve the configured
  authentication mode. Minute-based memory consolidation intervals remain lossless.
- The primary-agent page stays out of navigation. When deleting a referenced default
  model/provider, its dialog saves the replacement default and deletion together.
  This allows recovery from an invalid provider without saving an invalid intermediate
  config. Empty/null model definitions remain valid replacement choices. The removal preview repairs other model references atomically, and a failed save retains the existing config.
- Built-in provider URLs/protocols remain fixed in the form. Model listing honors
  saved custom endpoints; DeepSeek's special list URL applies only to its official
  endpoint. Masked-key origin checks remain enforced.
- A missing cron block or explicitly disabled scheduler displays an enable action; normal users do not
  get an additional master toggle. Implicit defaults match runtime: UTC and one run.
- Unsupported desktop/current/silent notification choices are removed. Saving
  resident parameters preserves the existing preferred channel instead of rewriting it.
- Mobile navigation opens General on the first selection.
- Focused interaction regressions cover these decisions. Isolated Chromium with the
  real config API verifies single-save recovery from a broken built-in provider using
  a null model definition, Gateway/catalog recovery,
  DeepSeek proxy model listing, scheduler enabling and mobile navigation. A separate
  empty-pool round trip verifies last-model/provider removal, history after page and
  process restarts, disabled send/Enter, and restoring the default and Gateway after adding a model.

## Validation

- Web Regression's local suite: **173 files, 1,412 tests passed** with the same
  existing CI exclusions for Playwright E2E, streamSmoother and desktop network tests.
- Model parsing and Pilot config loading tests: **18 passed**.
- Desktop packaging helper tests: **41 passed**; desktop updater network tests passed.
- Permission settings and router parsing tests: **8 passed**.
- UI type checking, Gateway/Web production builds and Electron TypeScript compile passed.
- Real Chromium against an isolated PilotDeck home and ports: all **14 settings
  routes** loaded without page errors; permission changes survived refresh and
  privacy navigation; tool rule additions/removals preserved full access and deny
  rules; retry changes saved through the config API without changing another
  provider. Dark/390px mobile layouts and returning to chat were checked. A probe
  outside settings retained identical computed styles with/without settings CSS.

- Model-pool regression in Chromium against a local mock model endpoint: complete
  untested providers display as configured; masked-key tests save and survive a
  reload without changing either case-sensitive provider key; a failed result save
  retries without another model request; an untested primary model saves directly.

These checks do not perform a signed macOS or Windows cross-version installer
upgrade. The integration preserves main's updater rather than changing packaging.


## Current model-reference navigation and theme coverage

- The retired primary-agent model form and its unused route editors are removed.
  Old `agent-model` links redirect to Model Pool. Primary models are edited in the
  modern Model Pool; individual capabilities remain in its model-settings dialog.
  The saved primary-agent context override is visible and editable there too;
  clearing it restores the model context window used by automatic compaction.
- Removal-preview links carry an exact `reference` query parameter. Main model,
  memory model, and router/subagent references open their current settings owner
  with focus and a visible highlight. Router reference details also expose saved
  scenarios, fallback slots and baseline references absent from the main route form,
  including models with dots or slashes in their IDs. Navigation never applies a
  removal plan or writes config.
- Light-theme brand icons, gradients, selected states, focus rings and shadows use
  opt-in palette tokens. White reading surfaces, neutral controls and semantic
  red/amber/green statuses keep their roles. Dark variants and named palette
  preview swatches retain their own colours.
- `ui/e2e/settings-navigation-theme.smoke.mjs` exercises 14 current settings pages
  in mint/blue, all ten kinds of reference link, the retired route redirect,
  context-override save/reload/clear, window resizing, concurrent-removal recovery,
  the last-model router block, and dark/reload
  behaviour in Chromium and real Electron with isolated profiles. Its API fixture
  uses the production removal planner; server route tests cover the HTTP write
  and revision semantics separately.
- The model-selection browser fixture uses current project/session coordinates
  and the server's accepted-send event. Its regressions verify local unsent drafts,
  session restoration, accepted preferences across tabs, and mint/blue model menus
  and file glyphs.
- This follow-up passed 1,268 UI regressions (excluding the previously failing
  stream-smoothing file), 178 settings checks after the context migration including
  two new override cases, 680 server checks, 115 desktop checks with one skip,
  and 11 model-selection browser checks. Production UI build and desktop compile
  passed. Full UI type checking remains blocked by existing dependency/type errors;
  comparison with the pre-change checkout found no new error signatures. Four
  stream-smoothing failures reproduce on that checkout too.

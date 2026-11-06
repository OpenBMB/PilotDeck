# Testing and validation

Verify the affected behavior first, then the relevant module suite. Keep security, data-integrity, persistence and native-process boundaries; do not hide failures or loosen assertions to make cleanup pass.

## Entry points

Run from the repository root unless noted.

| Scope | Command |
| --- | --- |
| One UI/server module | `pnpm --dir ui exec vitest run <file-or-directory>` |
| UI server / client suites | `pnpm --dir ui test:server` / `pnpm --dir ui test:client` |
| Full UI/server regression | `pnpm --dir ui test` |
| Checkpoint execution and restore | `pnpm test:checkpoints` (build Core first) |
| Changed/related imports | `pnpm --dir ui test:changed` or `pnpm --dir ui test:related src/path/to/file.ts` |
| Model protocol/streaming | `node --import tsx --test "tests/model/**/*.spec.ts"` |
| Desktop helpers | `pnpm --filter pilotdeck-desktop test` |
| Complete built backend suite | `pnpm test` |
| UI type check / build | `pnpm --dir ui typecheck` / `pnpm --dir ui build` |
| Desktop TypeScript | `pnpm --filter pilotdeck-desktop compile` |

Changed/related selection follows import edges, not every dynamically read template, workflow, icon or plugin. Broaden checks for shared protocols, native resources, dependency locks and build inputs. Real browser acceptance belongs under ui/e2e/ and is separate from Vitest discovery.

## Pull request CI selection

Web Regression and Desktop use `apps/desktop/scripts/classify-ci-changes.mjs` to
select complete suites from the PR merge-base diff, including deleted files and
both sides of renames. The lightweight selection jobs always validate routing;
job-level conditions retain existing check names for unrelated changes.

| Changed boundary | PR validation |
| --- | --- |
| Chat/UI components and styles | Full Web/client suite and browser acceptance; no unrelated checkpoint matrix, desktop helpers or Docker rebuild |
| Backend, workspace or checkpoint paths | Web regression and the existing three-platform checkpoint suite; Docker for runtime/image inputs |
| Desktop, installer or release inputs | Desktop helper checks and the complete relevant native packaging matrix |
| Dependency locks, shared package inputs or routing policy | All affected execution boundaries |
| Maintained documentation | Routing checks; runtime skills/resources Markdown still selects builds |
| OBS scripts/workflows | Credential-free OBS tests; no live OBS access from PRs |

The Web browser job pins Ubuntu 24.04 for the locked Playwright version. New PR
pushes cancel superseded Web runs. Web Regression owns the single Docker build,
with GHA layer caching and isolated runtime-import verification. Main pushes
still run full Web/browser and Docker checks; manual Desktop runs and formal
releases retain all native targets. Production signing and publication gates
are independent of PR selection and remain mandatory.

Web Regression also runs tool scheduling and failure propagation, model request
preparation, context cache, plugin prompt projection, steering and active-turn
snapshot contracts against the built backend. These checks
use an isolated `PILOT_HOME` and synthetic runtimes without real provider calls.

## Test quality and isolation

- Every retained case must identify a meaningful regression it would catch. Assert user outcomes, wire payloads, persisted contents, exit results and resource release.
- Mock external providers and uncontrolled systems while exercising the target implementation. Do not preserve obsolete implementation-text assertions after a feature is removed, or delete unique safety cases because they are slow.
- Use isolated PILOT_HOME, profiles, databases and workspaces. Some server modules open a database at import time, so establish isolation before importing them. Declare real Git, Python, shell, symlink and platform prerequisites.
- Use readiness signals, controlled clocks and observable state instead of fixed sleeps. Keep distinct timing, authorization, path-escape, rollback and account-isolation cases; avoid multiplying every language/theme/platform combination without a distinct behavior.
- Small fixtures may be shared; do not create one giant test file or an end-to-end flow for unrelated behavior. Real provider calls require explicit opt-in and synthetic credentials must not be mistaken for production secrets.
- Follow [CONTRIBUTING](../CONTRIBUTING.md) for placement, English documentation and artifact rules. New module tests remain visible to Git; only root test/ and test.ts drafts are ignored.

## Maintained diagnostic checks

Checkpoint execution cases use separate Python, subagent and background-task
files with a shared isolated workspace fixture. Each keeps the runner's 60-second
file deadline instead of sharing one cumulative budget across all execution modes.

First build the relevant Core/Desktop/Web outputs when a command consumes compiled code.

| Check | Entry and prerequisites |
| --- | --- |
| Synthetic startup/history benchmark | `node scripts/benchmark-startup.mjs --samples 3 --sessions 1000 --artifacts artifacts/startup --output artifacts/startup/summary.json`; add --serial for the serial comparison or --root for another compiled checkout |
| Session-list disk benchmark | `node scripts/benchmark-session-list.mjs 1000`; synthetic data, not full client startup time |
| Real desktop fault injection | `node scripts/benchmark-startup.mjs --desktop --fault slow-start --artifacts artifacts/startup --hold-ms 180000`; also abort, oom, module-missing, web-module-missing and config-invalid; a stop file ends the isolated instance |
| Windows installer/shortcut | `node apps/desktop/scripts/verify-installer.cjs` and `node apps/desktop/scripts/verify-installer-shortcut.cjs`; require Windows and desktop build dependencies |
| Windows uninstall boundary | `node apps/desktop/scripts/verify-uninstaller.cjs`; verifies default data retention, localization and update guards |
| Windows native notifications | `pnpm --filter pilotdeck-desktop exec electron scripts/verify-windows-notifications.cjs`; compiled Desktop and an isolated notification identity |
| TUI permissions | `node --import tsx --test tests/adapters/tui-permissions.spec.tsx`; automatic temporary profile, mocked Gateway, no model calls |
| UI import/export analysis | `node scripts/audit-ui-reachability.mjs --exports`; read-only candidates, not automatic deletion authority |

Appearance, native file selection and window chrome acceptance use ui/e2e/appearance.smoke.mjs, file-picker.smoke.mjs and desktop-chrome.smoke.mjs. Prepare their Vite/Desktop prerequisites and isolated profiles. Preview pages do not replace the real startup-flow regression. Native package installation, update, signing and OS permission acceptance remain platform-specific.

Record commands, outcomes and limits in the PR/CI artifacts. Put temporary screenshots, logs, request dumps and benchmark data in ignored artifacts/<topic>/ or outputs/<topic>/, never in a new tracked delivery report. The [session timeline](architecture/session-timeline.md) and [reasoning reference](reasoning-settings.md) are durable contracts, not test-run logs.

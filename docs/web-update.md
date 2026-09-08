# Web self-update

Web self-update is a convenience for standard Git deployments. It installs the
latest stable `vYYYY.MM.DD[-rN]` release from `OpenBMB/PilotDeck`, using the
release manifest's `sourceSha` and verifying that it matches the published tag.
It does not follow the moving tip of `main`.

## Supported deployments

The checkout must be a full, standalone Git clone on `main`, with an official
GitHub remote and no modified, staged, or untracked files. The running build
must come from clean source and match the checkout and build files on disk.
Node 22 and pnpm must be available for installation and building.

Development mode, custom branches, detached HEADs, linked worktrees, local
changes, custom/diverged/ahead commits, shallow clones, Docker, and source
archives do not support the update button. The About page disables it and
explains why. These deployments continue to use their normal manual update
process. Automatic downgrades and Git conflict resolution are not supported.

## Build and running versions

Build both parts before starting a production deployment:

```sh
pnpm install --frozen-lockfile --filter pilotdeck --filter pilotdeck-ui
pnpm run build:web
pnpm --dir ui run start:built
```

The Gateway and UI build hooks each write `web-build.json` in their own `dist`
directory. These record the source SHA, a release tag if known, whether the
source was clean, and the build time. Both builds must identify the same commit.
The server reads the metadata once at startup. Pulling code or rebuilding while
the server is running does not change its reported running version. Missing or
inconsistent metadata disables self-update; rebuild and restart manually.

## Update process

1. Opening settings checks deployment eligibility and queries the latest stable
   unified release. Equal commits report up-to-date. Only an ancestor of the
   release commit may update; ahead/diverged histories require manual handling.
2. Clicking Update submits the exact displayed tag and SHA. The server checks
   eligibility, the release target and an update lock again. A changed target
   requires a fresh check instead of silently installing a different release.
3. The server clones the selected commit into a temporary directory under `.git`,
   installs frozen dependencies and builds both Gateway and UI there. Failures
   during preparation leave the original checkout and artifacts in place.
4. It rechecks the checkout after building, transfers the prepared dependencies
   and build outputs, and fast-forwards `main` to the release commit. It does
   not stash changes or run `git reset --hard`. If that transfer or fast-forward
   fails, it attempts to restore the previous artifacts.
5. “Update and restart” automatically starts the restart after a successful build.
   The existing restart confirmation flow
   waits for a new service instance before reloading the page.

The update is not an atomic deployment across a process crash or power failure,
and it does not roll back databases/configuration after a new version starts.
If restoring artifacts fails, backups and the update lock remain under `.git`;
the server log identifies the backup directory for manual recovery. Do not remove
an update lock while another updater is running.

Each install/build command has a 15-minute limit. On timeout, the updater stops
its managed process group (Windows Job), escalates to a forced stop, and confirms termination before
removing temporary files and releasing the lock. If termination cannot be
confirmed, the request returns `processStopFailed` and retains both the staging
directory and `.git/pilotdeck-update.lock`. Stop the remaining build processes
before removing these retained files and retrying; the live deployment is not
switched in this case.

Preparation progress and failures are logged with `[web-update]`. In-process
status allows the About page to recover an active update or pending restart
when reopened. A pending one-click restart is remembered for the current browser
session, associated with the specific update ID; reopening About resumes it.
A broken progress stream or temporary network failure preserves this intent
and polls `/api/update/status` until the backend confirms the outcome. A
confirmed failure clears the intent, and results from other update IDs cannot
trigger an automatic restart. Other pending updates retain the explicit
restart action.

## CLI and IM

`pilotdeck update --check`, `/update check` and the settings page use the same
Release selection and deployment eligibility policy. The command loads the same
Web configuration and proxy settings. When a Web service is running on the local
`SERVER_PORT` (default 3001), it authenticates with the installation's existing
local credentials, verifies the installation root, and calls the same check,
apply, status and restart APIs as settings. If the Web server selected a fallback
port, set `SERVER_PORT` to that actual port when using CLI/IM. Authentication,
installation mismatch and unexpected server errors do not fall back to a separate
filesystem update.

`pilotdeck update --restart` and `/update` request a restart from the running Web
service only after a confirmed successful update. An interrupted apply stream is
recovered using its update ID. Accepted restart means the runtime accepted the
request; these text commands do not claim to have verified the new instance is
healthy. If restart fails, the message distinguishes the prepared update from the
restart failure and asks for a manual restart. The IM Gateway does not exit itself.

If the Web service is not running, `pilotdeck update` or `scripts/update.sh` can
use the same Release service directly, with a manual restart afterward. `--check`
is supported by both. `--restart` without a running Web service is explicitly
rejected before updating files. Developer workspaces, containers and other
unsupported deployments receive the same eligibility reason as settings.

## Process ownership boundary

Only explicitly managed services and update build commands reserve a process
record before spawning. Their guardians verify process creation identity before
execution and again before shutdown signals. Command completion is separate from
the guardian lifetime. Business subprocesses are not intercepted or given a Node
preload, so launching a background service keeps normal shell semantics.

On POSIX, cleanup covers the registered group, including orphaned processes that
retain that group; arbitrary detached groups/sessions are outside this guarantee.
Windows uses a non-breakaway Job and confirms that its member processes exited.
Registration files live in private `pilotdeck-process-scope-*` temporary directories.
Missing identities, interrupted registrations or an unexpected guardian death
produce `processStopFailed`; update staging and the lock remain for manual
recovery. Never remove a live registry to bypass this failure.

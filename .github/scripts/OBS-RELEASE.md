# Production OBS release synchronization

Only main can use the obs-release Environment. Manual dispatch publishes the
latest formal release resolved at run start. Daily 03:30 Beijing scheduling
requires repository variable OBS_SYNC_ENABLED=true, initially false. Keep
OBS_RETENTION_ENABLED and OBS_DELETE_CHECK_ENABLED false; deletion permission
is not required to upload assets or overwrite the latest pointer.

All assets are locally verified before broker credentials are requested. The
production entry reuses the tested AWS runner, virtual-host settings and seekable
temporary-file readback. Operations remain serial, with a five-minute per-object
limit and one shared min(50 minutes, credential expiry minus two minutes) budget.
All object names, sizes and full content must pass before latest publication.
No delete operations are used. Branch push/PR CI only runs credential-free tests;
it cannot enter the production job or publish a pointer.

PilotDeck/latest.json keeps the website contract: tag, published_at and assets
with name, size and public OBS url. The prior pointer is backed up before writes;
the new JSON is written with application/json and no-store then read back.
resolved-release.json, previous-latest.json, published-latest.json and logs are
retained in the obs-production-sync artifact for 30 days. Logs never include
credentials or raw AWS service errors.

## Activation acceptance

After normal PR review and merge, dispatch release-to-obs.yml on main twice.
Record the pinned tag in each run; if a new formal release appears between runs,
repeat until two successful runs cover the same tag. Confirm exact release names,
sizes and content, then confirm the public website version and all eight installer
URLs with read-only requests (do not emit download telemetry). Only after this
acceptance set OBS_SYNC_ENABLED=true. Record both run links and elapsed times.

If publication or website acceptance fails, keep scheduling disabled. Inspect the
current pointer and obtain fresh broker credentials, then restore the first run's
previous-latest.json to PilotDeck/latest.json using the same S3 virtual-host
settings, JSON content type and no-store policy. Read back and compare the saved
JSON, and confirm the website returns the old tag. Do not delete version assets.
Do not report production acceptance complete before these live checks pass.

# Local managed KM acceptance

Branch: `standalone_alpha1_decouple_km_1013`. No commit, push, production data
change, Docker, or login startup registration was performed.

Passed:

- TypeScript compilation and real `npm run build:web` including packaged runtime.
- Local KM/Agent/modular focused tests: 10 passed.
- Web supervisor regression: 13 passed.
- `report.json`: real independent KM installed from wheel; web PD automatically
  starts KM, HTTP management proxy creates a base/uploads Markdown, job reaches
  succeeded, lexical query returns chunks; duplicate managed startup is rejected;
  PD shutdown stops KM; web restart and standalone CLI restart preserve document ID.
- Fresh venv provision through `start-local-knowledge.mjs --km-package ...
  --prepare-only`, then real `npm run start:local`; second launch skips pip/build.
- Browser opens `/knowledge`, receives independent wheel UI through the iframe
  and parent request bridge, shows Local knowledge, Upload, Tasks, Concepts and
  Suggestions. Screenshot: `pd-managed-km.png`.
- Existing separately deployed `http://127.0.0.1:18890/health/ready` remains ready.

The isolated run used loopback ports 18919/18920/18921 for the one-command demo;
HTTP regression uses dynamically assigned ports and persistent evidence folders.
All demo processes are stopped after verification. Instance data/logs are retained
under this directory for inspection, including SQLite and first-install venv.
No secret model credential is used or copied. The placeholder PD provider at
127.0.0.1:9 is only to pass PD's normal first-time configuration prerequisite;
it is never called, and no real inference is claimed in this acceptance.

Observed prerequisites and repaired checks:

- Fresh PD without a model opens its standard onboarding. This is distinct from
  KM readiness; existing PD model configuration is preserved by provisioning.
- Initial browser assertions expected the older New knowledge base button inside
  the iframe, then treated Upload as a button; current UI uses an Upload label.
  Final check selects the real rendered text and screenshot verifies the page.
- Custom gateway port is propagated to the web bridge URL in the one-command
  launcher. Before repair, the isolated page showed Reconnecting.

Reproduce:

```sh
node --import tsx --test tests/composition/local-knowledge-runtime.spec.ts tests/composition/knowledge-agent.spec.ts tests/composition/knowledge-modular.spec.ts
cd ui && node node_modules/vitest/vitest.mjs run server/webRuntimeSupervisor.test.js
# From repository root, with an independently installed KM Python:
KM_LOCAL_PYTHON=/absolute/path/to/venv/bin/python node scripts/local-knowledge-acceptance.mjs
# With the local one-command demo running after normal PD onboarding:
PD_LOCAL_URL=http://127.0.0.1:18920 node scripts/local-knowledge-browser.mjs
```

This validates automatic startup/provisioning and lexical content persistence.
It does not replace prior full KM or real-model acceptance; desktop installer
bundling of Python, Windows and Linux deployment are not tested here.

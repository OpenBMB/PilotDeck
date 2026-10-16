# Local PilotDeck + Knowledge Deployment

Requirements: the installed PilotDeck Node dependencies, Node 22, Python >=3.11,
and an independent KM wheel (including its UI) or built self-contained KM source.
No Docker, StaffDeck runtime, or separate database server is needed.

From the PilotDeck directory, provision and start with one command:

```sh
npm run start:local -- --km-package /absolute/path/to/knowledge_core-0.1.0-py3-none-any.whl
```

For source installation use the self-contained `knowledge_core` directory after
building its UI. Dependencies are installed on first run into a private venv.
Subsequent starts use `npm run start:local`. Ctrl+C closes PD and its managed KM.
No login startup job is registered. First installation needs package access for
Python dependencies; subsequent startup does not run pip or require Docker.

Optional setup arguments: `--python /path/to/python3`, `--config /path/to/pilotdeck.yaml`,
`--data-directory /persistent/path`, `--port 18891`, `--user-id ID`, `--prepare-only`.
Existing PD settings are preserved with a backup before adding the KM binding.
An existing external knowledge binding is never replaced automatically.
The user binding selects the first active local PD user, or ID 1 for a fresh
no-login installation. Authenticated deployments should select `--user-id`.
Existing PD model settings are retained. A brand-new PD without a configured
chat model still opens its standard first-time model setup; the local KM already
runs and supports lexical retrieval independently of that setup.

Default KM data: `$PILOT_HOME/knowledge` (normally `~/.pilotdeck/knowledge`).
It contains `knowledge.sqlite`, `configuration.json`, `venv`, and `service.log`.
The default port is 18891 to avoid adopting the separately deployed 18890 service.
An occupied port or duplicate managed instance fails startup without stopping
another process. After an abnormal parent exit, a stale startup lock is reclaimed
only if its recorded owner no longer exists; an occupied child port still fails.
Do not launch multiple PD instances against the same managed data directory.

The generated binding enables full management with publication and KM login off;
Agent tools remain query-only until explicitly authorized via `agentMethods`.
There is no default model credential. Supply `localRuntime.modelConfig` for direct
model use, or `capabilitiesFile` for PD hosted capabilities. Otherwise KM uses
lexical retrieval. Module settings belong in `configuration.json`; disabling
existing modules requires the explicit KM offline conversion procedure.

For an already installed KM, configure the existing PD YAML instead:

```yaml
modules:
  knowledge:
    enabled: true
    implementationId: knowledge-core
    frontendModule: knowledge-core
    contract: knowledge-core/v1
    transport: rest-http-v1
    endpoint: http://127.0.0.1:18891
    pilotDeckUserId: '1'
    methods: [query, resolve_citation]
    agentMethods: [query]
    localRuntime:
      python: /absolute/path/to/venv/bin/python
      dataDirectory: /absolute/path/to/knowledge
      configFile: /absolute/path/to/configuration.json
```

For a spaces-enabled KM also set the existing `spaceId` and `spaces` binding.
This short example grants read tools only; the setup command grants the management
operations needed by the full UI. `localRuntime` accepts `modelConfig`,
`identityFile`, `capabilitiesFile`, and `startupTimeoutMs` (default 60000) as well.
All paths must be absolute. Remove `localRuntime` to connect an externally managed
service. The web startup owns KM for web/desktop; standalone `pilotdeck server`
owns it for headless use. Managed runtime changes require restarting PD.

The product still contains a Python KM process. The one-command flow manages it
for the user; it does not embed Python into Node or remove the Python dependency.

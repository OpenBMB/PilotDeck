import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, join, isAbsolute, dirname } from 'node:path';

export function independentBinding(slot, value) {
  if (value?.enabled !== true) return undefined;
  const knowledge = slot === 'knowledge' && value.contract === 'knowledge-core/v1';
  const sop = slot === 'sop' && value.hostAdapter === 'pilotdeck';
  if (!knowledge && !sop) return undefined;
  const contract = knowledge ? 'knowledge-core/v1' : 'sop.lifecycle/v3';
  const transport = knowledge ? 'rest-http-v1' : 'sop-http-v3';
  const implementationId = knowledge ? 'knowledge-core' : 'portable-sop';
  if (value.contract !== contract || value.transport !== transport || value.implementationId !== implementationId)
    throw Error(`Independent ${slot} requires ${implementationId}, ${contract}, ${transport}`);
  if (knowledge && (!value.pilotDeckUserId || !value.spaceId || !value.spaces?.some(row => row.id === value.spaceId)))
    throw Error('Knowledge requires pilotDeckUserId, spaceId and a matching spaces entry');
  if (knowledge && new Set(value.spaces.map(row => row.id)).size !== value.spaces.length)
    throw Error('Knowledge spaces must have unique IDs');
  const mode = value.deployment?.mode ?? 'build';
  if (sop && value.definitionsPath) throw Error('Native SOP exports publish definitions through management; remove definitionsPath');
  if (sop && (typeof value.defaultSopId !== 'string' || !value.defaultSopId.trim()))
    throw Error('Native SOP requires defaultSopId; publish that SOP before starting a default run');
  if (value.bearer || value.apiKey) throw Error(`Use environment credentials for independent ${slot}`);
  if (!['build', 'image', 'external'].includes(mode)) throw Error(`Invalid independent ${slot} deployment mode`);
  if (mode === 'external' && value.localRuntime) throw Error(`Remove ${slot}.localRuntime when exporting an external service`);
  if (mode === 'external') {
    const url = new URL(value.endpoint);
    if (!['http:', 'https:'].includes(url.protocol)) throw Error(`Invalid ${slot} endpoint`);
  }
  if (mode === 'image' && !value.deployment.image) throw Error(`${slot} image is required`);
  if (sop && value.localRuntime) {
    for (const key of Object.keys(value.localRuntime)) {
      if (!['enabled', 'python', 'knowledgeEnabled', 'versionManagementEnabled'].includes(key))
        throw Error(`Cannot export sop.localRuntime.${key}`);
    }
    for (const key of ['knowledgeEnabled', 'versionManagementEnabled']) {
      if (value.localRuntime[key] !== undefined && typeof value.localRuntime[key] !== 'boolean')
        throw Error(`sop.localRuntime.${key} must be boolean`);
    }
  }
  const port = value.deployment?.port ?? (knowledge ? 8787 : 8091);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error(`Invalid ${slot} port`);
  return { kind: 'external', slot, ...value, independent: true, target: value.endpoint,
    deployment: { mode, ...(mode === 'image' ? { image: value.deployment.image } : {}),
      context: '__independent__', dockerfile: 'Dockerfile', port,
      healthPath: knowledge ? '/health/ready' : '/healthz', serviceName: `${slot}-runtime`, builtin: `independent-${slot}` } };
}

export async function prepareIndependent({ output, profile, profilePath, root, knowledgeRoot, copy }) {
  const km = independentBinding('knowledge', profile.modules.knowledge);
  const sop = independentBinding('sop', profile.modules.sop);
  if (!km && !sop) return;
  for (const provider of Object.values(profile.model?.providers ?? {})) {
    if (provider.apiKey && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(provider.apiKey))
      throw Error('Independent exports require environment references for model apiKey');
  }
  await mkdir(join(output, 'config'), { recursive: true });
  for (const binding of [km, sop].filter(Boolean)) {
    if (binding.deployment.mode !== 'build') continue;
    const source = binding.slot === 'knowledge' ? knowledgeRoot : join(root, 'packages/sop-runtime');
    if (!source) throw Error('--knowledge-root is required to build Knowledge Core');
    const sourcePath = resolve(source);
    for (const file of binding.slot === 'knowledge'
      ? ['pyproject.toml', 'setup.py', 'uv.lock', 'ui/package-lock.json', 'src/knowledge_core/cli.py']
      : ['pyproject.toml', 'src/staffdeck_sop_runtime/api.py']) {
      try { await stat(join(sourcePath, file)); } catch { throw Error(`Required independent ${binding.slot} source is missing: ${file}`); }
    }
    const destination = join(output, 'modules', binding.slot);
    for (const entry of binding.slot === 'knowledge' ? ['pyproject.toml', 'setup.py', 'uv.lock', 'ui', 'src/knowledge_core'] : ['pyproject.toml', 'src'])
      await copy(join(sourcePath, entry), join(destination, entry));
    await writeFile(join(destination, 'Dockerfile'), binding.slot === 'knowledge' ? knowledgeDockerfile : sopDockerfile);
  }
  if (km && km.deployment.mode !== 'external') {
    const local = km.localRuntime ?? {};
    for (const key of Object.keys(local)) {
      if (!['enabled', 'python', 'dataDirectory', 'configFile', 'startupTimeoutMs'].includes(key))
        throw Error(`Cannot export knowledge.localRuntime.${key}; Compose generates service identity and host capabilities`);
    }
    let configuration = { preset: 'full', modules: { authentication: true, publication: false } };
    if (local.configFile) {
      const file = isAbsolute(local.configFile) ? local.configFile : resolve(dirname(profilePath), local.configFile);
      configuration = JSON.parse(await readFile(file, 'utf8'));
      configuration.modules = { ...configuration.modules, authentication: true };
      if (!(configuration.modules.spaces ?? configuration.preset === 'full'))
        throw Error('Compose Knowledge requires the spaces module for local space initialization');
      if (configuration.modules.publication === true || configuration.preset === 'full' && configuration.modules.publication !== false)
        throw Error('Compose Knowledge publication requires an external publisher; disable publication explicitly');
    }
    await writeFile(join(output, 'config/knowledge.json'), JSON.stringify(configuration, null, 2));
    await writeFile(join(output, 'config/knowledge-binding.json'), JSON.stringify({
      namespace: km.namespace || 'local', spaces: km.spaces, readOnly: km.readOnly === true,
    }, null, 2));
    await writeFile(join(output, 'config/knowledge-entrypoint.py'), knowledgeEntrypoint);
  }
}

export function rewriteIndependent(deployment) {
  const km = independentBinding('knowledge', deployment.modules.knowledge);
  const sop = independentBinding('sop', deployment.modules.sop);
  for (const binding of [km, sop].filter(Boolean)) {
    const value = deployment.modules[binding.slot];
    delete value.localRuntime;
    if (binding.slot === 'knowledge') {
      value.frontendModule = 'knowledge-core';
      value.credentialEnv ??= 'PILOTDECK_KM_SERVICE_TOKEN';
      value.capabilitiesCredentialEnv ??= 'PILOTDECK_KM_CAPABILITY_TOKEN';
    } else {
      value.frontendModule = 'pilotdeck.sop';
      delete value.management;
    }
  }
}

export function configureIndependentCompose(compose, profile, bindings) {
  const independent = bindings.filter(row => row?.independent);
  if (!independent.length) return;
  const pd = compose.services.pilotdeck;
  pd.ports = ['127.0.0.1:${PILOTDECK_PORT:-3001}:3001'];
  pd.environment.PILOTDECK_CONFIG_PATH = '/root/.pilotdeck/pilotdeck.yaml';
  pd.environment.PILOTDECK_DISABLE_LOCAL_AUTH = '0';
  pd.build.args = { PILOTDECK_BUILD_PROFILE: 'products/pilotdeck-staffdeck-sop/profiles/exported.yaml', PILOTDECK_DISABLE_LOCAL_AUTH: '0' };
  pd.image = undefined;
  for (const binding of independent) {
    const managed = binding.deployment.mode !== 'external';
    if (binding.slot === 'knowledge') {
      const value = profile.modules.knowledge;
      const serviceKey = value.credentialEnv || 'PILOTDECK_KM_SERVICE_TOKEN';
      const capabilityKey = value.capabilitiesCredentialEnv || 'PILOTDECK_KM_CAPABILITY_TOKEN';
      for (const key of [serviceKey, capabilityKey]) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw Error('Invalid Knowledge credential environment name');
        pd.environment[key] = '${' + key + ':?set ' + key + ' in .env}';
      }
      if (!managed) continue;
      const service = compose.services['knowledge-runtime'];
      if (service.build) service.build.args = {
        PYTHON_BASE_IMAGE: '${KM_PYTHON_BASE_IMAGE:-python:3.12-slim}',
        NODE_BASE_IMAGE: '${KM_NODE_BASE_IMAGE:-node:22-bookworm-slim}',
      };
      service.command = ['python', '/config/knowledge-entrypoint.py'];
      service.environment = { KM_SERVICE_TOKEN: pd.environment[serviceKey], KM_CAPABILITIES_BEARER: pd.environment[capabilityKey], KM_PORT: String(binding.deployment.port),
        NO_PROXY: 'pilotdeck,knowledge-runtime,sop-runtime,localhost,127.0.0.1', no_proxy: 'pilotdeck,knowledge-runtime,sop-runtime,localhost,127.0.0.1' };
      service.volumes = ['knowledge-core-data:/data', './config:/config:ro'];
      service.healthcheck.test = ['CMD', 'python', '-c', `from pathlib import Path; from urllib.request import urlopen; assert Path('/tmp/km-initialized').exists(); urlopen('http://127.0.0.1:${binding.deployment.port}/health/ready')`];
      compose.volumes['knowledge-core-data'] = {};
    } else {
      pd.environment.SOP_RUNTIME_PUBLISH_TOKEN = '${SOP_RUNTIME_PUBLISH_TOKEN:?set SOP_RUNTIME_PUBLISH_TOKEN in .env}';
      if (!managed) continue;
      const service = compose.services['sop-runtime'];
      if (service.build) service.build.args = { PYTHON_BASE_IMAGE: '${SOP_PYTHON_BASE_IMAGE:-python:3.12-slim}' };
      service.command = ['python', '-m', 'uvicorn', 'staffdeck_sop_runtime.api:app', '--host', '0.0.0.0', '--port', String(binding.deployment.port)];
      service.environment = { SOP_RUNTIME_DB: '/data/sop-runtime.sqlite', SOP_PUBLISH_TOKEN: pd.environment.SOP_RUNTIME_PUBLISH_TOKEN,
        NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
        SOP_KNOWLEDGE_ENABLED: String(profile.modules.sop.localRuntime?.knowledgeEnabled ?? true),
        SOP_VERSION_MANAGEMENT_ENABLED: String(profile.modules.sop.localRuntime?.versionManagementEnabled ?? true) };
      service.volumes = ['sop-runtime-data:/data'];
      compose.volumes['sop-runtime-data'] = {};
    }
  }
}

const knowledgeDockerfile = `ARG NODE_BASE_IMAGE=node:22-bookworm-slim
ARG PYTHON_BASE_IMAGE=python:3.12-slim
FROM \${NODE_BASE_IMAGE} AS ui
WORKDIR /src/ui
COPY ui/ ./
RUN npm ci && npm run build
FROM \${PYTHON_BASE_IMAGE} AS wheel
WORKDIR /src
COPY pyproject.toml setup.py uv.lock ./
COPY src/ ./src/
COPY --from=ui /src/src/knowledge_core/ui/ ./src/knowledge_core/ui/
RUN pip install --no-cache-dir uv==0.9.5 && mkdir -p /dist && uv export --frozen --no-dev --no-emit-project --no-hashes --format requirements-txt -o /dist/requirements.txt && pip wheel --no-deps --wheel-dir /dist .
FROM \${PYTHON_BASE_IMAGE}
COPY --from=wheel /dist/ /dist/
RUN pip install --no-cache-dir -r /dist/requirements.txt && pip install --no-cache-dir --no-deps /dist/*.whl
WORKDIR /data
CMD ["knowledge-core", "--host", "0.0.0.0"]
`;
const sopDockerfile = `ARG PYTHON_BASE_IMAGE=python:3.12-slim
FROM \${PYTHON_BASE_IMAGE}
WORKDIR /opt/sop
COPY pyproject.toml ./
COPY src/ ./src/
RUN pip install --no-cache-dir .
WORKDIR /data
CMD ["python", "-m", "uvicorn", "staffdeck_sop_runtime.api:app", "--host", "0.0.0.0", "--port", "8091"]
`;

// Initialization uses the installed public HTTP API; health does not call the host.
const knowledgeEntrypoint = `import json, os, subprocess, sys, time
from pathlib import Path
from urllib.request import Request, urlopen
import signal

port = os.environ.get('KM_PORT', '8787')
token = os.environ['KM_SERVICE_TOKEN']
binding = json.loads(Path('/config/knowledge-binding.json').read_text())
Path('/tmp/km-initialized').unlink(missing_ok=True)
identity = {token: {'id': 'pilotdeck', 'tenant_id': binding['namespace'],
    'spaces': [row['id'] for row in binding['spaces']], 'permissions': ['read', 'write']}}
os.umask(0o077)
Path('/tmp/km-identities.json').write_text(json.dumps(identity))
capabilities = [{'tenant_id': binding['namespace'], 'space_id': row['id'],
    'endpoint': 'http://pilotdeck:3001/api/internal/km/capabilities',
    'credential_env': 'KM_CAPABILITIES_BEARER'} for row in binding['spaces']]
Path('/tmp/km-capabilities.json').write_text(json.dumps(capabilities))
child = subprocess.Popen([sys.executable, '-m', 'knowledge_core.cli', '--database-url',
    'sqlite:////data/knowledge.sqlite', '--config', '/config/knowledge.json',
    '--identity-file', '/tmp/km-identities.json', '--capabilities-file', '/tmp/km-capabilities.json',
    '--host', '0.0.0.0', '--port', port])
def stop(signum, frame):
    child.terminate()
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
origin = 'http://127.0.0.1:' + port
try:
    for attempt in range(120):
        if child.poll() is not None: raise RuntimeError('KM exited before initialization')
        try:
            with urlopen(Request(origin + '/api/km/v1/spaces', headers={'Authorization': 'Bearer ' + token}), timeout=2) as response:
                existing = {row['id'] for row in json.load(response)}
            for row in binding['spaces']:
                if row['id'] not in existing:
                    request = Request(origin + '/api/km/v1/spaces', data=json.dumps(row).encode(),
                        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
                    with urlopen(request, timeout=2): pass
            Path('/tmp/km-initialized').touch()
            break
        except OSError:
            time.sleep(0.5)
    else: raise RuntimeError('KM initialization timed out')
    sys.exit(child.wait())
finally:
    if child.poll() is None:
        child.terminate()
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
`;

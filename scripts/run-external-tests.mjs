import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const groups = {
  'model-protocol': 'dist/tests/external/model-protocol.external.js',
  'agent-context-web': 'dist/tests/external/agent-context-web.external.js',
  'router-classify': 'dist/tests/external/router-classify.external.js',
  'wcb-docker': 'dist/tests/external/wcb-docker.external.js',
};

if (process.env.PILOTDECK_RUN_EXTERNAL !== '1') {
  fail('Set PILOTDECK_RUN_EXTERNAL=1 to acknowledge that this command uses real external services.');
}

const group = process.env.PILOTDECK_EXTERNAL_GROUP;
const testFile = group ? groups[group] : undefined;
if (!group || !testFile) {
  fail(`PILOTDECK_EXTERNAL_GROUP must be one of: ${Object.keys(groups).join(', ')}`);
}

const provider = process.env.PILOTDECK_EXTERNAL_PROVIDER?.trim();
if (!provider || !["openai", "anthropic", "google"].includes(provider)) {
  fail('PILOTDECK_EXTERNAL_PROVIDER must be openai, anthropic, or google.');
}

const pilotHome = process.env.PILOT_HOME;
if (!pilotHome || !existsSync(path.join(pilotHome, 'pilotdeck.yaml'))) {
  fail('PILOT_HOME must point to an isolated directory containing pilotdeck.yaml.');
}
if (group === 'agent-context-web' && !webSearchSecretPresent()) {
  fail('agent-context-web requires TAVILY_API_KEY, GLM_WEB_SEARCH_API_KEY, or ZAI_API_KEY.');
}
if (group === 'wcb-docker' && !process.env.PILOTDECK_EXTERNAL_DOCKER_IMAGE?.trim()) {
  fail('wcb-docker requires PILOTDECK_EXTERNAL_DOCKER_IMAGE.');
}

const result = spawnSync(process.execPath, [
  '--test',
  '--test-force-exit',
  '--test-timeout',
  '300000',
  testFile,
], {
  cwd: process.cwd(),
  env: process.env,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});

const output = sanitize(`${result.stdout ?? ''}${result.stderr ?? ''}`);
process.stdout.write(output);
const artifactDir = path.join(process.cwd(), 'artifacts', 'external');
mkdirSync(artifactDir, { recursive: true });
writeFileSync(path.join(artifactDir, `${provider}-${group}.log`), output, 'utf8');

if (result.error) fail(result.error.message);
process.exitCode = result.status ?? 1;

function webSearchSecretPresent() {
  return Boolean(
    process.env.TAVILY_API_KEY?.trim()
      || process.env.GLM_WEB_SEARCH_API_KEY?.trim()
      || process.env.ZAI_API_KEY?.trim(),
  );
}

function sanitize(value) {
  let sanitized = value;
  for (const [name, secret] of Object.entries(process.env)) {
    if (!/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) || !secret || secret.length < 5) continue;
    sanitized = sanitized.split(secret).join('[REDACTED]');
  }
  return sanitized;
}

function fail(message) {
  console.error(`[external-tests] ${message}`);
  process.exit(1);
}

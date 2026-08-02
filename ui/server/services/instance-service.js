import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { instancesDb } from '../database/db.js';
import { canonicalizeProjectPath } from './access-control.js';

const HEALTH_TIMEOUT_MS = 15_000;

function getEncryptionKey() {
  const environmentKey = process.env.PILOTDECK_INSTANCE_ENCRYPTION_KEY;
  if (environmentKey) {
    const decoded = Buffer.from(environmentKey, 'base64');
    if (decoded.length !== 32) throw new Error('PILOTDECK_INSTANCE_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
    return decoded;
  }
  const pilotHome = process.env.PILOT_HOME || path.join(os.homedir(), '.pilotdeck');
  const keyPath = process.env.PILOTDECK_INSTANCE_KEY_PATH || path.join(pilotHome, 'instance-secret.key');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(keyPath)) {
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('base64'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  const decoded = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
  if (decoded.length !== 32) throw new Error(`Invalid instance encryption key at ${keyPath}.`);
  return decoded;
}

export function encryptInstanceSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return {
    encryptedValue: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptInstanceSecret(instanceId) {
  const record = instancesDb.getSecret(instanceId);
  if (!record) return null;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    Buffer.from(record.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(record.auth_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.encrypted_value, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function normalizeInstanceEndpoint(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('Invalid PilotDeck endpoint.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Endpoint must use HTTP(S) and cannot embed credentials.');
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function resolveEndpointAddresses(endpoint) {
  const { hostname } = new URL(endpoint);
  if (net.isIP(hostname)) return [hostname];
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return [...new Set(records.map((record) => record.address))].sort();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { redirect: 'error', ...options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.detail || `HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export function serializeInstance(instance) {
  if (!instance) return null;
  let capabilities = {};
  try { capabilities = JSON.parse(instance.capabilities_json || '{}'); } catch {}
  return {
    id: instance.id,
    ownerUserId: instance.owner_user_id,
    ownerUsername: instance.owner_username,
    ownerDisplayName: instance.owner_display_name,
    name: instance.name,
    kind: instance.kind,
    endpoint: instance.endpoint || undefined,
    status: instance.status,
    isDefault: instance.is_default === 1,
    capabilities,
    approvedBy: instance.approved_by || undefined,
    approvedAt: instance.approved_at || undefined,
    lastCheckedAt: instance.last_checked_at || undefined,
    createdAt: instance.created_at,
    updatedAt: instance.updated_at,
    projectBindings: instancesDb.listProjectBindings(instance.id),
    hasCredential: Boolean(instancesDb.getSecret(instance.id)),
  };
}

export async function testAndApproveInstance(instanceId, adminUserId) {
  const instance = instancesDb.get(instanceId);
  if (!instance || instance.kind !== 'remote' || !instance.endpoint) throw new Error('Remote instance not found.');
  const endpoint = normalizeInstanceEndpoint(instance.endpoint);
  const addresses = await resolveEndpointAddresses(endpoint);
  if (addresses.length === 0) throw new Error('Endpoint did not resolve to an address.');
  const token = decryptInstanceSecret(instanceId);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const [health, models] = await Promise.all([
    fetchWithTimeout(`${endpoint}/health`, { headers }),
    fetchWithTimeout(`${endpoint}/v1/models`, { headers }),
  ]);
  const addressesAfterProbe = await resolveEndpointAddresses(endpoint);
  if (addressesAfterProbe.length !== addresses.length
      || addressesAfterProbe.some((address, index) => address !== addresses[index])) {
    throw new Error('Endpoint DNS changed during approval; retry after DNS is stable.');
  }
  const groupTurn = health?.capabilities?.groupTurn === true
    || models?.capabilities?.groupTurn === true
    || health?.groupTurn === true;
  if (!groupTurn) throw new Error('Remote instance does not advertise the versioned group-turn capability.');
  const advertisedWorkspaceKeys = Array.isArray(models?.workspaceKeys)
    ? models.workspaceKeys.map((value) => String(value))
    : [];
  const bindings = instancesDb.listProjectBindings(instanceId);
  const missingWorkspaceKeys = bindings
    .map((binding) => binding.workspace_key)
    .filter((workspaceKey) => !advertisedWorkspaceKeys.includes(workspaceKey));
  if (bindings.length === 0) throw new Error('Remote instance has no registered project workspace mapping.');
  if (missingWorkspaceKeys.length > 0) {
    throw new Error(`Remote instance does not advertise workspace mapping(s): ${missingWorkspaceKeys.join(', ')}`);
  }
  const capabilities = {
    groupTurn: true,
    delegation: health?.capabilities?.delegation !== false,
    version: health?.version || models?.version || 'unknown',
    approvedAddresses: addresses,
    approvedHostname: new URL(endpoint).hostname,
    workspaceKeys: advertisedWorkspaceKeys,
  };
  return instancesDb.setApproval(instanceId, 'approved', adminUserId, capabilities);
}

export async function assertApprovedRemoteInstance(instanceId, projectPath) {
  const instance = instancesDb.get(instanceId);
  if (!instance || instance.kind !== 'remote' || instance.status !== 'approved') {
    throw new Error('Remote PilotDeck instance is not approved.');
  }
  const binding = instancesDb.getProjectBinding(instanceId, canonicalizeProjectPath(projectPath));
  if (!binding) throw new Error('Remote PilotDeck instance has no workspace mapping for this project.');
  const capabilities = JSON.parse(instance.capabilities_json || '{}');
  const addresses = await resolveEndpointAddresses(instance.endpoint);
  const approved = Array.isArray(capabilities.approvedAddresses) ? capabilities.approvedAddresses : [];
  if (addresses.length === 0 || addresses.some((address) => !approved.includes(address))) {
    instancesDb.setApproval(instanceId, 'pending', null, {});
    throw new Error('Remote endpoint DNS changed after approval; administrator approval is required again.');
  }
  return { instance, binding, token: decryptInstanceSecret(instanceId) };
}

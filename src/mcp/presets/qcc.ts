import { discoverOAuthServerInfo, extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { McpOAuthManager, requireSecureUrl } from '../oauth/manager.js';

export const QCC_ISSUER = 'https://agent.qcc.com';
export const QCC_RESOURCES = ['company', 'risk', 'ipr', 'operation', 'executive'].map(kind => ({
  id: `qcc-${kind}`, url: `${QCC_ISSUER}/mcp/${kind}/stream`,
}));

/** Explicit provider contract: these five resources share one OAuth grant. No domain wildcard. */
export async function createQccPreset(manager: McpOAuthManager, existing: Record<string, unknown>, send: typeof fetch = fetch) {
  if (QCC_RESOURCES.some(({ id }) => Object.hasOwn(existing, id))) throw new Error('QCC preset already exists; existing servers were not overwritten.');
  const secureFetch: typeof fetch = (input, init) => {
    requireSecureUrl(String(input instanceof Request ? input.url : input));
    return send(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  };
  // Discover each canonical resource separately before allowing credential sharing.
  await Promise.all(QCC_RESOURCES.map(async ({ url }) => {
    const challenge = await secureFetch(url, { method: 'GET' });
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(challenge);
    await challenge.body?.cancel();
    const info = await discoverOAuthServerInfo(url, { resourceMetadataUrl, fetchFn: secureFetch });
    if (info.resourceMetadata?.resource !== url || info.authorizationServerUrl !== QCC_ISSUER || info.authorizationServerMetadata?.issuer !== QCC_ISSUER) {
      throw new Error('QCC resource or issuer metadata mismatch. No shared grant was created.');
    }
  }));
  const credentialId = await manager.create(QCC_RESOURCES[0]!.url);
  await manager.store.locked(credentialId, async () => {
    const record = (await manager.store.read(credentialId))!;
    record.resources = QCC_RESOURCES.map(({ url }) => url);
    record.expectedIssuer = QCC_ISSUER;
    await manager.store.write(credentialId, record);
  });
  return Object.fromEntries(QCC_RESOURCES.map(({ id, url }) => [id, { url, oauth: { credentialId } }]));
}

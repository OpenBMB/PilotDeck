/** Trust forwarding headers only from the immediate reverse proxy peer.
 * Local nginx/Caddy work by default; remote proxies require explicit IP/CIDRs.
 */
export function configureTrustedProxy(app, env = process.env) {
  const configured = env.PILOTDECK_TRUST_PROXY?.trim();
  app.set('trust proxy', ['0', 'false'].includes(configured) ? false : configured || 'loopback');
}

# Remote MCP OAuth (local desktop / local Web)

Save an HTTP server in Settings → Extensions → MCP, remove any static Authorization
header, then choose **Prepare OAuth authorization** and **Open authorization in
system browser**. Sign in on the same computer running PilotDeck. The settings
panel polls completion and reloads MCP extensions. There is no API Key to copy.
The explicit link uses the desktop shell's existing external-navigation handler;
it does not interpret `window.open() === null` as an authorization failure.

This first version intentionally supports loopback-hosted UI only. A remote Web
browser cannot call a loopback listener on the server machine. Public callback
routes, reverse-proxy deployment and multi-user account isolation need separate
work. A clickable system-browser link and cancellation remain available while
waiting. Pending login expires in five minutes; retry after restarting PilotDeck.

The official MCP SDK performs discovery, DCR and code exchange with PKCE S256.
The client name is `PilotDeck`; state is checked once before code exchange. A new
login uses an ephemeral IPv4 loopback callback port and matching registration.
Servers requiring preregistered clients are not supported in this first version.

`mcp.json` contains only `oauth: { credentialId: "..." }`, never tokens or PKCE
verifiers. Private records reside in `$PILOT_HOME/credentials/mcp-oauth` (0700
directory / 0600 files, atomic replacement). They are **not encrypted at rest**;
protect the OS account and exclude this directory from shared backups. Generic
credentials are bound to one exact configured resource; changed URLs require new
authorization. Redirects carrying tokens are rejected, including same-host redirects.

On a 401, reload credentials under a filesystem lock before refreshing. Concurrent
requests share a rotated token, including the separate UI and gateway processes
on the same filesystem. There is no distributed/NFS locking guarantee. A crashed
lock holder leaves a lock directory: stop PilotDeck, remove the stale `.lock`
directory in that credential directory, then restart. A live lock is never stolen.
Only the authenticated 401 request is retried once; tool execution failures are
not retried by this layer. Existing MCP retry policy is otherwise unchanged.

Disconnect clears local tokens even when remote revocation fails, and reports
whether refresh-token revocation was confirmed. No remote revocation claim is
made for providers without a revocation endpoint. Removing a server configuration
is not a substitute for disconnecting authorization first.

Automated tests use a mock OAuth provider plus real loopback callbacks and check
PKCE/state, refresh rotation, concurrent refresh, separate-process locking,
resource isolation, persistence/restart, cancellation, disconnect and existing MCP
transport regressions. Real provider SMS and packaged desktop acceptance are
separate release checks, not established by these tests.

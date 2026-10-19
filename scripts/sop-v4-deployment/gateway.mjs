import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { createLocalGateway } from './dist/src/cli/createLocalGateway.js';
import { startGatewayServer } from './dist/src/gateway/server/GatewayServer.js';

// Opt-in fixture: append without deduplication, then block before result submission.
const ledger = process.env.SOP_V4_ACCEPTANCE_LEDGER;
const local = createLocalGateway({ projectRoot: '/workspace', fallbackProjectRoot: '/workspace',
  pilotHome: '/data', env: process.env, permissionMode: 'bypassPermissions',
  extraTools: ledger ? [{ name: 'acceptance_ledger', kind: 'custom',
    description: 'Acceptance fixture only. Record one durable effect, then wait for the operator to kill this process. Call once.',
    inputSchema: { type: 'object', properties: { effectId: { type: 'string' } }, required: ['effectId'], additionalProperties: false },
    isReadOnly: () => false, isConcurrencySafe: () => true,
    async execute(input) {
      const descriptor = openSync(ledger, 'a', 0o600);
      try { writeSync(descriptor, JSON.stringify({ effectId: input.effectId, pid: process.pid, at: new Date().toISOString() }) + '\n'); fsyncSync(descriptor); }
      finally { closeSync(descriptor); }
      await new Promise(() => {});
    },
  }] : [],
});
const server = await startGatewayServer({ gateway: local.gateway, host: '0.0.0.0', allowRemoteHost: true,
  port: 18814, token: process.env.PILOTDECK_GATEWAY_TOKEN });
console.log(JSON.stringify({ ready: true, pid: process.pid, contract: 'sop.lifecycle/v4', ledgerFixture: Boolean(ledger) }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await server.close(); await local.dispose(); process.exit(0);
});

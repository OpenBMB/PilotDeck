#!/usr/bin/env node
// Load the same deployment configuration and proxy settings as the Web server.
import { register } from 'tsx/esm/api';
register();

try {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--check', '--restart'].includes(arg))) throw new Error('Usage: update [--check] [--restart]');
  await import('../ui/server/load-env.js');
  const { installGlobalProxy } = await import('../ui/server/utils/proxy.js');
  const { runWebUpdateCommand } = await import('../ui/server/services/webUpdateCommand.js');
  installGlobalProxy();
  process.exitCode = await runWebUpdateCommand({ checkOnly: args.includes('--check'), restart: args.includes('--restart') });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

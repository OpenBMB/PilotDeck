#!/usr/bin/env node
import { installRuntimeLogging } from '../diagnostics/runtimeLogging.js';
const logging = installRuntimeLogging('gateway', process.argv[2] === 'server');
try {
  const { main } = await import('./pilotdeckMain.js');
  await main();
} catch (error) {
  logging.report(error);
  process.exitCode = 1;
}

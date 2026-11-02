#!/usr/bin/env node
import { webRuntimeLogging } from './runtimeBootstrap.js';
try {
  await import('./application.js');
} catch (error) {
  webRuntimeLogging.report(error);
  process.exitCode = 1;
}

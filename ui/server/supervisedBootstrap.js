// Resolve the existing configuration before loading the full Web route graph.
// Supervisors can start Gateway while the HTTP server finishes initializing.
import './runtimeBootstrap.js';
import './load-env.js';
import { runtimeCoordination } from './services/runtimeCoordination.js';

runtimeCoordination.publishConfigurationState();
await import('./index.js');

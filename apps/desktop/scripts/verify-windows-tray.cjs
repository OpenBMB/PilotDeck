// Backwards-compatible Windows release workflow entry point.
if (process.platform !== 'win32') throw new Error('Run this check on Windows.');
require('./verify-desktop-lifecycle.cjs');

const { loadSigningConfig, applySigningConfig } = require('./scripts/windows-signing.cjs');

module.exports = applySigningConfig(require('./package.json').build, loadSigningConfig());

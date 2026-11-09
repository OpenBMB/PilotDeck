const { app } = require('electron');
const options = JSON.parse(process.env.PILOTDECK_BENCHMARK_OPTIONS);
app.setPath('userData', options.userData);
if (options.title) {
  app.on('browser-window-created', (_, window) => {
    const setTitle = () => { if (!window.isDestroyed()) window.setTitle(options.title); };
    setImmediate(setTitle);
    window.webContents.on('did-finish-load', setTitle);
    window.webContents.on('page-title-updated', event => { event.preventDefault(); setTitle(); });
  });
}
if (options.oom) {
  const Module = require('node:module');
  const original = Module._load;
  Module._load = function (request, ...rest) {
    const loaded = original.call(this, request, ...rest);
    if (String(request).replaceAll('\\', '/').endsWith('/ui/server/utils/processTree.js')) {
      return { ...loaded, spawnManaged(command, argv, ...args) {
        return loaded.spawnManaged(command, argv.includes(options.gatewayEntry) ? ['--max-old-space-size=16', ...argv] : argv, ...args);
      } };
    }
    return loaded;
  };
}
require(options.mainEntry);

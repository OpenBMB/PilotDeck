const fs = require('node:fs');

// Node 22's native cpSync fast path can reinterpret Unicode paths using the
// Windows code page. A filter selects Node's JS/libuv implementation instead.
function copyFilesSync(source, destination, options = {}) {
  return fs.cpSync(source, destination, process.platform === 'win32'
    ? { ...options, filter: options.filter ?? (() => true) } : options);
}

module.exports = { copyFilesSync };

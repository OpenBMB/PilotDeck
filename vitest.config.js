import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));
const uiNodeModules = resolve(rootDir, 'ui/node_modules');

export default defineConfig({
  resolve: {
    alias: {
      react: resolve(uiNodeModules, 'react'),
      'react-dom': resolve(uiNodeModules, 'react-dom'),
      'react/jsx-dev-runtime': resolve(uiNodeModules, 'react/jsx-dev-runtime.js'),
      'react/jsx-runtime': resolve(uiNodeModules, 'react/jsx-runtime.js'),
    },
  },
  test: {
    setupFiles: [resolve(rootDir, 'vitest.setup.ts')],
  },
});

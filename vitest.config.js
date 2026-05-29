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
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: [resolve(rootDir, 'vitest.setup.ts')],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.d.ts', 'src/context/memory/edgeclaw-memory-core/**'],
    },
  },
});

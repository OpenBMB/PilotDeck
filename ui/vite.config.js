import path from 'path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

function compositionModuleGraphPlugin() {
  const modulesRoot = path.resolve(__dirname, 'src', 'composition', 'modules')
  return {
    name: 'pilotdeck-composition-module-graph',
    generateBundle() {
      const modules = [...this.getModuleIds()]
        .filter((id) => id.startsWith(modulesRoot))
        .map((id) => path.relative(repoRoot, id).replaceAll(path.sep, '/'))
        .sort()
      this.emitFile({
        type: 'asset',
        fileName: 'composition-modules.json',
        source: `${JSON.stringify({ modules }, null, 2)}\n`,
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Load the single root .env and let exported shell vars override file values.
  const env = {
    ...loadEnv(mode, repoRoot, ''),
    ...process.env,
  }

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = env.PROXY_HOST || getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001
  const localNodeModules = (...segments) =>
    path.resolve(process.cwd(), 'node_modules', ...segments)
  // Keep this list to direct dependencies: pnpm does not expose transitive
  // packages at the root used by resolve.dedupe and optimizeDeps.include.
  const codeMirrorDependencies = [
    '@codemirror/lang-css',
    '@codemirror/lang-html',
    '@codemirror/lang-javascript',
    '@codemirror/lang-json',
    '@codemirror/lang-markdown',
    '@codemirror/lang-python',
    '@codemirror/language',
    '@codemirror/merge',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/theme-one-dark',
    '@codemirror/view',
    '@replit/codemirror-minimap',
    '@uiw/react-codemirror',
  ]

  const disableLocalAuth =
    env.PILOTDECK_DISABLE_LOCAL_AUTH !== '0' &&
    env.PILOTDECK_DISABLE_LOCAL_AUTH !== 'false'
  const buildInputs = env.PILOTDECK_INCLUDE_COMPOSITION_PROTOTYPE === 'true'
    ? {
      app: path.resolve(__dirname, 'index.html'),
      composition: path.resolve(__dirname, 'composition.html'),
    }
    : path.resolve(__dirname, 'index.html')

  return {
    define: {
      'import.meta.env.VITE_DISABLE_LOCAL_AUTH': JSON.stringify(disableLocalAuth ? 'true' : 'false'),
    },
    plugins: [react(), compositionModuleGraphPlugin()],
    resolve: {
      // Extensions and the React wrapper must share the same CodeMirror state
      // instance, including after dependency updates or a Vite cache rebuild.
      dedupe: ['react', 'react-dom', ...codeMirrorDependencies],
      alias: {
        react: localNodeModules('react'),
        'react-dom': localNodeModules('react-dom'),
        'react/jsx-runtime': localNodeModules('react', 'jsx-runtime.js'),
        'react/jsx-dev-runtime': localNodeModules('react', 'jsx-dev-runtime.js'),
      }
    },
    optimizeDeps: {
      // Pre-bundle the wrapper and extensions together to avoid mixing
      // optimized and source instances in development.
      include: codeMirrorDependencies,
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        '/memory-dashboard': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true,
          timeout: 0,
          proxyTimeout: 0,
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true,
          timeout: 0,
          proxyTimeout: 0,
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        input: buildInputs,
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-codemirror': [
              '@uiw/react-codemirror',
              '@codemirror/lang-css',
              '@codemirror/lang-html',
              '@codemirror/lang-javascript',
              '@codemirror/lang-json',
              '@codemirror/lang-markdown',
              '@codemirror/lang-python',
              '@codemirror/theme-one-dark'
            ],
            'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-clipboard', '@xterm/addon-webgl']
          }
        }
      }
    },
    test: {
      environment: 'jsdom',
      exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
      server: {
        deps: {
          inline: ['react', 'react-dom']
        }
      }
    }
  }
})

import path from 'path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

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

  const disableLocalAuth =
    env.PILOTDECK_DISABLE_LOCAL_AUTH !== '0' &&
    env.PILOTDECK_DISABLE_LOCAL_AUTH !== 'false'

  return {
    define: {
      'import.meta.env.VITE_DISABLE_LOCAL_AUTH': JSON.stringify(disableLocalAuth ? 'true' : 'false'),
    },
    plugins: [react()],
    resolve: {
      alias: {
        react: localNodeModules('react'),
        'react-dom': localNodeModules('react-dom'),
        'react/jsx-runtime': localNodeModules('react', 'jsx-runtime.js'),
        'react/jsx-dev-runtime': localNodeModules('react', 'jsx-dev-runtime.js'),
      }
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        '/memory-dashboard': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
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
      server: {
        deps: {
          inline: ['react', 'react-dom']
        }
      }
    }
  }
})

#!/usr/bin/env node

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  getPilotDeckConfigPath,
  readPilotDeckConfigFile,
  validatePilotDeckConfig,
} from './services/pilotdeckConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.join(__dirname, '../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
};

const c = {
  info: (text) => `${colors.cyan}${text}${colors.reset}`,
  ok: (text) => `${colors.green}${text}${colors.reset}`,
  warn: (text) => `${colors.yellow}${text}${colors.reset}`,
  error: (text) => `${colors.red}${text}${colors.reset}`,
  tip: (text) => `${colors.blue}${text}${colors.reset}`,
  bright: (text) => `${colors.bright}${text}${colors.reset}`,
  dim: (text) => `${colors.dim}${text}${colors.reset}`,
};

function defaultDatabasePath() {
  return path.join(process.env.PILOT_HOME || path.join(os.homedir(), '.pilotdeck'), 'auth.db');
}

function getInstallDir() {
  return path.join(__dirname, '..');
}

function parseArgs(args) {
  const parsed = { command: 'start', options: {} };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--port' || arg === '-p') {
      parsed.options.serverPort = args[++index];
    } else if (arg.startsWith('--port=')) {
      parsed.options.serverPort = arg.split('=')[1];
    } else if (arg === '--database-path') {
      parsed.options.databasePath = args[++index];
    } else if (arg.startsWith('--database-path=')) {
      parsed.options.databasePath = arg.split('=')[1];
    } else if (arg === '--config') {
      parsed.options.configPath = args[++index];
    } else if (arg.startsWith('--config=')) {
      parsed.options.configPath = arg.split('=')[1];
    } else if (arg === '--help' || arg === '-h') {
      parsed.command = 'help';
    } else if (arg === '--version' || arg === '-v') {
      parsed.command = 'version';
    } else if (!arg.startsWith('-')) {
      parsed.command = arg;
    }
  }

  return parsed;
}

function applyOptions(options) {
  if (options.serverPort) process.env.SERVER_PORT = options.serverPort;
  else if (!process.env.SERVER_PORT && process.env.PORT) process.env.SERVER_PORT = process.env.PORT;

  if (options.databasePath) process.env.DATABASE_PATH = options.databasePath;
  if (options.configPath) process.env.PILOTDECK_CONFIG_PATH = options.configPath;
  if (!process.env.DATABASE_PATH) process.env.DATABASE_PATH = defaultDatabasePath();
}

function showHelp() {
  console.log(`
${c.bright('pilotdeck - Command Line Tool')}

Usage:
  pilotdeck [command] [options]

Commands:
  start          Start the PilotDeck web UI (default)
  status         Show configuration and data locations
  help           Show this help information
  version        Show version information

Options:
  -p, --port <port>             Set server port (default: 3001)
  --database-path <path>        Set database location
  --config <path>               Set pilotdeck.yaml location
  -h, --help                    Show this help information
  -v, --version                 Show version information

Examples:
  pilotdeck
  pilotdeck --port 8080
  pilotdeck status

Configuration:
  PilotDeck reads ~/.pilotdeck/pilotdeck.yaml by default.
  First run opens the onboarding UI if no usable config exists.
`);
}

function showVersion() {
  console.log(packageJson.version);
}

function hasUsableConfig(record) {
  const validation = validatePilotDeckConfig(record.config);
  if (!record.exists || !validation.valid) return false;
  const mainModel = record.config?.agents?.main?.model;
  const entry = mainModel ? record.config?.models?.entries?.[mainModel] : null;
  const provider = entry?.provider ? record.config?.models?.providers?.[entry.provider] : null;
  return Boolean(mainModel && entry?.name && provider?.baseUrl && provider?.apiKey);
}

function showStatus() {
  const configPath = getPilotDeckConfigPath();
  const record = readPilotDeckConfigFile();
  const dbPath = process.env.DATABASE_PATH || defaultDatabasePath();

  console.log(`\n${c.bright('pilotdeck - Status')}\n`);
  console.log(c.dim('═'.repeat(60)));
  console.log(`\n${c.info('[INFO]')} Version: ${c.bright(packageJson.version)}`);
  console.log(`${c.info('[INFO]')} Installation Directory: ${c.dim(getInstallDir())}`);
  console.log(`${c.info('[INFO]')} Server Port: ${c.bright(process.env.SERVER_PORT || '3001')}`);
  console.log(`${c.info('[INFO]')} Config File: ${c.dim(configPath)}`);
  console.log(`       Status: ${record.exists ? c.ok('[OK] Exists') : c.warn('[WARN] Not found')}`);
  console.log(`       Onboarding: ${hasUsableConfig(record) ? c.ok('[OK] Complete') : c.warn('[WARN] Required')}`);
  console.log(`${c.info('[INFO]')} Database: ${c.dim(dbPath)}`);
  console.log(`       Status: ${fs.existsSync(dbPath) ? c.ok('[OK] Exists') : c.warn('[WARN] Not created yet')}`);
  console.log('\n' + c.dim('═'.repeat(60)));
  console.log(`\n${c.tip('[TIP]')} Start with ${c.bright('pilotdeck')} and open http://localhost:${process.env.SERVER_PORT || '3001'}\n`);
}

function assertPortAvailable(port, host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Try: pilotdeck --port ${Number(port) + 1}`));
      } else {
        reject(error);
      }
    });
    server.once('listening', () => {
      server.close(() => resolve());
    });
    server.listen(Number(port), host);
  });
}

function ensureFrontendBuild() {
  const installDir = getInstallDir();
  const distIndexPath = path.join(installDir, 'dist', 'index.html');
  if (fs.existsSync(distIndexPath)) return;

  console.log(`${c.warn('[WARN]')} Frontend build not found at ${c.dim(distIndexPath)}`);
  console.log(`${c.info('[INFO]')} Building frontend before starting production server...`);

  const result = spawnSync('npm', ['run', 'build'], {
    cwd: installDir,
    stdio: 'inherit',
    env: { ...process.env, HUSKY: '0' },
  });

  if (result.status !== 0) {
    throw new Error('Frontend build failed. Run "cd ui && npm install && npm run build" manually, then retry pilotdeck.');
  }

  if (!fs.existsSync(distIndexPath)) {
    throw new Error(`Frontend build completed but ${distIndexPath} was not created.`);
  }
}

async function startServer() {
  const host = process.env.HOST || '127.0.0.1';
  const port = process.env.SERVER_PORT || '3001';
  await assertPortAvailable(port, host);
  ensureFrontendBuild();

  console.log(`\n${c.bright('pilotdeck')} starting...\n`);
  console.log(`${c.info('[INFO]')} Config: ${c.dim(getPilotDeckConfigPath())}`);
  console.log(`${c.info('[INFO]')} Database: ${c.dim(process.env.DATABASE_PATH || defaultDatabasePath())}`);
  console.log(`${c.info('[INFO]')} Server: http://localhost:${port}\n`);

  await import('./index.js');
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  applyOptions(options);

  switch (command) {
    case 'start':
      await startServer();
      break;
    case 'status':
    case 'info':
      showStatus();
      break;
    case 'help':
      showHelp();
      break;
    case 'version':
      showVersion();
      break;
    default:
      console.error(`${c.error('[ERROR]')} Unknown command: ${command}`);
      console.error(`Run ${c.bright('pilotdeck help')} for usage information.`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`${c.error('[ERROR]')} ${error.message}`);
  process.exit(1);
});

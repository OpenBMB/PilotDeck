import { closeSync, createWriteStream, existsSync, mkdtempSync, openSync, readSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isChinaMirrorPreset } from './download-sources.mjs';

export function electronDownloadOptions(version, arch, env = process.env) {
  // Match @electron/get's configuration precedence before choosing directory defaults.
  const configured = name => {
    const snake = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    return [env[`npm_config_electron_${name.toLowerCase()}`], env[`NPM_CONFIG_ELECTRON_${snake.toUpperCase()}`],
      env[`npm_config_electron_${snake}`], env[`npm_package_config_electron_${name}`],
      env[`npm_package_config_electron_${snake}`], env[`ELECTRON_${snake.toUpperCase()}`]]
      .map(value => value?.trim()).find(Boolean);
  };
  const mirror = configured('mirror') || (isChinaMirrorPreset(env)
    ? 'https://cdn.npmmirror.com/binaries/electron/'
    : 'https://github.com/electron/electron/releases/download/');
  const base = mirror.replace(/\/*$/, '/');
  const customDir = configured('customDir') || (new URL(base).hostname === 'cdn.npmmirror.com' ? '{{ version }}' : `v${version}`);
  const customFilename = configured('customFilename');
  return {
    version, arch, platform: 'linux', artifactName: 'electron',
    cacheRoot: env.electron_config_cache || undefined,
    mirrorOptions: {
      mirror: base,
      customDir,
      // Pin the resolved URL so @electron/get cannot reapply a different mirror.
      resolveAssetURL: async details => {
        const directory = customDir.replace('{{ version }}', details.version.replace(/^v/, ''));
        const filename = customFilename || (details.isGeneric ? details.artifactName
          : `${details.artifactName}-${details.version}-${details.platform}-${details.arch}.zip`);
        return `${base}${directory}/${filename}`;
      },
    },
    downloadOptions: {
      getProgressCallback: progress => {
        if (Date.now() - lastProgress >= 10_000) {
          console.log(`[desktop] Electron downloaded ${Math.round(progress.transferred / 1048576)} MB (${Math.round(progress.percent * 100)}%)`);
          lastProgress = Date.now();
        }
      },
    },
  };
}
let lastProgress = 0;

export function createElectronDownloader(electronRequire, env = process.env) {
  const getRequire = createRequire(electronRequire.resolve('@electron/get'));
  const { fetch, EnvHttpProxyAgent } = getRequire('undici');
  const value = (upper, lower) => [env[upper], env[lower]].map(item => item?.trim()).find(Boolean);
  const httpProxy = value('HTTP_PROXY', 'http_proxy');
  const httpsProxy = value('HTTPS_PROXY', 'https_proxy');
  if (!httpProxy && !httpsProxy) return boundedDownloader(fetch);
  return { async download(url, target, options) {
    const agent = new EnvHttpProxyAgent({ httpProxy: httpProxy || '', httpsProxy: httpsProxy || httpProxy || '',
      noProxy: value('NO_PROXY', 'no_proxy') || '' });
    try {
      await boundedDownloader((address, request) => fetch(address, { ...request, dispatcher: agent }))
        .download(url, target, options);
    } finally {
      await agent.destroy();
    }
  } };
}

export const downloadTimeouts = { connect: 15_000, socket: 60_000, request: 900_000 };
export function boundedDownloader(request = globalThis.fetch, timeouts = downloadTimeouts) {
  return { async download(url, target, options = {}) {
    const controller = new AbortController();
    let response;
    let idleTimer;
    let connectTimer;
    const abort = message => controller.abort(new Error(`Electron download ${message} timeout`));
    const totalTimer = setTimeout(() => abort('total'), timeouts.request);
    try {
      for (let redirects = 0; ; redirects++) {
        connectTimer = setTimeout(() => abort('connection'), timeouts.connect);
        response = await request(url, { signal: controller.signal, redirect: 'manual' });
        clearTimeout(connectTimer);
        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
          await response.body?.cancel();
          if (redirects >= 10) throw new Error('Too many Electron download redirects');
          url = new URL(response.headers.get('location'), url).href;
          continue;
        }
        if (response.status !== 200) throw new Error(`Electron download HTTP ${response.status}`);
        break;
      }
      let transferred = 0;
      const total = Number(response.headers.get('content-length')) || 0;
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => abort('idle'), timeouts.socket);
      };
      resetIdleTimer();
      const progress = new Transform({ transform(chunk, encoding, callback) {
        resetIdleTimer();
        transferred += chunk.length;
        options.getProgressCallback?.({ transferred, total, percent: total ? transferred / total : 0 });
        callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(target), { signal: controller.signal });
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(connectTimer);
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      controller.abort();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  } };
}

export async function prepareElectron({ desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  env = process.env, arch = env.PILOTDECK_DESKTOP_NODE_ARCH || process.arch,
  download, extract } = {}) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported Linux Electron architecture: ${arch}`);
  const desktopRequire = createRequire(join(desktopRoot, 'package.json'));
  const electronRoot = dirname(desktopRequire.resolve('electron/package.json'));
  const electronRequire = createRequire(join(electronRoot, 'package.json'));
  const { version } = electronRequire('./package.json');
  const dist = join(electronRoot, 'dist');
  const binary = join(dist, 'electron');
  if (existsSync(join(dist, '.pilotdeck-prepared')) && existsSync(binary) && existsSync(join(dist, 'version')) &&
      readFileSync(join(dist, 'version'), 'utf8').trim().replace(/^v/, '') === version) {
    const header = Buffer.alloc(20);
    const descriptor = openSync(binary, 'r');
    let bytesRead;
    try { bytesRead = readSync(descriptor, header, 0, header.length, 0); }
    finally { closeSync(descriptor); }
    if (bytesRead === 20 && header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
        header.readUInt16LE(18) === (arch === 'x64' ? 62 : 183)) {
      writeFileSync(join(electronRoot, 'path.txt'), 'electron');
      console.log(`[desktop] Electron ${version} linux/${arch} already prepared: ${dist}`);
      return dist;
    }
  }
  const options = electronDownloadOptions(version, arch, env);
  options.checksums = electronRequire('./checksums.json');
  if (!download) {
    const electronGet = electronRequire('@electron/get');
    download = electronGet.downloadArtifact;
    options.downloader = createElectronDownloader(electronRequire, env);
  }
  extract ||= electronRequire('@electron-internal/extract-zip').extract;
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[desktop] Electron ${version} linux/${arch}: ${options.mirrorOptions.mirror} (attempt ${attempt}/3)`);
    let staging;
    try {
      const archive = await download(options);
      staging = mkdtempSync(join(electronRoot, '.dist-'));
      await extract(archive, { dir: staging });
      if (existsSync(join(staging, 'electron.d.ts'))) renameSync(join(staging, 'electron.d.ts'), join(electronRoot, 'electron.d.ts'));
      // Only publish a distribution after extraction has completed successfully.
      writeFileSync(join(staging, '.pilotdeck-prepared'), '');
      rmSync(dist, { recursive: true, force: true });
      renameSync(staging, dist);
      writeFileSync(join(electronRoot, 'path.txt'), 'electron');
      console.log(`[desktop] Electron ready: ${dist}`);
      return dist;
    } catch (error) {
      console.error(`[desktop] Electron attempt ${attempt} failed: ${error.message}`);
      if (attempt === 3) throw new Error(`Cannot prepare Electron ${version} linux/${arch} after 3 attempts`, { cause: error });
    } finally {
      if (staging) rmSync(staging, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareElectron().catch(error => { console.error(error); process.exitCode = 1; });
}

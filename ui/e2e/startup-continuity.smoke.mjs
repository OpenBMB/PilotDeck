// Run after `pnpm --dir ui build`. All APIs are synthetic; no user profile,
// backend, or model is used. Checks the shared renderer used by every client.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'ui/dist');
const artifacts = path.join(root, 'artifacts/startup-continuity');
await fs.mkdir(artifacts, { recursive: true });
const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(dist + path.sep)) { res.writeHead(404).end(); return; }
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const [name, desktop, dark, reduced] of [
    ['desktop-light', true, false, false], ['desktop-dark', true, true, false],
    ['web-light', false, false, false], ['web-dark', false, true, false],
    ['desktop-reduced-motion', true, false, true],
  ]) {
    const context = await browser.newContext({ colorScheme: dark ? 'dark' : 'light', reducedMotion: reduced ? 'reduce' : 'no-preference', serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(({ desktop, dark }) => {
        localStorage.setItem('themeMode', dark ? 'dark' : 'light');
        localStorage.setItem('userLanguage', 'en');
        const runtimeStartedAt = Date.now() - 6000;
        const phaseStartedAt = Date.now() - 1000;
        if (desktop) window.pilotdeckDesktop = {
          getAppearance: () => ({ language: 'en', themeMode: dark ? 'dark' : 'light' }),
          getRuntimeStatus: () => ({ phase: 'ready', progress: 96, startedAt: runtimeStartedAt, phaseStartedAt }),
          onRuntimeStatus: () => () => {},
        };
        window.startupSamples = [];
        let firstBar;
        const sample = () => {
          const frame = document.querySelector('.pd-startup-screen');
          const bar = document.querySelector('.pd-startup-bar');
          if (frame && bar) {
            firstBar ??= bar;
            const track = bar.parentElement.getBoundingClientRect();
            window.startupSamples.push({
              background: getComputedStyle(frame).backgroundColor,
              progress: bar.getBoundingClientRect().width / track.width * 100,
              trackTop: track.top,
              leaving: frame.dataset.leaving === 'true',
              sameBar: bar === firstBar, frames: document.querySelectorAll('.pd-startup-screen').length,
            });
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, { desktop, dark });
      await page.route('**/api/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        let body = {};
        if (pathname === '/api/auth/status') body = { authDisabled: true };
        else if (pathname.includes('onboarding-status')) {
          await new Promise(resolve => setTimeout(resolve, 300));
          body = { configuration: { state: 'ready', modelRef: 'fixture/model', revision: '' }, gateway: { state: 'ready' } };
        } else if (pathname === '/api/projects') body = [];
        else if (pathname.includes('/plugins')) body = { plugins: [] };
        else if (pathname.includes('/tasks')) body = { tasks: [] };
        else if (pathname.includes('/skills')) body = { skills: [] };
        else if (pathname.includes('runtime-status')) body = { gateway: { state: 'ready' } };
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.routeWebSocket('**/ws**', socket => socket.onMessage(() => {}));
      // Hold the application chunk so we can inspect the pre-React HTML too.
      let releaseApp;
      const appGate = new Promise(resolve => { releaseApp = resolve; });
      await page.route(/\/assets\/App-[^/]+\.js$/, async route => { await appGate; await route.continue(); });
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#startup')).toBeVisible();
        const expected = dark ? 'rgb(35, 37, 43)' : 'rgb(255, 255, 255)';
        await expect(page.locator('#startup')).toHaveCSS('background-color', expected);
        if (desktop) expect(await page.locator('#bar').evaluate(bar => bar.getBoundingClientRect().width / bar.parentElement.getBoundingClientRect().width * 100)).toBeGreaterThanOrEqual(96);
        await page.screenshot({ path: path.join(artifacts, `${name}-before-react.png`) });
        if (desktop) {
          const before = await page.locator('.pd-startup-track').boundingBox();
          // Preload installs the caption after the initial HTML can paint.
          // Its new inset must not move the already-visible loading bar.
          await page.evaluate(() => {
            document.documentElement.style.setProperty('--desktop-caption-height', '32px');
            const caption = document.createElement('div');
            caption.id = 'startup-caption-fixture';
            caption.style.cssText = 'position:fixed;inset:0 0 auto;height:32px;z-index:10000';
            document.body.append(caption);
          });
          const after = await page.locator('.pd-startup-track').boundingBox();
          expect(Math.abs(after.y - before.y), 'caption appearance must preserve the progress bar Y position').toBeLessThanOrEqual(.25);
        }
      } finally { releaseApp(); }
      await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30000 });
      await expect(page.locator('.pd-startup-screen')).toHaveCount(0);
      const samples = await page.evaluate(() => window.startupSamples);
      expect(samples.length).toBeGreaterThan(1);
      for (let i = 0; i < samples.length; i++) {
        expect(samples[i].background).toBe(dark ? 'rgb(35, 37, 43)' : 'rgb(255, 255, 255)');
        expect(samples[i].sameBar).toBe(true);
        expect(samples[i].frames).toBe(1);
        expect(Math.abs(samples[i].trackTop - samples[0].trackTop), 'loading bar must stay vertically fixed through caption, React handoff and fade-out').toBeLessThanOrEqual(.5);
        if (i) expect(samples[i].progress).toBeGreaterThanOrEqual(samples[i - 1].progress - 0.1);
      }
      expect(errors).toEqual([]);
      await fs.writeFile(path.join(artifacts, `${name}.json`), JSON.stringify(samples, null, 2));
      await page.screenshot({ path: path.join(artifacts, `${name}-workspace.png`) });
      console.log(`PASS ${name}: ${samples.length} painted samples, one frame/bar, stable canvas/Y position, progress never restarts`);
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

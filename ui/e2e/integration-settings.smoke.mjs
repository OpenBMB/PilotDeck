// Vite on 5187; synthetic settings only. Never requests native OS permissions.
import { chromium, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
const base = process.env.PILOTDECK_SMOKE_URL || 'http://127.0.0.1:5187';
const output = resolve('artifacts/settings-integrations');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PILOTDECK_TEST_BROWSER_CHANNEL || 'chrome', headless: true });
const cases = [
  ['zh-CN', 'light', 'default', 'win32'], ['en', 'dark', 'blue', 'win32'],
  ['en', 'light', 'gray', 'darwin'], ['zh-CN', 'dark', 'gray', 'linux'],
];
const examples = { win32: 'C:\\Program Files\\LibreOffice\\program\\soffice.com', darwin: '/Applications/LibreOffice.app/Contents/MacOS/soffice', linux: '/usr/bin/soffice' };
const textStyle = element => {
  const css = getComputedStyle(element);
  return Object.fromEntries(['fontSize', 'fontWeight', 'lineHeight', 'letterSpacing'].map(key => [key, css[key]]));
};
async function ready(page) { await expect(page.locator('.pd-startup-screen')).toHaveCount(0, { timeout: 60000 }); }
try {
  for (const [language, mode, preset, platform] of cases) {
    const translations = JSON.parse(await readFile(new URL(`../src/i18n/locales/${language}/settings.json`, import.meta.url), 'utf8'));
    const office = translations.pilotDeckConfig.panels.officePreview, computer = translations.computerUse;
    const context = await browser.newContext({ viewport: { width: 1129, height: 1039 } });
    await context.addInitScript(({ language, mode, preset }) => {
      localStorage.setItem('userLanguage', language); localStorage.setItem('themeMode', mode);
      localStorage.setItem('pilotdeck-light-appearance-v1', JSON.stringify({ preset }));
    }, { language, mode, preset });
    let config = { agent: { model: 'test/model' }, webui: { officePreview: { service: 'libreoffice', binaryPath: '' } } };
    let revision = 1, rejectSave = 0, officePlatform = platform, rechecks = 0;
    const probes = [], operations = [], errors = [];
    let computerStatus = { platform, available: true, enabled: false, phase: 'disabled', version: '0.34.1',
      ...(platform === 'darwin' ? { permissionAppPath: '/Applications/PilotDeck.app', permissions: { accessibility: false, screenRecording: false } } : {}),
      ...(platform === 'linux' ? { desktopSession: 'wayland' } : {}) };
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      let body = {}, status = 200;
      if (path === '/api/auth/status') body = { authDisabled: true };
      else if (path === '/api/config') {
        if (request.method() === 'PUT') {
          operations.push('save');
          if (rejectSave) { status = rejectSave; body = { error: 'Synthetic save rejected' }; }
          else { config = parse(request.postDataJSON().raw); revision++; }
        }
        if (status === 200) body = { exists: true, raw: JSON.stringify(config), config, revision: String(revision), validation: { valid: true, errors: [], warnings: [] } };
      } else if (path === '/api/office-preview/status') {
        const binaryPath = config.webui.officePreview.binaryPath;
        probes.push(binaryPath); operations.push('probe');
        body = { service: config.webui.officePreview.service, platform: officePlatform, configuredBinaryPath: binaryPath,
          libreOffice: { available: true, binaryPath: binaryPath || examples[officePlatform], version: 'LibreOffice 26.8' } };
      } else if (path.startsWith('/api/computer-use/')) {
        if (path.endsWith('/enabled')) {
          const enabled = request.postDataJSON().enabled;
          computerStatus = { ...computerStatus, enabled, phase: enabled ? platform === 'darwin' ? 'needs-permissions' : platform === 'linux' ? 'partial' : 'ready' : 'disabled' };
        }
        if (path.endsWith('/refresh')) { expect(request.method()).toBe('POST'); rechecks++; }
        if (path.endsWith('/permissions')) {
          const permission = request.postDataJSON().permission;
          computerStatus = { ...computerStatus, permissions: { ...computerStatus.permissions, [permission]: true } };
        }
        body = computerStatus;
      } else if (path === '/api/settings/general-workspace') body = { directory: '', effectiveDirectory: '/fixture/general', defaultDirectory: '/fixture/general' };
      else if (path === '/api/projects') body = [];
      else if (path.includes('onboarding-status')) body = { hasCompletedOnboarding: true };
      else if (path.includes('providers') || path.includes('models')) body = { providers: [], models: [] };
      else if (path.includes('sessions')) body = { sessions: [], hasMore: false, total: 0 };
      else if (path.includes('tasks')) body = { tasks: [] };
      else if (path.includes('skills') || path.includes('plugins')) body = { skills: [], plugins: [] };
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await context.routeWebSocket('**/ws**', socket => socket.onMessage(() => {}));
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/settings/general`); await ready(page);
    const generalHeading = await page.locator('.page-header h1').evaluate(textStyle);
    const generalCard = await page.locator('.general-card').first().evaluate(el => {
      const css = getComputedStyle(el); return { border: css.borderRadius, background: css.backgroundColor };
    });
    await page.goto(`${base}/settings/office`); await ready(page);
    const input = page.getByLabel(office.fields.binaryPath.label, { exact: true });
    await expect(input).toHaveAttribute('placeholder', examples[platform]);
    expect(await page.locator('.page-header h1').evaluate(textStyle)).toEqual(generalHeading);
    if (platform === 'win32' && language === 'zh-CN') {
      // The host can differ from this Windows test browser. Older servers use a generic hint.
      for (const host of ['darwin', 'linux', undefined, 'win32']) {
        officePlatform = host; await page.reload(); await ready(page);
        await expect(input).toHaveAttribute('placeholder', examples[host] || office.fields.binaryPath.placeholder);
      }
      await input.fill('C:\\custom\\soffice.com');
      await expect(page.locator('.office-status-detail')).toHaveCount(0);
      await page.getByRole('button', { name: translations.settingsPage.actions.cancel, exact: true }).click();
      await expect(input).toHaveValue('');
      await input.fill('C:\\custom\\soffice.com');
      for (const failure of [400, 503]) {
        rejectSave = failure; const before = probes.length;
        await page.getByRole('button', { name: office.status.saveAndCheck, exact: true }).click();
        await expect(page.getByText('Synthetic save rejected', { exact: true }).first()).toBeVisible();
        await expect(page.getByRole('button', { name: office.status.saveAndCheck, exact: true })).toBeEnabled();
        expect(probes.length).toBe(before); await expect(input).toHaveValue('C:\\custom\\soffice.com');
      }
      await page.getByRole('button', { name: translations.settingsPage.actions.cancel, exact: true }).click();
      await expect(input).toHaveValue('');
      await input.fill('C:\\custom\\soffice.com');
      rejectSave = 0; operations.length = 0;
      await input.press('Enter');
      await expect(page.getByRole('button', { name: office.status.refresh, exact: true })).toBeEnabled();
      expect(operations).toEqual(['save', 'probe']); expect(probes.at(-1)).toBe('C:\\custom\\soffice.com');
      await page.reload(); await ready(page); await expect(input).toHaveValue('C:\\custom\\soffice.com');
      await input.fill(''); await input.press('Enter');
      await expect(page.getByRole('button', { name: office.status.refresh, exact: true })).toBeEnabled();
      expect(config.webui.officePreview.binaryPath).toBe(''); expect(probes.at(-1)).toBe('');
      await page.locator('input[value=libreoffice]').focus(); await page.keyboard.press('ArrowLeft');
      await expect(page.locator('input[value=builtin]')).toBeChecked();
      await expect(page.locator('.office-path-card')).toHaveCount(0);
      await expect.poll(() => config.webui.officePreview.service).toBe('builtin');
      await expect(page.locator('input[value=builtin]')).toBeEnabled();
      await page.locator('input[value=builtin]').press('ArrowRight');
      await expect(page.locator('.office-path-card')).toBeVisible();
      await expect(page.locator('input[value=libreoffice]')).toBeChecked();
      await expect.poll(() => config.webui.officePreview.service).toBe('libreoffice');
    }
    if (language === 'en') {
      await input.fill(examples[platform]); await input.press('Enter');
      await expect(page.locator('.settings-success-toast')).toHaveText(translations.saveStatus.success);
    }
    await expect(page.getByRole('button', { name: office.status.refresh, exact: true })).toBeEnabled();
    await page.screenshot({ path: join(output, `${language}-${mode}-office.png`), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator('.settings-main').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: join(output, `${language}-${mode}-office-mobile.png`), animations: 'disabled' });
    await page.setViewportSize({ width: 1129, height: 1039 });
    await page.goto(`${base}/settings/computer-use`); await ready(page);
    const toggle = page.getByRole('switch', { name: computer.enable });
    await expect(toggle).toBeEnabled();
    expect(await page.locator('.page-header h1').evaluate(textStyle)).toEqual(generalHeading);
    expect(await page.locator('.general-card').first().evaluate(el => {
      const css = getComputedStyle(el); return { border: css.borderRadius, background: css.backgroundColor };
    })).toEqual(generalCard);
    await page.getByRole('button', { name: computer.refresh, exact: true }).click();
    await expect.poll(() => rechecks).toBe(1);
    await expect(toggle).toBeEnabled();
    await toggle.focus(); await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    if (platform === 'darwin') {
      await page.getByRole('button', { name: computer.openPermissions, exact: true }).first().click();
      await expect(page.getByText(computer.granted, { exact: true })).toHaveCount(1);
    }
    await page.screenshot({ path: join(output, `${language}-${mode}-computer.png`), animations: 'disabled' });
    await page.getByRole('button', { name: computer.stop, exact: true }).click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator('.settings-main').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: join(output, `${language}-${mode}-computer-mobile.png`), animations: 'disabled' });
    expect(errors).toEqual([]);
    console.log(`PASS ${language} ${mode} ${preset} ${platform}: Office host hints, shared chrome, computer controls, desktop/mobile`);
    await context.close();
  }
} finally { await browser.close(); }

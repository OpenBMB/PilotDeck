// Start Vite on 5187. Synthetic API fixtures; no provider or user settings are used.
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const artifacts = path.resolve('artifacts/theme-components');
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PILOTDECK_TEST_BROWSER_CHANNEL || 'chrome', headless: true });
const base = process.env.PILOTDECK_TEST_URL || 'http://127.0.0.1:5187';
const results = [];

// Composite actual ancestor surfaces, including transparent menu rows. Raster
// gradient endpoint contrast is covered separately by appearancePalette tests.
async function contrast(locator, pseudo = null) {
  return locator.evaluate((element, pseudo) => {
    const rgb = value => value.match(/[\d.]+/g).map(Number);
    const blend = (fg, bg) => fg.slice(0, 3).map((c, i) => c * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
    const lum = color => color.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
    const chain = []; for (let e = element; e; e = e.parentElement) chain.unshift(rgb(getComputedStyle(e).backgroundColor));
    const background = chain.reduce((bg, fg) => blend(fg, bg), [255, 255, 255]);
    const foreground = blend(rgb(getComputedStyle(element, pseudo).color), background);
    const a = lum(foreground), b = lum(background);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  }, pseudo);
}
async function token(page, name) {
  return page.evaluate(name => {
    const probe = document.createElement('span'); probe.style.color = `var(${name})`;
    document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color;
  }, name);
}
async function readable(locator, label, pseudo) {
  await expect.poll(() => contrast(locator, pseudo), { message: label }).toBeGreaterThanOrEqual(4.5);
}

try {
  for (const mode of ['dark', 'light']) for (const preset of ['gray', 'blue', 'mint', 'apricot', 'rose', 'default']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(({ mode, preset }) => {
      localStorage.setItem('userLanguage', 'en'); localStorage.setItem('themeMode', mode);
      localStorage.setItem('pilotdeck-light-appearance-v1', JSON.stringify({ preset }));
      if ('serviceWorker' in navigator) navigator.serviceWorker.register = () => Promise.reject(new Error('fixture'));
    }, { mode, preset });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    let bypass = true;
    const selection = { mode: 'model', provider: 'fixture', model: 'Theme model' };
    const skill = { slug: 'fixture', name: 'Theme fixture', description: 'Synthetic skill for appearance checks', scope: 'builtin', readonly: true, enabled: true, skillDir: '/fixture/skill', skillFile: '/fixture/skill/SKILL.md', version: null, mtime: null };
    await page.route('**/api/**', async route => {
      const p = new URL(route.request().url()).pathname;
      let body = {};
      if (p === '/api/auth/status') body = { authDisabled: true };
      else if (p.includes('onboarding-status')) body = { hasCompletedOnboarding: true };
      else if (p === '/api/projects') body = [{ name: 'general', displayName: 'general', fullPath: '/fixture/profile', workspaceCwd: '/fixture/general', kind: 'general', sessions: [] }];
      else if (p === '/api/settings/general-workspace') body = { directory: '', effectiveDirectory: '/fixture/general', defaultDirectory: '/fixture/general' };
      else if (p === '/api/settings/permissions') {
        if (route.request().method() === 'PUT') bypass = route.request().postDataJSON().skipPermissions;
        body = { success: true, permissions: { skipPermissions: bypass, allowedTools: [], askTools: [], disallowedTools: [] } };
      } else if (p === '/api/models') body = { items: [{ id: 'fixture/Theme model', provider: 'fixture', model: 'Theme model', displayName: 'Theme model', available: true, capabilities: {} }], defaultSelection: selection };
      else if (p.includes('model-selection')) body = { saved: selection };
      else if (p.endsWith('/skills/list')) body = { builtin: [skill], user: [], project: [], projectPath: null, isGeneralCwd: true };
      else if (p.endsWith('/skills/read')) body = { content: '---\nname: fixture\n---\n# Theme fixture\n\nSynthetic instructions.' };
      else if (p.includes('/sessions')) body = { sessions: [], hasMore: false, total: 0 };
      else if (p.includes('/files')) body = [];
      else if (p.includes('/tasks')) body = { tasks: [] };
      else if (p.includes('/cron')) body = { jobs: [] };
      else if (p === '/api/usage') body = { today: '2026-01-15', timeZone: 'UTC', days: [{ date: '2026-01-15', tokens: 4200, callCount: 2 }], totalTokens: 4200, totalCalls: 2, updatedAt: '2026-01-15T12:00:00Z' };
      else if (p === '/api/config') body = { exists: true, raw: JSON.stringify({ model: { providers: {} }, memory: { enabled: false }, tools: { webSearch: { enabled: true, provider: 'custom', endpoint: 'https://example.invalid/search', customProvider: { auth: 'none' } } } }), validation: { valid: true, errors: [], warnings: [] } };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.routeWebSocket('**/ws**', socket => socket.onMessage(() => {}));
    await page.goto(`${base}/p/general`);
    const permission = page.locator('.pd-composer-permission-button');
    await expect(permission).toBeEnabled({ timeout: 60000 });
    await expect(permission).toHaveCSS('color', await token(page, '--pd-warning-ink'));
    await readable(permission, `${preset} ${mode} full-access warning`);
    await readable(page.locator('.pd-composer-input-surface textarea'), `${preset} ${mode} composer placeholder`, '::placeholder');
    await permission.click();
    await expect(permission).toHaveCSS('color', await token(page, '--pd-warning-ink'));
    const selected = page.getByRole('menuitemradio', { checked: true });
    await expect(selected).toBeVisible();
    if (mode === 'dark' || preset !== 'default') {
      await expect(selected).toHaveCSS('color', await token(page, '--pd-accent-strong'));
      await expect(selected).toHaveCSS('background-color', await token(page, '--pd-accent-selected'));
    }
    await readable(selected, `${preset} ${mode} selected permission`);
    await readable(selected.locator('span span').last(), `${preset} ${mode} permission description`);
    await page.keyboard.press('Escape');
    const model = page.locator('.pd-composer-model-control > button');
    await model.click();
    await expect(page.locator('.pd-composer-model-menu')).toBeVisible();
    await readable(page.locator('.pd-composer-model-menu').getByRole('button', { name: 'Theme model', exact: true }), `${preset} ${mode} model selection`);
    await page.locator('.pd-composer-model-menu').getByRole('button', { name: 'Theme model', exact: true }).hover();
    await readable(page.locator('.pd-composer-model-menu').getByRole('button', { name: 'Theme model', exact: true }), `${preset} ${mode} hovered model selection`);
    await page.keyboard.press('Escape');
    if (preset === 'gray') await page.screenshot({ path: path.join(artifacts, `${preset}-${mode}-chat.png`) });
    await page.goto(`${base}/skills`);
    await expect(page.locator('.skills-row').first()).toBeVisible({ timeout: 60000 });
    const primary = page.locator('.skills-header .skills-button-primary');
    await readable(primary, `${preset} ${mode} skill action`);
    await primary.hover(); await readable(primary, `${preset} ${mode} hovered skill action`);
    const toggle = page.locator('.skills-library-item .route-switch').first();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    if (mode === 'dark' || preset !== 'default') await expect(toggle).toHaveCSS('background-color', await token(page, '--pd-accent'));
    if (preset === 'gray') await page.screenshot({ path: path.join(artifacts, `${preset}-${mode}-skills.png`) });
    await page.goto(`${base}/settings/usage`);
    await expect(page.locator('.usage-stat-today strong')).toBeVisible();
    await readable(page.locator('.usage-stat-today strong'), `${preset} ${mode} usage total`);
    await page.locator('.usage-refresh').hover();
    await readable(page.locator('.usage-refresh'), `${preset} ${mode} usage refresh hover`);
    await page.goto(`${base}/settings/agent-search`);
    await expect(page.locator('.custom-search-help summary')).toBeVisible();
    await readable(page.locator('.custom-search-help summary'), `${preset} ${mode} custom search help`);
    const preview = page.locator('.custom-search-actions button:not(.custom-search-save)');
    await preview.hover(); await readable(preview, `${preset} ${mode} search preview hover`);
    const save = page.locator('.custom-search-save');
    await readable(save, `${preset} ${mode} search save`);
    await save.hover(); await readable(save, `${preset} ${mode} search save hover`);
    expect(errors).toEqual([]);
    results.push({ mode, preset, contrast: '>= 4.5', permission: 'semantic amber', menusAndSkills: 'theme accent' });
    console.log(`PASS ${preset} ${mode}: warning, placeholder, menus, skills, usage, custom search and hover`);
    await context.close();
  }
  await fs.writeFile(path.join(artifacts, 'results.json'), JSON.stringify(results, null, 2));
} finally { await browser.close(); }

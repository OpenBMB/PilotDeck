// Start Vite on 5187. Exercises actual settings routes in browser and Electron.
import { chromium, _electron as electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = path.join(root, 'artifacts/settings-material');
await fs.mkdir(artifacts, { recursive: true });
const panels = '[data-settings-surface=panel],.general-card,.memory-card,.resident-project-panel,.resident-card,.search-card,.scheduled-card,.route-card,.model-pool-workspace,.provider-rail,.provider-detail,.mcp-config-card,.mcp-raw-config-card,.mcp-config-card-header,.mcp-raw-config-header,.mcp-server-rail,.mcp-project-rail,.mcp-project-server-rail,.mcp-project-workbench,.mcp-detail-panel,.mcp-server-editor,.mcp-raw-editor,.office-card,.office-status-panel,.office-status-detail,.office-builtin-note,.security-card,.agent-retry-section,.advanced-settings-card,.detail-test-section';
const routes = [
  ['appearance', '.appearance-settings'], ['general', '.general-page-content'],
  ['models', '.model-pool-workspace'],
  ['agent-route', '.route-card'], ['agent-memory', '.memory-card'],
  ['agent-resident', '.resident-card'], ['agent-search', '.search-card'],
  ['agent-schedule', '.scheduled-card'], ['integrations', '.integration-gateway-card'],
  ['mcp', '.mcp-config-card'], ['office', '.office-card'],
  ['privacy', '.security-card'], ['advanced', '.advanced-settings-card'],
  ['about', '[data-settings-surface=panel]'],
];
const config = { agent:{model:'fixture/test'}, model:{providers:{fixture:{protocol:'openai', url:'https://example.invalid/v1', models:{test:{}}}}},
  memory:{enabled:false}, alwaysOn:{enabled:false}, cron:{enabled:false}, tools:{webSearch:{enabled:false}},
  router:{enabled:false}, gateway:{enabled:false}, webui:{officePreview:{service:'builtin'}}, customEnv:{FIXTURE:'test'} };
async function mockServer(page) {
  await page.context().addInitScript(() => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register = () => Promise.reject(new Error('No service worker in isolated UI fixture'));
  });
  await page.route('**/api/**', async route => {
    const p = new URL(route.request().url()).pathname;
    let body = {};
    if (p === '/api/projects') body = [{name:'demo', displayName:'Material test', fullPath:'/fixture/demo', kind:'workspace', sessions:[], capabilities:{files:true}}];
    else if (p === '/api/config') body = {exists:true, path:'/fixture/config.yaml', raw:JSON.stringify(config), validation:{valid:true,errors:[],warnings:[]}};
    else if (p === '/api/mcp/config') { const value={raw:JSON.stringify({mcpServers:{fixture:{command:'fixture',args:[]}}}),path:'/fixture/mcp.json',exists:true}; body={global:value,project:value}; }
    else if (p === '/api/gateway/status') body={feishu:{enabled:false,appId:'',hasSecret:false,connectionMode:'stream',domainName:'feishu'},weixin:{enabled:false,hasCredentials:false,accountId:null},wecom:{enabled:false,botId:'',hasSecret:false,websocketUrl:'',dmPolicy:'open',groupPolicy:'disabled',allowFrom:[],groupAllowFrom:[]}};
    else if (p.includes('onboarding-status')) body={hasCompletedOnboarding:true};
    else if (p.includes('/skills') || p.includes('/plugins')) body={skills:[],plugins:[]};
    else if (p.includes('providers') || p.includes('models')) body={providers:[],models:[]};
    else if (p.includes('tasks')) body={tasks:[]};
    else if (p.includes('cron')) body={jobs:[]};
    else if (p.includes('sessions')) body={sessions:[],hasMore:false,total:0};
    else if (p.includes('permissions')) body={allowedTools:[],askTools:[],disallowedTools:[]};
    await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.routeWebSocket('**/ws**', socket => socket.onMessage(() => {}));
}
async function verify(page, platform) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockServer(page);
  await page.goto('http://127.0.0.1:5187/settings/appearance');
  await expect(page.locator('.appearance-settings')).toBeVisible();
  await page.getByRole('button',{name:'浅色',exact:true}).click();
  await page.locator('#appearance-palette [data-preset=mint]').click();
  await page.getByRole('button',{name:'本地图片',exact:true}).click();
  // High contrast coloured cells expose accidental second fills clearly.
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width=1200; canvas.height=800;
    const ctx = canvas.getContext('2d'); const colors=['#080b1a','#ffa53d','#065f82','#f2386e','#edffe3'];
    for (let y=0;y<8;y++) for(let x=0;x<12;x++) {ctx.fillStyle=colors[(x+y)%colors.length];ctx.fillRect(x*100,y*100,100,100);}
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const image = path.join(artifacts,`${platform}-wallpaper.png`);
  await fs.writeFile(image,Buffer.from(data,'base64'));
  await page.locator('.appearance-settings input[type=file]').setInputFiles(image);
  await expect(page.locator('.appearance-image-upload img')).toBeVisible();
  const results=[];
  // One "interface transparency" control: 40 -> content 65%, 5 -> content 95%.
  for (const [transparency,opacity] of [[40,65],[5,95]]) {
    await page.goto('http://127.0.0.1:5187/settings/appearance');
    await expect(page.locator('.appearance-image-upload img')).toBeVisible();
    await page.getByRole('spinbutton',{name:'界面透明度 (%)'}).fill(String(transparency));
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-content-alpha'))).toBe(`${opacity}%`);
    for (const [route,ready] of routes) {
      await page.goto(`http://127.0.0.1:5187/settings/${route}`);
      try { await expect(page.locator(ready).first()).toBeVisible({timeout:30000}); }
      catch(error) { console.error({platform,route,errors,text:await page.locator('body').innerText()}); throw error; }
      await expect(page.locator('html')).toHaveAttribute('data-light-background','image');
      const values = await page.evaluate(panels => {
        const style = el => { const c=getComputedStyle(el); return {class:el.className,background:c.backgroundColor,image:c.backgroundImage,opacity:c.opacity}; };
        const content=document.querySelector('.settings-content');
        return { main:style(document.querySelector('.settings-main')), content:style(content),
          panels:[...content.querySelectorAll(`${panels},.general-card-header,.general-setting-row,.appearance-card-body,.appearance-details`)].map(style),
          controls:[...content.querySelectorAll('select,.appearance-color-control,.appearance-slider input[type=number]')].map(style) };
      },panels);
      expect(values.main.background).toContain(`/ ${opacity/100})`);
      expect(values.content.background).toBe('rgba(0, 0, 0, 0)');
      expect(values.content.image).toBe('none');
      expect(values.panels.length,route).toBeGreaterThan(0);
      for(const value of values.panels) {expect(value.background,`${route} ${value.class}`).toBe('rgba(0, 0, 0, 0)');expect(value.image).toBe('none');expect(value.opacity).toBe('1');}
      for(const value of values.controls) {expect(value.background,`${route} ${value.class}`).not.toBe('rgba(0, 0, 0, 0)');expect(value.image).toBe('none');}
      if(route==='mcp') {
        const muted=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--pd-muted').trim());
        const expected=`rgb(${[1,3,5].map(i=>parseInt(muted.slice(i,i+2),16)).join(', ')})`;
        await expect(page.locator('.mcp-header-location').first()).toHaveCSS('color',expected);
      }
      if(route==='models') {
        await expect(page.locator('.button.destructive-outline')).toHaveCSS('color','rgb(181, 82, 96)');
        await page.locator('.model-settings-trigger').first().click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expect(page.getByRole('dialog')).not.toHaveCSS('background-color','rgba(0, 0, 0, 0)');
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
      }
      results.push({route,opacity,panels:values.panels.length});
      console.log(`Checked ${platform} ${route} ${opacity}% (${values.panels.length} surfaces)`);
      if (['appearance','general','mcp','models'].includes(route)) await page.screenshot({path:path.join(artifacts,`${platform}-${route}-${opacity}.png`)});
    }
  }
  // Real image -> solid -> dark -> light transitions must remove/reapply
  // only the wallpaper material, including lazily loaded page styles.
  await page.goto('http://127.0.0.1:5187/settings/appearance');
  await page.getByRole('button',{name:'纯色',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-light-background','solid');
  await expect(page.locator('.general-card').first()).toHaveCSS('background-color','rgb(255, 255, 255)');
  await page.getByRole('button',{name:'本地图片',exact:true}).click();
  await page.getByRole('button',{name:'深色',exact:true}).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-light-background');
  await expect(page.locator('.general-card').first()).not.toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  await page.getByRole('button',{name:'切换浅色并编辑',exact:true}).click();
  await expect(page.locator('.general-card').first()).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  await page.reload();
  await expect(page.locator('.appearance-image-upload img')).toBeVisible();
  await expect(page.locator('.general-card').first()).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  // The card no longer adds a separate wash behind its header or form rows.
  const controlFill=await page.locator('.appearance-color-control').first().evaluate(e=>getComputedStyle(e).backgroundColor);
  expect(await page.locator('.appearance-slider input[type=number]').first().evaluate(e=>getComputedStyle(e).backgroundColor)).toBe(controlFill);
    await page.locator('.appearance-advanced > summary').click();
  await expect(page.locator('.appearance-advanced')).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  await page.screenshot({path:path.join(artifacts,`${platform}-expanded.png`)});
  expect(errors).toEqual([]);
  await fs.writeFile(path.join(artifacts,`${platform}-results.json`),JSON.stringify(results,null,2));
  console.log(`PASS: ${platform}, 14 settings routes at 65%/95%, shared control fill, wallpaper persistence, solid/dark isolation and expanded sections`);
}
if(!process.env.PILOTDECK_SKIP_BROWSER) {
const browser = await chromium.launch({channel:process.env.PILOTDECK_TEST_BROWSER_CHANNEL || 'msedge',headless:true});
try {const page=await browser.newPage({viewport:{width:1320,height:900}});await page.addInitScript(()=>{localStorage.setItem('userLanguage','zh-CN');localStorage.setItem('themeMode','light');});await verify(page,'web');}
finally {await browser.close();}
}
if(!process.env.PILOTDECK_SKIP_ELECTRON) {
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'pd-settings-material-'));
await fs.writeFile(path.join(profile,'appearance.json'),JSON.stringify({language:'zh-CN',themeMode:'light'}));
const app=await electron.launch({executablePath:createRequire(import.meta.url)(path.join(root,'apps/desktop/node_modules/electron')),
  args:[path.join(root,'apps/desktop/scripts/fixtures/appearance.cjs')],env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='ELECTRON_RUN_AS_NODE')),PILOTDECK_APPEARANCE_PROFILE:profile}});
try {const page=await app.firstWindow();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());await verify(page,'desktop');}
finally {await app.close();}
}

// Run Vite on 5187. Real app routes in Chromium and Electron, isolated settings.
import { chromium, _electron as electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { planModelRemoval } from '../server/services/modelReferences.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = path.join(root, 'artifacts/appearance-navigation');
await fs.mkdir(artifacts, { recursive: true });
const original = () => ({
  agent: { model: 'HX API/qwen3.6/27b', maxContextTokens: 128000, subagents: { default: 'HX API/qwen3.6/27b' } },
  model: { providers: {
    'HX API': { protocol: 'openai', url: 'https://example.invalid/v1', apiKey: 'fixture', models: { 'qwen3.6/27b': {}, spare: {} } },
    replacement: { protocol: 'openai', url: 'https://example.invalid/v1', apiKey: 'fixture', models: { next: {} } },
  } },
  router: { enabled: true, scenarios: { default: 'HX API/qwen3.6/27b', coding: 'HX API/qwen3.6/27b' },
    fallback: { default: ['HX API/qwen3.6/27b', 'replacement/next'] },
    tokenSaver: { enabled: true, judge: 'HX API/qwen3.6/27b', tiers: { medium: { model: 'HX API/qwen3.6/27b' } } },
    stats: { baselineModel: 'HX API/qwen3.6/27b', modelPricing: { 'HX API/qwen3.6/27b': { input: 2, output: 3 } } } },
  memory: { enabled: true, model: 'HX API/qwen3.6/27b' }, alwaysOn: { enabled: false }, cron: { enabled: false },
  tools: { webSearch: { enabled: false } }, gateway: { enabled: false }, webui: { officePreview: { service: 'builtin' } },
});
const pages = [['general','.general-page-content'],['appearance','.appearance-settings'],['models','.model-pool-workspace'],
  ['agent-route','.route-card'],['agent-memory','.memory-card'],['agent-resident','.resident-card'],['agent-search','.search-card'],
  ['agent-schedule','.scheduled-card'],['integrations','.integration-gateway-card'],['mcp','.mcp-config-card'],['office','.office-card'],
  ['privacy','.security-card'],['advanced','.advanced-settings-card'],['about','[data-settings-surface=panel]']];
async function exercise(page, platform, resize) {
  let config = original(), revision = 1, conflict = false;
  const errors = [], mutations = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().addInitScript(() => {
    localStorage.setItem('userLanguage','zh-CN'); localStorage.setItem('themeMode','light');
    if ('serviceWorker' in navigator) navigator.serviceWorker.register = () => Promise.reject(new Error('isolated fixture'));
  });
  await page.route('**/api/**', async route => {
    const request=route.request(), p=new URL(request.url()).pathname;
    let body={}, status=200;
    const response=()=>({exists:true,path:'/fixture/config.yaml',raw:JSON.stringify(config),revision:String(revision),validation:{valid:true,errors:[],warnings:[]}});
    if(p==='/api/config/model-removal') {
      const input=request.postDataJSON();const plan=planModelRemoval(config,input,{replacement:input.replacement});
      const {config:next,...publicPlan}=plan;
      if(input.dryRun) body={...publicPlan,revision:String(revision)};
      else {
        mutations.push(input);
        if(conflict) {conflict=false;revision++;status=409;body={code:'CONFIG_CONFLICT',message:'fixture conflict'};}
        else if(input.baseRevision!==String(revision)) {status=409;body={code:'CONFIG_CONFLICT',message:'changed'};}
        else if(plan.blocked) {status=409;body=plan.blocked;}
        else {config=next;revision++;body={...response(),removal:publicPlan};}
      }
    } else if(p==='/api/config') {
      if(request.method()==='PUT') {config=parseYaml(request.postDataJSON().raw);revision++;}
      body=response();
    } else if(p==='/api/projects') body=[{name:'demo',displayName:'Theme test',kind:'workspace',fullPath:'/fixture/demo',sessions:[],capabilities:{files:true}}];
    else if(p==='/api/mcp/config') {const v={raw:JSON.stringify({mcpServers:{fixture:{command:'fixture',args:[]}}}),path:'/fixture/mcp.json',exists:true};body={global:v,project:v};}
    else if(p==='/api/gateway/status') body={feishu:{enabled:false},weixin:{enabled:false},wecom:{enabled:false}};
    else if(p.includes('onboarding-status')) body={hasCompletedOnboarding:true};
    else if(p.includes('/skills')||p.includes('/plugins')) body={skills:[],plugins:[]};
    else if(p.includes('providers')||p.includes('models')) body={providers:[],models:[]};
    else if(p.includes('tasks')) body={tasks:[]};
    else if(p.includes('cron')) body={jobs:[]};
    else if(p.includes('sessions')) body={sessions:[],hasMore:false,total:0};
    else if(p.includes('permissions')) body={allowedTools:[],askTools:[],disallowedTools:[]};
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.routeWebSocket('**/ws**', socket=>socket.onMessage(()=>{}));
  const report=[];
  for(const [preset,color] of [['薄荷','rgb(24, 124, 101)'],['雾蓝','rgb(56, 106, 180)']]) {
    await page.goto('http://127.0.0.1:5187/settings/appearance');
    await page.getByRole('button',{name:'浅色',exact:true}).click();
    await page.locator('#appearance-palette').getByRole('button', { name: preset, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-light-background','solid');
    for(const [route,ready] of pages) {
      await page.goto(`http://127.0.0.1:5187/settings/${route}`);
      await expect(page.locator(ready).first()).toBeVisible();
      await expect(page.locator('.settings-main')).toHaveCSS('background-color','rgb(255, 255, 255)');
      await expect(page.locator('.topbar-config-icon')).toHaveCSS('color',color);
      await page.mouse.move(0,0);
      const scan=()=>page.locator('.settings-main').evaluate(root=>{
        function isPurple(value){const m=value.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/);if(!m)return false;
          const rgb=m.slice(1,4).map(Number), max=Math.max(...rgb),min=Math.min(...rgb),d=max-min;if(d<6||max<90)return false;
          let h=(max===rgb[0]?(rgb[1]-rgb[2])/d+(rgb[1]<rgb[2]?6:0):max===rgb[1]?(rgb[2]-rgb[0])/d+2:(rgb[0]-rgb[1])/d+4)*60;
          return h>=228&&h<=285&&d/(255-Math.abs(max+min-255))>.32;}
        return [...root.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().width>0).flatMap(e=>{
          // The dark-mode thumbnail deliberately keeps its default palette.
          if(e.closest('.appearance-preset, .appearance-miniature.is-dark')) return [];
          const s=getComputedStyle(e);return ['color','backgroundColor','borderTopColor','boxShadow','backgroundImage'].filter(k=>isPurple(s[k])).map(k=>({class:e.className,property:k,value:s[k]}));
        });
      });
      await expect.poll(scan,{message:`${platform} ${preset} ${route}`}).toEqual([]);
      report.push({preset,route,purple:0});
      if(['general','models','agent-route','agent-memory'].includes(route)) await page.screenshot({path:path.join(artifacts,`${platform}-${preset}-${route}.png`)});
    }
    console.log(`PASS ${platform}: ${preset} on 14 modern settings routes, white surfaces and no purple decoration`);
  }
  await page.goto('http://127.0.0.1:5187/settings/agent-model');
  await expect(page).toHaveURL(/\/settings\/models$/);
  await expect(page.locator('.agent-model-page')).toHaveCount(0);
  const references=['agent.model','agent.subagents.default','memory.model','router.scenarios.default','router.scenarios.coding',
    'router.fallback.default.0','router.tokenSaver.judge','router.tokenSaver.tiers.medium.model','router.stats.baselineModel','router.stats.modelPricing.HX API/qwen3.6/27b'];
  for(const reference of references) {
    await page.goto('http://127.0.0.1:5187/settings/models');
    await page.locator('.provider-row').filter({hasText:'HX API'}).click();
    await page.locator('.button.destructive-outline').click();
    const dialog=page.getByRole('dialog');await expect(dialog.getByRole('button',{name:'替换并删除',exact:true})).toBeEnabled();
    // Resolve exact paths on the preview rows instead of relying on translated labels.
    const row=dialog.locator(`li[data-reference-path=${JSON.stringify(reference)}]`);
    await row.getByRole('button',{name:'前往',exact:true}).click();
    const expected=reference==='agent.model'?'models':reference==='memory.model'?'agent-memory':'agent-route';
    await expect.poll(()=>new URL(page.url()).pathname).toBe(`/settings/${expected}`);
    expect(new URL(page.url()).searchParams.get('reference')).toBe(reference);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('[data-reference-highlight]')).toHaveAttribute('data-model-reference',reference);
    expect(await page.locator('[data-reference-highlight]').evaluate(e=>e.getBoundingClientRect().height)).toBeGreaterThan(30);
    expect(mutations).toHaveLength(0);
    await page.screenshot({path:path.join(artifacts,`${platform}-reference-${reference.replace(/[^a-zA-Z0-9]/g,'_')}.png`)});
  }
  await page.goto('http://127.0.0.1:5187/settings/models');
  const contextLimit=page.getByLabel('主智能体上下文上限',{exact:true});
  await expect(contextLimit).toHaveValue('128000');
  await contextLimit.fill('64000');await contextLimit.press('Tab');
  await expect.poll(()=>config.agent.maxContextTokens).toBe(64000);
  await page.reload();await expect(contextLimit).toHaveValue('64000');
  await contextLimit.fill('');await contextLimit.press('Tab');
  await expect.poll(()=>config.agent.maxContextTokens).toBeUndefined();
  for(const width of [960,1600,1320]) {
    await resize(width,900);
    await expect(contextLimit).toBeVisible();
    await expect.poll(()=>page.locator('.model-pool-default').evaluate(e=>e.scrollWidth-e.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.goto('http://127.0.0.1:5187/settings/models');
  await page.locator('.provider-row').filter({hasText:'HX API'}).click();
  await page.locator('.button.destructive-outline').click();
  const dialog=page.getByRole('dialog');await expect(dialog.getByRole('combobox')).toHaveValue('replacement/next');
  conflict=true;
  await dialog.getByRole('button',{name:'替换并删除',exact:true}).click();
  await expect(dialog.getByRole('status')).toBeVisible();
  await expect(dialog.getByRole('button',{name:'替换并删除',exact:true})).toBeEnabled();
  await dialog.getByRole('button',{name:'替换并删除',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect(config.agent.model).toBe('replacement/next');
  expect(config.agent.subagents.default).toBe('inherit');
  expect(config.memory).not.toHaveProperty('model');
  expect(config.model.providers['HX API']).toBeUndefined();
  expect(config.router.stats.modelPricing['HX API/qwen3.6/27b']).toBeUndefined();
  config=original();delete config.model.providers.replacement;
  config.model.providers['HX API'].models={'qwen3.6/27b':{}};revision++;
  await page.goto('http://127.0.0.1:5187/settings/models');
  await page.locator('.button.destructive-outline').click();
  await expect(page.getByRole('dialog').getByRole('button',{name:'替换并删除',exact:true})).toBeDisabled();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  await page.goto('http://127.0.0.1:5187/settings/appearance');
  await page.getByRole('button',{name:'深色',exact:true}).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-light-appearance');
  await page.getByRole('button',{name:'切换浅色并编辑',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-light-appearance');
  await page.reload();await expect(page.locator('#appearance-palette [data-preset=blue]')).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
  await fs.writeFile(path.join(artifacts,`${platform}-checks.json`),JSON.stringify({pages:report,references,contextOverride:'saved/reloaded/cleared',resizeWidths:[960,1600,1320],mutations},null,2));
  console.log(`PASS ${platform}: 10 reference links, retired route redirect, context override save/clear, resize, conflict/re-preview/atomic removal, last-model block and dark/reload`);
}
if(!process.env.PILOTDECK_SKIP_BROWSER) {
 const browser=await chromium.launch({channel:process.env.PILOTDECK_TEST_BROWSER_CHANNEL||'chrome',headless:true});
 try{const page=await browser.newPage({viewport:{width:1320,height:900}});await exercise(page,'web',(width,height)=>page.setViewportSize({width,height}));}finally{await browser.close();}
}
if(!process.env.PILOTDECK_SKIP_ELECTRON) {
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'pd-navigation-theme-'));
 await fs.writeFile(path.join(profile,'appearance.json'),JSON.stringify({language:'zh-CN',themeMode:'light'}));
 const app=await electron.launch({executablePath:createRequire(import.meta.url)(path.join(root,'apps/desktop/node_modules/electron')),
  args:[path.join(root,'apps/desktop/scripts/fixtures/appearance.cjs')],env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>k!=='ELECTRON_RUN_AS_NODE')),PILOTDECK_APPEARANCE_PROFILE:profile}});
 try{await exercise(await app.firstWindow(),'desktop',(width,height)=>app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(size.width,size.height),{width,height}));}finally{await app.close();}
}

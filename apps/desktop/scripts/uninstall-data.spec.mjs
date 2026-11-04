import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { cleanupPersonalData } = require('../resources/uninstall-data.cjs');
const mod = { exports: {} };
new Function('module','exports', ts.transpileModule(fs.readFileSync(new URL('../src/desktopUninstall.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(mod,mod.exports);

test('cleanup removes only named personal data and never traverses a workspace junction', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'pilotdeck-uninstall-'));
  try {
    const profile = path.join(root,'用户'), pilot = path.join(profile,'.pilotdeck'), appData = path.join(profile,'AppData/Roaming'), localAppData = path.join(profile,'AppData/Local');
    fs.mkdirSync(pilot,{recursive:true});fs.mkdirSync(path.join(appData,'pilotdeck-desktop'),{recursive:true});fs.mkdirSync(path.join(localAppData,'pilotdeck-desktop-updater'),{recursive:true});
    fs.writeFileSync(path.join(pilot,'pilotdeck.yaml'),'apiKey: private\n');
    const outside = path.join(root,'workspace');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'source.txt'),'preserve');
    fs.symlinkSync(outside,path.join(pilot,'workspace-link'),process.platform==='win32'?'junction':'dir');
    const result = cleanupPersonalData({profile,pilotHome:pilot,appData,localAppData});
    assert.equal(result.skipped.length,0);assert.equal(fs.existsSync(pilot),false);
    assert.equal(fs.readFileSync(path.join(outside,'source.txt'),'utf8'),'preserve');
    assert.equal(fs.existsSync(path.join(appData,'pilotdeck-desktop')),false);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('cleanup refuses broad custom homes and repositories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'pilotdeck-uninstall-guard-'));
  try {
    const profile = path.join(root,'profile');fs.mkdirSync(profile);fs.writeFileSync(path.join(profile,'personal.txt'),'keep');
    const result = cleanupPersonalData({profile,pilotHome:profile});assert.deepEqual(result.removed,[]);assert.ok(result.skipped.includes(profile));
    const repo = path.join(profile,'.pilotdeck');fs.mkdirSync(path.join(repo,'.git'),{recursive:true});
    assert.ok(cleanupPersonalData({profile,pilotHome:repo}).skipped.includes(repo));
    assert.equal(fs.readFileSync(path.join(profile,'personal.txt'),'utf8'),'keep');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('cleanup preserves a General workspace even when nested inside a client data directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-uninstall-workspace-'));
  try {
    const profile = path.join(root, 'profile'), appData = path.join(profile, 'AppData', 'Roaming');
    const client = path.join(appData, 'PilotDeck'), workspace = path.join(client, 'custom', 'General');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, '.pilotdeck-workspace'), 'workspace marker');
    fs.writeFileSync(path.join(workspace, 'report.md'), 'user file');
    const result = cleanupPersonalData({ profile, appData });
    assert.ok(result.skipped.includes(client));
    assert.equal(fs.readFileSync(path.join(workspace, 'report.md'), 'utf8'), 'user file');
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uninstall language probing respects the saved preference and cannot clean data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'pilotdeck-uninstall-language-'));
  try {
    const profile = path.join(root,'profile'), appData = path.join(profile,'AppData/Roaming');
    const client = path.join(appData,'pilotdeck-desktop'), pilot = path.join(profile,'.pilotdeck');
    fs.mkdirSync(client,{recursive:true}); fs.mkdirSync(pilot,{recursive:true});
    fs.writeFileSync(path.join(pilot,'pilotdeck.yaml'),'preserve credentials');
    for (const language of ['en','zh-CN']) {
      fs.writeFileSync(path.join(client,'appearance.json'),JSON.stringify({language}));
      const result = spawnSync(process.execPath,[fileURLToPath(new URL('../resources/uninstall-data.cjs',import.meta.url)),'--language','--profile',profile,'--app-data',appData],{encoding:'utf8',windowsHide:true});
      assert.equal(result.status,0,result.stderr); assert.equal(result.stdout,language);
      assert.equal(fs.readFileSync(path.join(pilot,'pilotdeck.yaml'),'utf8'),'preserve credentials');
    }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

for (const choice of [0,1,2]) test(`Linux uninstall choice ${choice} preserves the requested data policy`, async () => {
  const calls=[];
  const controller=mod.exports.createDesktopUninstaller({platform:'linux',packaged:true,chinese:()=>true,exists:()=>true,
    confirm:async options=>{assert.equal(options.defaultId,0);assert.equal(options.cancelId,2);return {response:choice};},
    run:async(file,args)=>{calls.push(file);return {code:0,stdout:file.endsWith('dpkg-query')?'install ok installed':''};},
    stop:async()=>{calls.push('stop');},restore:async()=>{calls.push('restore');},quit:()=>{calls.push('quit');},cleanup:()=>{calls.push('cleanup');return {skipped:[]};},notify:async()=>{},
  });
  const result=await controller.start();assert.equal(result.canceled,choice===2);
  assert.equal(calls.includes('cleanup'),choice===1);assert.equal(calls.includes('/usr/bin/pkexec'),choice!==2);
  if(choice!==2)assert.ok(calls.indexOf('stop')<calls.indexOf('/usr/bin/pkexec'));
});

test('canceled system authorization restarts the application without deleting data', async () => {
  let restored=false,cleaned=false;
  const controller=mod.exports.createDesktopUninstaller({platform:'linux',packaged:true,chinese:()=>false,exists:()=>true,
    confirm:async()=>({response:1}),run:async file=>({code:file.endsWith('pkexec')?1:0,stdout:'install ok installed'}),
    stop:async()=>{},restore:async()=>{restored=true;},quit:()=>{},cleanup:()=>{cleaned=true;return {skipped:[]};},notify:async()=>{},
  });
  await assert.rejects(controller.start(),/retained/);assert.equal(restored,true);assert.equal(cleaned,false);
});

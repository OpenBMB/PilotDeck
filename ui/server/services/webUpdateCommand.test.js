// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createCommandClient, runWebUpdateCommand } from './webUpdateCommand.js';
import { realpathSync } from 'node:fs';
const latest = { tagName: 'v2026.09.07', sourceSha: 'a'.repeat(40) };
const available = { canUpdate: true, latest };
const makeClient = (status = available) => ({ check: vi.fn(async () => status), apply: vi.fn(), restart: vi.fn() });
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('shared Release command policy', () => {
  it.each(['development','container','localChanges','ahead','runtimeMismatch','desktop'])('rejects %s without applying or restarting', async reason => {
    const client=makeClient({canUpdate:false,reason});
    await expect(runWebUpdateCommand({client,output:vi.fn(),restart:true})).rejects.toMatchObject({reason});
    expect(client.apply).not.toHaveBeenCalled();expect(client.restart).not.toHaveBeenCalled();
  });
  it('checks the Release without applying or restarting', async () => {
    const client=makeClient(); const output=vi.fn();
    await runWebUpdateCommand({client,output,checkOnly:true,restart:true});
    expect(output).toHaveBeenCalledWith(expect.stringContaining(latest.tagName));
    expect(client.apply).not.toHaveBeenCalled();expect(client.restart).not.toHaveBeenCalled();
  });
  it('treats equality as a successful no-op', async () => {
    const client=makeClient({canUpdate:false,reason:'upToDate'});
    expect(await runWebUpdateCommand({client,output:vi.fn(),restart:true})).toBe(2);
    expect(client.apply).not.toHaveBeenCalled();
  });
  it('rejects unavailable automatic restart before changing files', async () => {
    const client={...makeClient(),restart:null};
    await expect(runWebUpdateCommand({client,output:vi.fn(),restart:true})).rejects.toMatchObject({reason:'restartUnavailable'});
    expect(client.apply).not.toHaveBeenCalled();
  });
  it('supports offline apply with explicit manual restart instructions', async () => {
    const client={...makeClient(),restart:null};const output=vi.fn();
    await runWebUpdateCommand({client,output});
    expect(client.apply).toHaveBeenCalledWith(latest,output);
    expect(output).toHaveBeenLastCalledWith(expect.stringContaining('manually'));
  });
  it('never restarts after failed cleanup/apply', async () => {
    const client=makeClient();client.apply.mockRejectedValue(Object.assign(new Error('stop failed'),{reason:'processStopFailed'}));
    await expect(runWebUpdateCommand({client,output:vi.fn(),restart:true})).rejects.toMatchObject({reason:'processStopFailed'});
    expect(client.restart).not.toHaveBeenCalled();
  });
  it('requests restart after apply and distinguishes a rejected restart', async () => {
    const client=makeClient();client.restart.mockImplementation(()=>{expect(client.apply).toHaveBeenCalled();throw new Error('unreachable');});
    await expect(runWebUpdateCommand({client,output:vi.fn(),restart:true})).rejects.toMatchObject({reason:'restartFailed',message:expect.stringContaining('Update prepared')});
  });
});

describe('running Web instance integration', () => {
  const projectRoot=realpathSync(process.cwd());
  function setup(handler) {
    const fetchImpl=vi.fn(async(url,options)=>{
      if(url.endsWith('/health'))return json({status:'ok'});
      if(url.endsWith('/context'))return json({projectRoot});
      return handler(url,options);
    });
    const offline=vi.fn();
    return {fetchImpl,offline,projectRoot,headers:async()=>({Authorization:'Bearer local-test'})};
  }
  it('uses the same check/apply/restart endpoints as settings', async () => {
    const opts=setup((url,options)=>{
      expect(options.headers.Authorization).toBe('Bearer local-test');
      if(url.endsWith('/check'))return json(available);
      if(url.endsWith('/apply')){expect(JSON.parse(options.body).target).toEqual(latest);return new Response(JSON.stringify({stage:'complete',status:'success'})+'\n');}
      if(url.endsWith('/restart'))return json({status:'accepted'});
      throw new Error(url);
    });
    await runWebUpdateCommand({client:await createCommandClient(opts),restart:true,output:vi.fn()});
    expect(opts.offline).not.toHaveBeenCalled();
    expect(opts.fetchImpl.mock.calls.map(([url])=>url.split('/').pop())).toEqual(['health','context','check','apply','restart']);
  });
  it('recovers a disconnected apply response before restarting', async () => {
    let updateId;
    const opts=setup((url,options)=>{
      if(url.endsWith('/check'))return json(available);
      if(url.endsWith('/apply')){updateId=JSON.parse(options.body).updateId;throw new TypeError('stream lost');}
      if(url.endsWith('/status'))return json({lastUpdateResult:{success:true,updateId}});
      if(url.endsWith('/restart'))return json({status:'accepted'});
    });
    await runWebUpdateCommand({client:await createCommandClient(opts),restart:true,output:vi.fn()});
    expect(opts.fetchImpl.mock.calls.map(([url])=>url.split('/').pop()).slice(-2)).toEqual(['status','restart']);
  });
  it('does not restart from another update result after connection loss', async () => {
    const opts=setup((url)=>{
      if(url.endsWith('/check'))return json(available);
      if(url.endsWith('/apply'))throw new TypeError('stream lost');
      return json({lastUpdateResult:{success:true,updateId:'someone-else'}});
    });
    await expect(runWebUpdateCommand({client:await createCommandClient(opts),restart:true,output:vi.fn()})).rejects.toMatchObject({reason:'updateUnconfirmed'});
    expect(opts.fetchImpl.mock.calls.some(([url])=>url.endsWith('/restart'))).toBe(false);
  });
  it('does not fall back to filesystem updates on authentication failure', async () => {
    const opts=setup(()=>new Response('{}',{status:401}));
    opts.fetchImpl.mockImplementation(async url=>url.endsWith('/health')?json({}):new Response('{}',{status:401}));
    await expect(createCommandClient(opts)).rejects.toMatchObject({reason:'runtimeUnavailable'});
    expect(opts.offline).not.toHaveBeenCalled();
  });
  it('rejects a different installation at the configured port', async () => {
    const opts=setup(()=>json({}));
    opts.fetchImpl.mockImplementation(async url=>json(url.endsWith('/context')?{projectRoot:'/another/installation'}:{}));
    await expect(createCommandClient(opts)).rejects.toMatchObject({reason:'differentInstallation'});
    expect(opts.offline).not.toHaveBeenCalled();
  });
  it('allows the same Release service offline only on connection refused', async () => {
    const service=makeClient();
    const opts=setup(()=>json({}));opts.offline.mockReturnValue(service);
    opts.fetchImpl.mockRejectedValue(Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNREFUSED'}}));
    const client=await createCommandClient(opts);
    expect(await client.check()).toEqual(available);expect(client.restart).toBeNull();
  });
});

it('authenticates an actual local HTTP update using the installation database', async () => {
  const { DatabaseSync }=await import('node:sqlite');
  const { mkdtempSync, rmSync }=await import('node:fs');
  const os=await import('node:os');const path=await import('node:path');
  const { fileURLToPath }=await import('node:url');
  const { default: express }=await import('express');
  const { default: jwt }=await import('jsonwebtoken');
  const { createWebUpdateRouter }=await import('../routes/webUpdate.js');
  const directory=mkdtempSync(path.join(os.tmpdir(),'pilotdeck-update-auth-'));
  const databasePath=path.join(directory,'auth.db');const db=new DatabaseSync(databasePath);
  db.exec("CREATE TABLE users(id INTEGER, username TEXT); INSERT INTO users VALUES(5,'local-owner'); CREATE TABLE app_config(key TEXT,value TEXT); INSERT INTO app_config VALUES('jwt_secret','test-only-local-secret');");db.close();
  const apply=vi.fn(async(_target,progress)=>progress('Prepared'));
  const restart=vi.fn();
  const app=express();app.use(express.json());app.get('/health',(_req,res)=>res.json({status:'ok'}));
  app.use('/api/update',(req,res,next)=>{
    try { expect(jwt.verify(req.headers.authorization.split(' ')[1],'test-only-local-secret')).toMatchObject({userId:5});expect(req.headers['x-api-key']).toBe('test-only-api-key');next(); }
    catch { res.sendStatus(401); }
  });
  app.use('/api/update',createWebUpdateRouter({check:async()=>available,apply}));
  app.post('/api/update/restart',(_req,res)=>{restart();res.json({status:'accepted'});});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try {
    const client=await createCommandClient({projectRoot:fileURLToPath(new URL('../../../',import.meta.url)),env:{SERVER_PORT:String(server.address().port),DATABASE_PATH:databasePath,API_KEY:'test-only-api-key'}});
    await runWebUpdateCommand({client,restart:true,output:vi.fn()});
    expect(apply).toHaveBeenCalledWith(latest,expect.any(Function),expect.any(String));expect(restart).toHaveBeenCalledOnce();
  } finally { await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true}); }
});

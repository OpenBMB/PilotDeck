/** Optional Mint ACP backend. All execution stays in the configured runtime. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export function mintBackendEnabled(env = process.env) {
  return env.PILOTDECK_RUNTIME_BACKEND === 'mint';
}

export async function mintAttachmentReferences(attachments, cwd) {
  const root = await realpath(cwd);
  return Promise.all((attachments || []).map(async attachment => {
    if (attachment.type !== 'file' || typeof attachment.path !== 'string') {
      throw new Error('Mint currently supports uploaded text file attachments');
    }
    const target = await realpath(attachment.path);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('Mint attachment must be stored inside the selected project');
    }
    return { uri: 'env://local/' + relative.split(path.sep).join('/'), name: attachment.name || path.basename(target) };
  }));
}

export class MintAcpGateway {
  constructor({ command, args = [], cwd, stateDir, env = process.env, timeoutMs = 300000, uploadStore }) {
    if (!path.isAbsolute(command || '') || !path.isAbsolute(cwd || '') || !path.isAbsolute(stateDir || '')) {
      throw new Error('Mint requires absolute command, project and state paths');
    }
    this.config = { command, args, cwd, stateDir, env, timeoutMs };
    this.uploadStore = uploadStore;
    this.pending = new Map();
    this.sessions = new Map();
    this.permissions = new Map();
    this.nextId = 1;
    this.creatingSessions = new Map();
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.boot();
    try { return await this.starting; }
    catch (error) { this.close(); throw error; }
  }
  async boot() {
    await mkdir(this.config.stateDir, { recursive: true });
    this.child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd, env: this.config.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', chunk => process.stderr.write(chunk));
    const child = this.child;
    child.on('error', error => { if (this.child === child) this.close(error); });
    child.on('exit', (code, signal) => { if (this.child === child) this.close(new Error(`Mint runtime exited (${code ?? signal})`)); });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      try { this.receive(JSON.parse(line)); }
      catch (error) { this.close(new Error(`Invalid Mint ACP frame: ${error.message}`)); }
    });
    const result = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'pilotdeck-mint', version: '0.1.0' },
    });
    this.capabilities = result.agentCapabilities || {};
    return this;
  }
  send(frame) {
    if (!this.child || this.child.exitCode !== null || this.child.stdin.destroyed) throw new Error('Mint runtime is unavailable');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Mint ${method} timed out; runtime stopped to prevent uncertain execution`));
        this.close();
      }, this.config.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(frame) {
    if (frame.method === 'session/request_permission') {
      const state = [...this.sessions.values()].find(s => s.id === frame.params.sessionId);
      if (!state?.push) {
        this.send({ id: frame.id, result: { outcome: { outcome: 'cancelled' } } });
        return;
      }
      const requestId = randomUUID();
      this.permissions.set(requestId, { id: frame.id, params: frame.params, sessionKey: state.key });
      state.push({ type: 'permission_request', requestId,
        toolName: frame.params.toolCall?.title || 'Mint tool', payload: frame.params.toolCall });
      return;
    }
    if (frame.method === 'session/update') {
      const state = [...this.sessions.values()].find(s => s.id === frame.params.sessionId);
      if (state?.push) {
        if(frame.params._meta?.['mint/error']) state.runtimeError=frame.params.update.content?.text || 'Mint runtime failed';
        for (const event of acpUpdateToEvents(frame.params.update)) state.push(event);
      }
      return;
    }
    if (frame.method && frame.id !== undefined) {
      this.send({ id: frame.id, error: { code: -32601, message: `Unsupported client method: ${frame.method}` } });
      return;
    }
    if (frame.id !== undefined) {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.error) pending.reject(new Error(`Mint ACP ${frame.error.code}: ${frame.error.message}`));
      else pending.resolve(frame.result);
    }
  }
  fail(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.sessions.clear();
    this.permissions.clear();
    this.starting = null;
  }
  close(error = new Error('Mint runtime connection closed')) {
    this.lines?.close();
    this.child?.kill('SIGTERM');
    this.fail(error);
    this.child = null;
  }
  mappingPath(key) {
    return path.join(this.config.stateDir, Buffer.from(key).toString('hex') + '.json');
  }
  async session(key) {
    if (!this.creatingSessions.has(key)) {
      this.creatingSessions.set(key, this.createSession(key).finally(() => this.creatingSessions.delete(key)));
    }
    return this.creatingSessions.get(key);
  }
  async createSession(key) {
    if (this.sessions.has(key)) return this.sessions.get(key);
    let saved;
    try { saved = JSON.parse(await readFile(this.mappingPath(key), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let result;
    if (saved) {
      if (!this.capabilities.loadSession) throw new Error('Mint runtime cannot restore this session');
      await this.request('session/load', { sessionId: saved.id, cwd: this.config.cwd, mcpServers: [] });
      result = saved;
    } else {
      result = await this.request('session/new', { cwd: this.config.cwd, mcpServers: [] });
    }
    const state = { key, id: result.sessionId || result.id, turns: result.turns || {}, projectKey: result.projectKey || this.config.cwd };
    if (!state.id) throw new Error('Mint did not return a sessionId');
    const file = this.mappingPath(key);
    const temp = file + '.' + randomUUID();
    await writeFile(temp, JSON.stringify({ id: state.id, turns: state.turns, projectKey: state.projectKey }), { mode: 0o600 });
    await rename(temp, file);
    this.sessions.set(key, state);
    return state;
  }
  async uploadedFiles(uploads) {
    if (!uploads?.length) return [];
    if (!this.uploadStore) {
      const { UploadStore } = await import('../../../src/gateway/dialog/UploadStore.js');
      const root = this.config.cwd;
      this.uploadStore = new UploadStore({
        resolveProject: async key => {
          if (path.resolve(key || '') !== root) throw new Error('Mint upload belongs to another project');
          return root;
        },
        listProjects: async () => [root],
      });
    }
    const files = [];
    for (const upload of uploads) {
      const verified = await this.uploadStore.verifyAttachment(upload.uploadId, this.config.cwd, upload.attachmentIds);
      for (const file of verified) files.push({ type: 'file', path: file.path, name: file.name });
    }
    return files;
  }
  async *submitTurn(input) {
    if (input.projectKey && path.resolve(input.projectKey) !== this.config.cwd) {
      let saved;
      try { saved=JSON.parse(await readFile(this.mappingPath(input.sessionKey),'utf8')); } catch {}
      if (!saved || saved.projectKey !== this.config.cwd) throw new Error('Mint backend is bound to ' + this.config.cwd + '; select that project');
    }
    await this.start();
    const state = await this.session(input.sessionKey);
    if (state.push) throw new Error('Mint session already has an active turn');
    const structured = this.config.env.PILOTDECK_MINT_STRUCTURED_INPUT === '1';
    if ((input.attachments?.length || input.uploadedAttachments?.length) && !structured) throw new Error('Mint attachments require the installed package worker');
    const files = [...(input.attachments || []), ...await this.uploadedFiles(input.uploadedAttachments)];
    const attachments = await mintAttachmentReferences(files, this.config.cwd);
    let wake, done = false, failure;
    const queue = [];
    const journal = path.join(this.config.cwd, '.mint', 'sessions', state.id + '.jsonl');
    let turn = 1;
    try { turn += (await readFile(journal,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(r=>r.event.event==='turn_started').length; }
    catch(error) { if(error.code!=='ENOENT') throw error; }
    state.turns['t_'+turn] = input.runId;
    await writeFile(this.mappingPath(input.sessionKey),JSON.stringify({id:state.id,turns:state.turns,projectKey:this.config.cwd}),{mode:0o600});
    delete state.runtimeError;
    state.runId = input.runId;
    state.push = event => { queue.push({ ...event, runId: input.runId }); wake?.(); };
    state.push({ type: 'input_accepted' });
    const seenToolEvents = new Set();
    const originalPush = state.push;
    state.push = event => {
      if (['tool_call_started', 'tool_call_finished'].includes(event.type)) {
        const key = JSON.stringify(event);
        if (seenToolEvents.has(key)) return;
        seenToolEvents.add(key);
      }
      originalPush(event);
    };
    const task = this.request('session/prompt', {
      sessionId: state.id, prompt: [{ type: 'text', text: input.message }],
      ...(structured ? { _meta: { 'mint/structured-input': true, 'mint/attachments': attachments } } : {}),
    }).then(result => {
      if(state.runtimeError) throw new Error(state.runtimeError);
      state.push({ type: 'turn_completed', finishReason: result.stopReason });
    }).catch(error => { failure = error; }).finally(() => { done = true; wake?.(); });
    try {
      while (!done || queue.length) {
        if (queue.length) yield queue.shift();
        else await new Promise(resolve => { wake = resolve; });
      }
      if (failure) throw failure;
    } finally {
      delete state.push;
      delete state.runId;
      if (!done) await this.abortTurn({ sessionKey: input.sessionKey });
      await task;
    }
  }
  async abortTurn({ sessionKey }) {
    const state = this.sessions.get(sessionKey);
    if (state) this.send({ method: 'session/cancel', params: { sessionId: state.id } });
  }
  async permissionDecide({ requestId, decision }) {
    const pending = this.permissions.get(requestId);
    if (!pending) return { delivered: false };
    const kind = decision === 'allow' ? 'allow_once' : 'reject_once';
    const option = pending.params.options?.find(o => o.kind === kind);
    if (!option) throw new Error(`Mint permission does not offer ${kind}`);
    this.send({ id: pending.id, result: { outcome: { outcome: 'selected', optionId: option.optionId } } });
    this.permissions.delete(requestId);
    return { delivered: true };
  }
  async readSessionMessages({ sessionKey, limit, cursor }) {
    let saved;
    try { saved = JSON.parse(await readFile(this.mappingPath(sessionKey), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { session: { sessionId: sessionKey, cwd: this.config.cwd }, messages: [], total: 0 };
      throw error;
    }
    const file = path.join(this.config.cwd, '.mint', 'sessions', saved.id + '.jsonl');
    const records = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const messages = [];
    let turnId;
    for (const record of records) {
      const event = record.event;
      if (event.event === 'turn_started') turnId = saved.turns?.[event.turn] || event.turn;
      const base = { id: `${saved.id}:${record.seq}`, sessionKey, createdAt: record.at,
        provider: 'mint', source: 'history', sequence: record.seq, turnId };
      if (event.event === 'user_message_chunk' || event.event === 'agent_message_chunk') {
        messages.push({ ...base, role: event.event === 'user_message_chunk' ? 'user' : 'assistant',
          kind: 'text', text: event.content?.text || '' });
      }
      if (event.event === 'tool_call') messages.push({ ...base, role: 'assistant', kind: 'tool_use',
        toolCallId: event.call?.id, toolName: event.call?.name, payload: event.call?.args });
      if (event.event === 'tool_call_update' && ['completed', 'failed', 'cancelled'].includes(event.status)) messages.push({ ...base, role: 'tool', kind: 'tool_result',
        toolCallId: event.call_id, ok: event.status === 'completed', text: JSON.stringify(event.content || []) });
    }
    // Consecutive chunks from one role/turn are a single historical message.
    const merged = [];
    for (const message of messages) {
      const previous = merged.at(-1);
      if (message.kind === 'text' && previous?.kind === 'text' && previous.role === message.role && previous.turnId === message.turnId) previous.text += message.text;
      else merged.push(message);
    }
    const offset = Number(cursor || 0);
    const end = limit ? offset + limit : merged.length;
    return { session: { sessionId: sessionKey, cwd: this.config.cwd, projectKey: this.config.cwd },
      messages: merged.slice(offset, end), total: merged.length,
      ...(end < merged.length ? { nextCursor: String(end) } : {}) };
  }
  async listSessions({projectKey} = {}) {
    if (projectKey && path.resolve(projectKey) !== this.config.cwd) return {sessions:[]};
    await mkdir(this.config.stateDir, { recursive: true });
    const sessions = [];
    for (const name of await readdir(this.config.stateDir)) {
      if (!/^(?:[0-9a-f]{2})+\.json$/.test(name)) continue;
      const key = Buffer.from(name.slice(0, -5), 'hex').toString();
      const result = await this.readSessionMessages({ sessionKey: key });
      if (result.messages.length) sessions.push({ sessionId: key, sessionKey: key, cwd: this.config.cwd, projectKey: this.config.cwd, projectPath: this.config.cwd,
        summary: result.messages.find(m => m.role === 'user')?.text?.slice(0, 100) || 'Mint session',
        lastModified: Date.parse(result.messages.at(-1).createdAt) });
    }
    return { sessions: sessions.sort((a, b) => b.lastModified - a.lastModified) };
  }
  modelSelection() {
    const model = this.config.env.PILOTDECK_MINT_MODEL;
    if (!model) throw new Error('PILOTDECK_MINT_MODEL must match the runtime model');
    return { mode: 'model', provider: 'mint', model };
  }
  async projectFilesList(input) {
    if(path.resolve(input.projectKey)!==this.config.cwd) throw new Error('Unknown Mint project');
    const {listProjectFiles}=await import('../../../src/gateway/dialog/projectFiles.js');
    return listProjectFiles({...input,projectKey:this.config.cwd});
  }
  async skillsList() { return {builtin:[],user:[],project:[],items:[],projectPath:this.config.cwd}; }
  async describeServer() {
    return {mode:'in_process', sessionCount:this.sessions.size, activeTurnCount:[...this.sessions.values()].filter(s=>s.push).length,
      capabilities:['project_files_list','model_catalog_list','session_model_get','session_model_set','session_model_clear']};
  }
  async modelCatalogList() {
    const selection=this.modelSelection();
    return {defaultSelection:selection,items:[{id:'mint/'+selection.model,provider:'mint',model:selection.model,displayName:selection.model+' (Mint)',available:true,capabilities:{}}],router:{enabled:false,autoAvailable:false}};
  }
  async sessionModelGet({projectKey,sessionKey}) {
    const selection=this.modelSelection();
    return {projectKey,sessionKey,effective:{provider:selection.provider,model:selection.model,source:'default'}};
  }
  async sessionModelSet(input) {
    const selection=this.modelSelection();
    if(input.selection?.mode!=='model'||input.selection.provider!==selection.provider||input.selection.model!==selection.model) throw new Error('This Mint instance has one configured model');
    return this.sessionModelGet(input);
  }
  async sessionModelClear() {}
  async describeProject() {
    const { sessions } = await this.listSessions();
    return { projectKey: this.config.cwd, fullPath: this.config.cwd,
      name: path.basename(this.config.cwd), sessionCount: sessions.length,
      lastActivity: sessions[0]?.lastModified };
  }
  async listProjects() { return { projects: [await this.describeProject()] }; }
  async getActiveTurnSnapshot({ sessionKey }) {
    const state = this.sessions.get(sessionKey);
    return { active: Boolean(state?.push), runId: state?.runId ?? null, events: [] };
  }
  async respondElicitation() { throw new Error('Mint backend does not support structured elicitation'); }
  async replaceLastTurn() { throw new Error('Mint backend does not support editing previous turns'); }
  async forkSession() { throw new Error('Mint backend does not support session forks'); }
  async recordAgentStatusMessage() { /* Execution errors are already shown by the bridge. */ }
}

export function acpUpdateToEvents(update) {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': return [{ type: 'assistant_text_delta', text: update.content?.text || '' }];
    case 'agent_thought_chunk': return [{ type: 'assistant_thinking_delta', text: update.content?.text || '' }];
    case 'tool_call': return [{ type: 'tool_call_started', toolCallId: update.toolCallId,
      name: update.title, argsPreview: JSON.stringify(update.rawInput || {}) }];
    case 'tool_call_update':
      if (!['completed', 'failed'].includes(update.status)) return [];
      return [{ type: 'tool_call_finished', toolCallId: update.toolCallId, ok: update.status === 'completed',
        resultPreview: JSON.stringify(update.rawOutput ?? update.content ?? '') }];
    default: return [];
  }
}

let singleton;
export function getMintAcpGateway(env = process.env) {
  if (!singleton) {
    let args;
    try { args = JSON.parse(env.PILOTDECK_MINT_ARGS || '[]'); }
    catch { throw new Error('PILOTDECK_MINT_ARGS must be a JSON string array'); }
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new Error('PILOTDECK_MINT_ARGS must be a JSON string array');
    singleton = new MintAcpGateway({ command: env.PILOTDECK_MINT_COMMAND, args,
      cwd: env.PILOTDECK_MINT_PROJECT, stateDir: env.PILOTDECK_MINT_STATE_DIR, env });
  }
  return singleton;
}

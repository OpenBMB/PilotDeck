import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MintAcpGateway, acpUpdateToEvents, mintAttachmentReferences } from '../../ui/server/services/mintAcpGateway.js';

test('ACP deltas and terminal tool updates map to existing UI events', () => {
  assert.deepEqual(acpUpdateToEvents({ sessionUpdate: 'agent_message_chunk', content: { text: 'hello' } }),
    [{ type: 'assistant_text_delta', text: 'hello' }]);
  assert.deepEqual(acpUpdateToEvents({ sessionUpdate: 'tool_call_update', status: 'in_progress' }), []);
  assert.equal(acpUpdateToEvents({ sessionUpdate: 'tool_call_update', status: 'failed', toolCallId: 't' })[0].ok, false);
});

test('real ACP transport correlates frames and reuses a session across turns', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-acp-test-'));
  const program = `
    const rl = require('node:readline').createInterface({input:process.stdin});
    const send = x => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
    let sessions = 0;
    rl.on('line', line => {
      const f = JSON.parse(line);
      if (f.method === 'initialize') send({id:f.id,result:{agentCapabilities:{loadSession:true}}});
      if (f.method === 'session/new') send({id:f.id,result:{sessionId:'s'+(++sessions)}});
      if (f.method === 'session/prompt') {
        send({method:'session/update',params:{sessionId:f.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{text:f.params.sessionId+':'+f.params.prompt[0].text}}}});
        send({id:f.id,result:{stopReason:'end_turn'}});
      }
    });`;
  const gw = new MintAcpGateway({ command: process.execPath, args: ['-e', program], cwd: stateDir, stateDir });
  try {
    for (const message of ['one', 'two']) {
      const events = [];
      for await (const event of gw.submitTurn({sessionKey:'web:test',message,runId:message})) events.push(event);
      assert.equal(events[0].type, 'input_accepted');
      assert.equal(events[1].text, 's1:'+message);
      assert.equal(events.at(-1).type, 'turn_completed');
    }
  } finally { gw.close(); await rm(stateDir, {recursive:true,force:true}); }
});

test('invalid runtime path fails before spawning', () => {
  assert.throws(() => new MintAcpGateway({ command: 'relative' }), /absolute/);
});

test('attachment references resolve project files and reject symlinks outside the project', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mint-upload-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'mint-outside-'));
  try {
    await writeFile(path.join(root, 'note.txt'), 'hello');
    await writeFile(path.join(outside, 'private.txt'), 'outside');
    await symlink(path.join(outside, 'private.txt'), path.join(root, 'link.txt'));
    assert.deepEqual(await mintAttachmentReferences([{type:'file',path:path.join(root,'note.txt')}], root),
      [{uri:'env://local/note.txt',name:'note.txt'}]);
    await assert.rejects(mintAttachmentReferences([{type:'file',path:path.join(root,'link.txt')}],root), /inside/);
  } finally { await rm(root,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true}); }
});


test('browser upload references use the project store and preserve selected attachment order', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mint-upload-store-'));
  const calls = [];
  const gw = new MintAcpGateway({command:process.execPath,cwd:root,stateDir:root,
    uploadStore:{async verifyAttachment(...args) {
      calls.push(args);
      return [{path:path.join(root,'note.txt'),name:'中文附件.txt'}];
    }}});
  try {
    await writeFile(path.join(root,'note.txt'),'附件内容');
    const files = await gw.uploadedFiles([{uploadId:'upload1',attachmentIds:['second','first']}]);
    assert.deepEqual(calls,[['upload1',root,['second','first']]]);
    assert.deepEqual(await mintAttachmentReferences(files,root),
      [{uri:'env://local/note.txt',name:'中文附件.txt'}]);
    gw.uploadStore.verifyAttachment = async () => {throw new Error('Upload expired');};
    await assert.rejects(gw.uploadedFiles([{uploadId:'expired'}]),/expired/);
  } finally {gw.close();await rm(root,{recursive:true,force:true});}
});

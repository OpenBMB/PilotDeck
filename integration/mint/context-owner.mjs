// Context preparation only; turn execution remains in the external Rust loop.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { DefaultContextRuntime } from '../../src/context/DefaultContextRuntime.js';
import { ToolResultBudget } from '../../src/context/budget/ToolResultBudget.js';
import { mkdir, appendFile } from 'node:fs/promises';
const toolResultsDir = process.env.MINT_TOOL_RESULTS_DIR || `${process.cwd()}/.pilotdeck/tool-results`;
await mkdir(toolResultsDir, { recursive: true });
// The external Rust loop owns turn execution, while PilotDeck supplies the
// existing budget owner so oversized tool-result media can become durable
// media_reference blocks before the provider request.
const toolResultBudget = new ToolResultBudget({ toolResultsDir });
const owner = new DefaultContextRuntime({ toolResultBudget });
const mediaEvidence = process.env.MINT_MEDIA_EVIDENCE || `${process.cwd()}/media-owner-evidence.log`;
const imagePackageDefault = `${process.env.MINT_PROJECT || process.cwd()}/.mint/packages/liyishan1/pilotdeck-context-image-offload@0.1.2/dist/index.js`;
const imageOffloadPackage = await import(`${process.env.MINT_IMAGE_OFFLOAD_PACKAGE || imagePackageDefault}`);
const imageOffload = imageOffloadPackage.createImageOffload({ budget: toolResultBudget });
const applyToolResults = owner.applyToolResults.bind(owner);
owner.applyToolResults = async (input) => {
  await appendFile(mediaEvidence, JSON.stringify({ stage: 'before', blocks: input.toolResultMessage.content }) + '\n');
  const result = await applyToolResults(input);
  await appendFile(mediaEvidence, JSON.stringify({ stage: 'after', blocks: result.messages?.at(-1)?.content, appended: result.appendedMessages }) + '\n');
  return result;
};
const opaqueTokens = new Map();
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const input = JSON.parse(line);
    const opaque = new Map();
    const messages = input.messages.map(message => ({ role: message.role, content: [
      ...message.blocks.map(block => {
        if (block.type === 'text') return block;
        if (block.type === 'json') {
          const key = JSON.stringify(block);
          let token = opaqueTokens.get(key);
          if (!token) { token = 'mint-context-block:' + randomUUID(); opaqueTokens.set(key, token); }
          opaque.set(token, block);
          return {type:'text',text:token};
        }
        // ACP already carries multimodal blocks in canonical shape. Preserve
        // them through the context owner so the external Rust loop can route
        // images/PDF/audio to the installed provider and image-offload owner.
        if (block.type === 'image') return {
          type: 'image', source: block.source || 'base64', data: block.data,
          mimeType: block.mimeType, ...(block.bytes ? {bytes: block.bytes} : {}),
        };
        if (block.type === 'pdf') return {
          type: 'pdf', source: 'base64', data: block.data,
          mimeType: block.mimeType || 'application/pdf', bytes: block.bytes || 0,
        };
        if (block.type === 'audio') return {
          type: 'audio', source: block.source || 'base64', data: block.data,
          mimeType: block.mimeType, ...(block.bytes ? {bytes: block.bytes} : {}),
        };
        throw new Error(`Context owner unsupported block: ${block.type}`);
      }),
      ...(message.tool_calls || []).map(call => ({type:'tool_call',id:call.id,name:call.name,input:call.args})),
    ], ...(message.tool_call_id ? {role:'user', content:[{type:'tool_result',toolCallId:message.tool_call_id,content:message.blocks.map(block =>
      block.type === 'image' ? {type:'image',source:'base64',data:block.blob ?? block.data,mimeType:block.mime ?? block.mimeType,bytes:block.bytes} : block
    )}]} : {}) }));
    const mediaHandledMessages = await Promise.all(messages.map(async message => {
      if (message.role !== 'user') return message;
      let changed = false;
      const content = [];
      for (const block of message.content) {
        if (block.type !== 'tool_result') { content.push(block); continue; }
        const nested = [];
        for (let index = 0; index < block.content.length; index += 1) {
          const item = block.content[index];
          const replaced = item.type === 'image' || item.type === 'pdf' || item.type === 'audio'
            ? await imageOffload.replaceMedia(item, index, block.toolCallId, { turnId: input.turn }) : item;
          changed ||= replaced !== item; nested.push(replaced);
        }
        content.push(changed ? { ...block, content: nested } : block);
      }
      return changed ? { ...message, content } : message;
    }));
    const budgetedMessages = await Promise.all(mediaHandledMessages.map(message =>
      message.role === 'user' && message.content.some(block => block.type === 'tool_result')
        ? toolResultBudget.applyToMessage(message, { turnId: input.turn }) : message));
    if (budgetedMessages.some((message, index) => JSON.stringify(message) !== JSON.stringify(messages[index]))) {
      await appendFile(mediaEvidence, JSON.stringify({ stage: 'prepare', messages: budgetedMessages }) + '\n');
    }
    const result = await owner.prepareForModel({sessionId:input.session,turnId:input.turn,cwd:input.cwd,
      provider:'mint',model:input.model,permissionMode:'default',additionalWorkingDirectories:[],
      messages:budgetedMessages,tools:input.tools.map(t=>({name:t.name,description:t.description,inputSchema:t.input_schema}))});
    const prepared = {messages:result.messages.map(message=>{
      const toolCalls = message.content.filter(b=>b.type==='tool_call').map(b=>({id:b.id,name:b.name,args:b.input}));
      const toolResult=message.content.find(b=>b.type==='tool_result');
      return {role:toolResult?'tool':message.role, blocks:toolResult?toolResult.content:message.content
        .filter(b=>b.type!=='tool_call' && b.type!=='tool_result')
        .map(b=>b.type==='text' ? (opaque.get(b.text) || b) : b),
        ...(toolCalls.length?{tool_calls:toolCalls}:{}),...(toolResult?{tool_call_id:toolResult.toolCallId}:{})};
    }),systemPrompt:result.systemPromptParts.filter(part=>part.startsWith('<environment>')).join('\n\n')};
    process.stdout.write(JSON.stringify({preparedContext:prepared})+'\n');
  } catch(error) {process.stdout.write(JSON.stringify({error:error.message})+'\n');}
}

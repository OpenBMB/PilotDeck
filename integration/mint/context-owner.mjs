// Context preparation only; turn execution remains in the external Rust loop.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { DefaultContextRuntime } from '../../src/context/DefaultContextRuntime.js';
const owner = new DefaultContextRuntime();
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
        throw new Error('Context owner media mapping unavailable');
      }),
      ...(message.tool_calls || []).map(call => ({type:'tool_call',id:call.id,name:call.name,input:call.args})),
    ], ...(message.tool_call_id ? {role:'user', content:[{type:'tool_result',toolCallId:message.tool_call_id,content:message.blocks}]} : {}) }));
    const result = await owner.prepareForModel({sessionId:input.session,turnId:input.turn,cwd:input.cwd,
      provider:'mint',model:input.model,permissionMode:'default',additionalWorkingDirectories:[],
      messages,tools:input.tools.map(t=>({name:t.name,description:t.description,inputSchema:t.input_schema}))});
    const prepared = {messages:result.messages.map(message=>{
      const toolCalls = message.content.filter(b=>b.type==='tool_call').map(b=>({id:b.id,name:b.name,args:b.input}));
      const toolResult=message.content.find(b=>b.type==='tool_result');
      return {role:toolResult?'tool':message.role, blocks:toolResult?toolResult.content:message.content.filter(b=>b.type==='text').map(b=>opaque.get(b.text) || b),
        ...(toolCalls.length?{tool_calls:toolCalls}:{}),...(toolResult?{tool_call_id:toolResult.toolCallId}:{})};
    }),systemPrompt:result.systemPromptParts.filter(part=>part.startsWith('<environment>')).join('\n\n')};
    process.stdout.write(JSON.stringify({preparedContext:prepared})+'\n');
  } catch(error) {process.stdout.write(JSON.stringify({error:error.message})+'\n');}
}

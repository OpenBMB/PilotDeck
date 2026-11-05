// Explicit local override for model-provider-openai-consumer 0.1.2.
// The published codec still builds requests and normalizes final completion.
import { buildRequest, parseSSE, normalizeOpenAIFinishReason, normalizeOpenAIUsage } from 'pilotdeck-model-openai-compat';
export default { activate(ctx) {
  ctx.on('before_model', async payload => {
    const p = payload.pilotdeck_openai;
    if (!p) return {};
    if (p.mode !== 'stream' || typeof p.provider?.apiKey !== 'string' || !p.idempotency_key) throw Error('invalid streaming provider configuration');
    const body = buildRequest({...p.request,stream:true});
    body.stream_options={include_usage:true};
    let source = '', pendingBytes = [], pendingText = '', finished = false, usage;
    const tools = new Map();
    const decode = base64 => {
      const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const bytes=[]; let bits=0,value=0;
      for(const c of base64) {if(c==='=')break;const n=alphabet.indexOf(c);if(n<0)throw Error('invalid transport base64');value=(value<<6)|n;bits+=6;if(bits>=8){bits-=8;bytes.push((value>>bits)&255);}}
      pendingBytes.push(...bytes);
      // Decode only a complete UTF-8 prefix; native TextDecoder is stateless.
      let end = pendingBytes.length;
      let start = end - 1;
      while (start >= 0 && (pendingBytes[start] & 192) === 128) start--;
      if (start >= 0) {
        const lead = pendingBytes[start];
        const size = lead < 128 ? 1 : lead < 224 ? 2 : lead < 240 ? 3 : 4;
        if (end-start < size) end=start;
      }
      const text = new TextDecoder().decode(Uint8Array.from(pendingBytes.splice(0,end)));
      return text;
    };
    const emit = event => { const key=p.idempotency_key+':event:'+sequence++; const next=emission.then(()=>ctx.call({type:'service.call',method:'model.event',payload:event,idempotencyKey:key})); emission=next; return next; };
    let sequence = 0;
    let emission = Promise.resolve();
    const work = { push(promise) { promise.catch(()=>{}); } };
    const frame = text => {
      const data = text.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
      if (!data || data.trim()==='[DONE]') return;
      const raw=JSON.parse(data);
      if(raw.error) throw Error('upstream model error');
      if(raw.usage) usage=normalizeOpenAIUsage(raw.usage);
      for(const choice of raw.choices || []) {
        const delta=choice.delta || {};
        if(delta.content) work.push(emit({kind:'text_delta',text:delta.content}));
        if(delta.reasoning_content || delta.reasoning) work.push(emit({kind:'thought_delta',text:delta.reasoning_content || delta.reasoning}));
        for(const item of delta.tool_calls || []) {
          const key=item.index ?? 0;
          let tool=tools.get(key);
          if(!tool) {tool={id:item.id,name:'',args:'',started:false};tools.set(key,tool);}
          if(item.id) tool.id=item.id;
          if(item.function?.name) tool.name=item.function.name;
          if(item.function?.arguments) tool.args+=item.function.arguments;
          if(!tool.started && tool.id && tool.name) {tool.started=true;work.push(emit({kind:'tool_call_start',id:tool.id,name:tool.name}));}
        }
        if(choice.finish_reason) {
          const reason=normalizeOpenAIFinishReason(choice.finish_reason);
          if(!['stop','tool_call','length'].includes(reason))throw Error('unsupported model finish reason');
          for(const tool of tools.values()) {
            if(!tool.started)throw Error('incomplete tool identity');
            JSON.parse(tool.args || '{}');
            work.push(emit({kind:'tool_call_args_delta',id:tool.id,delta:tool.args || '{}'}));
            work.push(emit({kind:'tool_call_end',id:tool.id}));
          }
          finished=true;
        }
      }
    };
    await ctx.stream({type:'service.call',method:'model.http_stream',payload:{url:p.provider.url,method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+p.provider.apiKey,accept:'text/event-stream'},body:JSON.stringify(body)},idempotencyKey:p.idempotency_key}, event=>{
      if(event.type==='response' && !event.contentType.includes('text/event-stream'))throw Error('streaming response required');
      if(event.type!=='bytes')return;
      const text=decode(event.base64);source+=text;pendingText+=text;
      let match;
      while((match=/\r?\n\r?\n/.exec(pendingText))) {
        const part=pendingText.slice(0,match.index);pendingText=pendingText.slice(match.index+match[0].length);frame(part);
      }
    });
    if(pendingBytes.length)throw Error('incomplete UTF-8 model stream');
    if(pendingText.trim())frame(pendingText);
    const parsed=parseSSE(source); // Official codec validates complete SSE/tool payload.
    const end=parsed.filter(e=>e.type==='message_end').at(-1);
    if(!finished || !end)throw Error('incomplete model stream');
    await emission;
    await emit({kind:'done',stop_reason:end.finishReason==='length'?'max_tokens':'end_turn',usage:{input_tokens:usage?.inputTokens ?? 0,output_tokens:usage?.outputTokens ?? 0}});
    return {patch:{pilotdeck_openai_result:{streamed:true,provenance:{transport:'model.http_stream',override:true}}}};
  });
}};

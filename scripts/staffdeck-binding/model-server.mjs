import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Deterministic HTTP provider: L2 exercises production model transport, not a Gateway factory hook.
export function startModelServer(port, capture) {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    capture.push(body);
    if (process.env.BINDING_QA_CAPTURE) writeFileSync(process.env.BINDING_QA_CAPTURE, JSON.stringify(capture, null, 2));
    const tools = body.tools?.map(tool => tool.function?.name) ?? [];
    const submitted = body.messages?.some(message => message.role === 'tool');
    const route = !tools.length && body.messages?.some(message =>
      JSON.stringify(message).includes('task_frames'));
    const call = tools.includes('submit_step_result') && !submitted;
    const content = route ? JSON.stringify({ decision: 'start_new_task', confidence: 1,
      task_frames: [{ kind: 'sop', decision: 'start_new_task', target_skill_id: 'binding_a_sop' }] })
      : 'Binding acceptance ordinary chat';
    let delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'binding-submit',
      type: 'function', function: { name: 'submit_step_result', arguments: JSON.stringify({
        status: 'completed', replyFragment: 'BINDING_A_COMPLETED' }) } }] }
      : { role: 'assistant', content };
    const text = JSON.stringify(body.messages || []);
    if (!tools.length && !route && /raw_content|candidate_skill/.test(text)) {
      const card = { skill_id: 'binding_editor_sop', name: 'Binding editor procedure', version: '1.0.0',
        description: 'Browser authoring acceptance', trigger_intents: ['BINDING_EDITOR'],
        nodes: [{ node_id: 'answer', name: 'Answer', type: 'response', instruction: 'Reply BROWSER_EDITOR_COMPLETE and finish',
          allowed_actions: ['answer_user'], capability_refs: { knowledge_base_ids: [] } }],
        edges: [], start_node_id: 'answer', terminal_node_ids: ['answer'] };
      delta = { role: 'assistant', content: JSON.stringify({ draft_skill: card, warnings: [], tool_mentions: [],
        rubric_results: [], needs_revision: false }) };
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'binding-model', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ id: 'binding-model', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'binding-model', object: 'chat.completion',
        choices: [{ index: 0, message: delta, finish_reason: call ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    }
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startModelServer(Number(process.env.BINDING_QA_MODEL_PORT), []);
}

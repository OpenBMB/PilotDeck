import type { AgentEvent } from '../../agent/protocol/events.js';
import type { GatewayEvent } from '../protocol/types.js';

const MUTATIONS = new Set(['write_file', 'write', 'edit_file', 'edit', 'apply_patch', 'applypatch']);
const PREFIX_LIMIT = 8192;

/** Read only a complete, valid top-level path. Never retain streamed file contents. */
function readPath(prefix: string): string | undefined {
  let depth = 0;
  for (let index = 0; index < prefix.length; index++) {
    const char = prefix[index];
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === '"') {
      const start = index++;
      for (; index < prefix.length && prefix[index] !== '"'; index++) if (prefix[index] === '\\') index++;
      if (index >= prefix.length) return;
      if (depth !== 1) continue;
      let key: unknown;
      try { key = JSON.parse(prefix.slice(start, index + 1)); } catch { return; }
      let cursor = index + 1;
      while (/\s/.test(prefix[cursor] || '') && cursor < prefix.length) cursor++;
      if (!['file_path', 'path'].includes(String(key)) || prefix[cursor++] !== ':') continue;
      while (/\s/.test(prefix[cursor] || '') && cursor < prefix.length) cursor++;
      if (prefix[cursor] !== '"') return;
      const valueStart = cursor++;
      for (; cursor < prefix.length && prefix[cursor] !== '"'; cursor++) if (prefix[cursor] === '\\') cursor++;
      if (cursor >= prefix.length) return;
      try {
        const value = JSON.parse(prefix.slice(valueStart, cursor + 1));
        return typeof value === 'string' && value.trim() && value.length <= 4096 ? value : undefined;
      } catch { return; }
    }
  }
}

type Draft = { id: string; callId: string; name: string; child?: string; bytes: number; prefix: string; path?: string; emittedAt: number };

/** Bounded, throttled presentation metadata. It never publishes or executes a provisional tool call. */
export class FileInputProgress {
  private drafts = new Map<string, Draft>();
  private sequence = 0;
  constructor(private readonly runId: string, private readonly now: () => number = Date.now) {}

  private frame(draft: Draft, state: 'running' | 'completed' | 'cancelled'): GatewayEvent {
    return { type: 'agent_status', event: 'file_input_progress', runId: this.runId, detail: {
      activityId: draft.id, toolCallId: draft.callId, toolName: draft.name, state,
      ...(draft.child ? { subagentId: draft.child } : {}),
      receivedBytes: draft.bytes, ...(draft.path ? { filePath: draft.path } : {}),
    } };
  }

  private clear(child?: string, state: 'completed' | 'cancelled' = 'cancelled', calls?: Set<string>): GatewayEvent[] {
    const frames: GatewayEvent[] = [];
    for (const [key, draft] of this.drafts) {
      if (draft.child !== child || (calls && !calls.has(draft.callId))) continue;
      frames.push(this.frame(draft, state)); this.drafts.delete(key);
    }
    return frames;
  }

  finish(): GatewayEvent[] {
    const frames = [...this.drafts.values()].map(draft => this.frame(draft, 'cancelled'));
    this.drafts.clear();
    return frames;
  }

  accept(event: AgentEvent): GatewayEvent[] {
    if (event.type === 'model_request_started') return this.clear();
    if (event.type === 'turn_completed') return this.finish();
    if (event.type === 'tool_calls_detected') return this.clear(undefined, 'completed', new Set(event.calls.map(call => call.id)));
    if (event.type === 'subagent_tool_calls_detected') return this.clear(event.subagentId, 'completed', new Set(event.calls.map(call => call.id)));
    if (event.type === 'subagent_completed') return this.clear(event.subagentId);
    if (event.type !== 'model_event' && event.type !== 'subagent_model_event') return [];
    const child = event.type === 'subagent_model_event' ? event.subagentId : undefined;
    const model = event.event;
    if (model.type === 'request_started' || model.type === 'error') return this.clear(child);
    if (model.type !== 'tool_call_start' && model.type !== 'tool_call_delta' && model.type !== 'tool_call_end') return [];
    const callId = model.type === 'tool_call_end' ? model.toolCall.id : model.id;
    const key = JSON.stringify([child, callId]);
    if (model.type === 'tool_call_start') {
      if (!MUTATIONS.has(model.name.toLowerCase()) || this.drafts.has(key)) return [];
      const draft: Draft = { id: `file-input:${this.runId}:${++this.sequence}:${callId}`, callId, name: model.name,
        child, bytes: 0, prefix: '', emittedAt: this.now() };
      this.drafts.set(key, draft);
      return [this.frame(draft, 'running')];
    }
    const draft = this.drafts.get(key);
    if (!draft) return [];
    if (model.type === 'tool_call_end') {
      draft.prefix = '';
      return [this.frame(draft, 'running')];
    }
    draft.bytes += Buffer.byteLength(model.delta, 'utf8');
    const previousPath = draft.path;
    if (!draft.path && draft.prefix.length < PREFIX_LIMIT) {
      draft.prefix += model.delta.slice(0, PREFIX_LIMIT - draft.prefix.length);
      draft.path = readPath(draft.prefix);
      if (draft.path) draft.prefix = '';
    }
    if (this.now() - draft.emittedAt < 150 && previousPath === draft.path) return [];
    draft.emittedAt = this.now();
    return [this.frame(draft, 'running')];
  }
}

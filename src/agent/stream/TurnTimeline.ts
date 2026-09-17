import type { AgentEvent } from '../protocol/events.js';
import type { CanonicalMessage } from '../../model/protocol/canonical.js';
import type { TimelinePosition } from '../../model/protocol/timeline.js';

/** One allocator owns live and durable coordinates for a turn. */
export class TurnTimeline {
  constructor(private readonly turnId: string) {}
  private lastModelPosition?: TimelinePosition;
  private previousId?: string;
  private nextOrder = 0;
  private revision = 0;
  private positions = new Map<string, TimelinePosition>();
  private provisionalTools = new Set<string>();
  private offsets = new Map<string, number>();

  position(id: string, provisional = false): TimelinePosition {
    let position = this.positions.get(id);
    if (!position) {
      position = { version: 1, turnId: this.turnId, id, ...(this.previousId ? { previousId: this.previousId } : {}), order: this.nextOrder++, revision: ++this.revision };
      this.positions.set(id, position);
      if (provisional) this.provisionalTools.add(id);
      else this.previousId = id;
    }
    if (!provisional && this.provisionalTools.delete(id)) {
      // Only published tools enter the predecessor chain. Receiving complete
      // arguments does not mean AgentLoop will retain this response.
      const previous = [...this.positions.values()].filter(candidate =>
        candidate.order < position!.order && !this.provisionalTools.has(candidate.id))
        .sort((a, b) => b.order - a.order)[0];
      position = { ...position, previousId: previous?.id };
      this.positions.set(id, position);
      if (!this.previousId || this.positions.get(this.previousId)!.order < position.order) this.previousId = id;
    }
    return position;
  }

  update(id: string): TimelinePosition {
    const next = { ...this.position(id), revision: ++this.revision };
    this.positions.set(id, next);
    return next;
  }

  message(message: CanonicalMessage): void {
    for (const block of message.content) {
      const id = (block.type === 'text' || block.type === 'thinking') ? block.blockId
        : block.type === 'tool_call' ? `tool:${block.id}`
        : (block.type === 'tool_result' || block.type === 'tool_result_reference') ? `result:${block.toolCallId}`
        : undefined;
      // User steers also have stable coordinates; legacy input stays untouched.
      if (id) block.timeline ??= this.update(id);
      else if (message.metadata?.queueItemId) block.timeline ??= this.position(`steer:${message.metadata.queueItemId}`);
    }
  }

  event(event: AgentEvent): AgentEvent {
    if (event.type === 'model_request_started') {
      for (const id of this.provisionalTools) this.positions.delete(id);
      this.provisionalTools.clear();
    }
    if (event.type === 'model_event') {
      // Reserve the tool's slot before any subsequent text gets a position.
      // Some adapters emit only a complete tool call, without a start frame.
      if (event.event.type === 'tool_call_start') this.position(`tool:${event.event.id}`, true);
      if (event.event.type === 'tool_call_end') this.position(`tool:${event.event.toolCall.id}`, true);
    }
    if (event.type === 'model_event' && event.blockId &&
        (event.event.type === 'text_delta' || event.event.type === 'thinking_delta')) {
      const offset = this.offsets.get(event.blockId) ?? 0;
      this.offsets.set(event.blockId, offset + event.event.text.length);
      this.lastModelPosition = this.update(event.blockId);
      return { ...event, timeline: { ...this.lastModelPosition, offset } };
    }
    if (event.type === 'model_event' && this.lastModelPosition &&
        ['message_end', 'tool_call_start', 'error'].includes(event.event.type)) {
      return { ...event, streamBoundary: { turnId: this.turnId,
        through: this.lastModelPosition.order, revision: ++this.revision } };
    }
    if (event.type === 'assistant_message' || event.type === 'tool_results_projected' || event.type === 'steer_applied') {
      this.message(event.message);
    }
    if (event.type === 'tool_calls_detected') {
      for (const call of event.calls) call.timeline = this.position(`tool:${call.id}`);
    }
    if (event.type === 'compact_started' || event.type === 'compact_completed') return { ...event, timeline: this.update(`compact:${event.compactionId}`) };
    if (event.type === 'tool_result') return { ...event, timeline: this.position(`result:${event.result.toolCallId}`) };
    return event;
  }
}

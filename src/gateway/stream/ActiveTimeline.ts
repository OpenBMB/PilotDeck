import type { GatewayEvent } from '../protocol/types.js';

/** Absolute active-turn projection. It is not a capped delta replay log. */
export class ActiveTimeline {
  private blocks = new Map<string, GatewayEvent>();

  record(event: GatewayEvent): boolean {
    const child = event.type === 'agent_status' ? event.detail?.subagentId : undefined;
    const ending = event.type === 'assistant_stream_end'
      || (event.type === 'agent_status' && event.event === 'subagent_stream_end');
    if (ending || event.timeline) {
      for (const [id, previous] of this.blocks) {
        const previousChild = previous.type === 'agent_status' ? previous.detail?.subagentId : undefined;
        if (previousChild === child && previous.streamState === 'open' &&
            ((ending && (!event.streamBoundary || (previous.timeline?.turnId === event.streamBoundary.turnId && previous.timeline.order <= event.streamBoundary.through))) || (event.timeline && previous.timeline && event.timeline.order > previous.timeline.order))) {
          this.blocks.set(id, { ...previous, streamState: 'closed' });
        }
      }
    }
    if (!event.timeline) return ending;
    const id = `${event.timeline.turnId}:${event.timeline.id}`;
    const previous = this.blocks.get(id);
    const timeline = { ...event.timeline, offset: undefined };
    if (event.type === 'assistant_text_delta' || event.type === 'assistant_thinking_delta') {
      const prefix = previous && 'text' in previous && typeof previous.text === 'string' ? previous.text : '';
      this.blocks.set(id, { ...event, text: prefix + event.text, timeline, streamState: 'open' });
    } else if (event.type === 'agent_status' &&
      (event.event === 'subagent_text_delta' || event.event === 'subagent_thinking_delta')) {
      const prefix = previous?.type === 'agent_status' ? String(previous.detail?.text ?? '') : '';
      this.blocks.set(id, { ...event, timeline, streamState: 'open',
        detail: { ...event.detail, text: prefix + String(event.detail?.text ?? '') } });
    } else this.blocks.set(id, event);
    return true;
  }

  values(): GatewayEvent[] { return [...this.blocks.values()]; }
}

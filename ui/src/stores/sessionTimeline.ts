import type { NormalizedMessage } from './useSessionStore';

export type TimelinePosition = {
  version: 1;
  turnId: string;
  id: string;
  previousId?: string;
  order: number;
  revision: number;
  offset?: number;
};

export function isTimelineMessage(message: NormalizedMessage): boolean {
  const p = message.timeline;
  return p?.version === 1 && Boolean(p.id) && Number.isInteger(p.order)
    && Number.isInteger(p.revision) && Boolean(message.turnId || message.runId);
}
const turn = (message: NormalizedMessage) => message.timeline?.turnId || message.turnId || message.runId || '';
// On a parent Agent card, subagentId is a link, not message ownership.
const detailAgent = (message: NormalizedMessage) => message.isSubagentDetail ? message.subagentId : undefined;
const scope = (message: NormalizedMessage) => `${turn(message)}:${detailAgent(message) || ''}`;
const key = (message: NormalizedMessage) => `${message.timeline!.turnId}:${message.timeline!.id}`;
const isContent = (message: NormalizedMessage) => message.kind === 'thinking'
  || message.kind === 'stream_delta' || (message.kind === 'text' && message.role !== 'user');

/** Ordered, versioned content state. UI expansion/scrolling never enter this reducer. */
export class SessionTimeline {
  private rendered = new Map<string, { source: NormalizedMessage; closed: boolean; row: NormalizedMessage }>();
  private blocks = new Map<string, NormalizedMessage>();
  private missingPredecessors = new Map<string, NormalizedMessage>();
  private conflicts = new Set<string>();
  private pending = new Map<string, Map<number, NormalizedMessage>>();
  private closedThrough = new Map<string, number>();
  private removedTurns = new Set<string>();
  private removedBlocks = new Set<string>();
  private terminalTurns = new Set<string>();
  private terminalAgents = new Set<string>();

  private isTerminal(message: NormalizedMessage): boolean {
    const child = detailAgent(message);
    return this.terminalTurns.has(turn(message)) || this.terminalTurns.has(message.runId || '')
      || Boolean(child && (this.terminalAgents.has(JSON.stringify([message.runId, child]))
        || this.terminalAgents.has(JSON.stringify([undefined, child]))));
  }

  private clearGaps(matches: (message: NormalizedMessage) => boolean): void {
    for (const [id, message] of this.missingPredecessors) if (matches(message)) this.missingPredecessors.delete(id);
    for (const [id, frames] of this.pending) if ([...frames.values()].some(matches)) this.pending.delete(id);
    for (const id of this.conflicts) {
      const message = this.blocks.get(id);
      if (message && matches(message)) this.conflicts.delete(id);
    }
  }

  apply(message: NormalizedMessage): boolean {
    // HTTP baselines contain lifecycle frames as well as content. Completion
    // can arrive before the child's first restored block.
    if (message.kind === 'agent_activity' && message.phase === 'subagent' && message.subagentId
        && ['completed', 'failed', 'cancelled'].includes(message.state || '')) {
      this.close(message.parentRunId, true, message.subagentId);
    }
    if (!isTimelineMessage(message)) return false;
    const id = key(message);
    const p = message.timeline!;
    if (this.removedBlocks.has(id) || this.removedTurns.has(p.turnId) || this.removedTurns.has(message.runId || "")) return this.hasGap;
    // Restore absolute content after termination, but never resume its stream.
    if (this.isTerminal(message) && p.offset !== undefined) return this.hasGap;
    this.missingPredecessors.delete(id);
    if (p.offset !== undefined && p.previousId && !this.blocks.has(`${p.turnId}:${p.previousId}`)) {
      this.missingPredecessors.set(`${p.turnId}:${p.previousId}`, message);
    }
    // A new block closes earlier blocks, even if packets for them arrive late.
    const channel = scope(message);
    this.closedThrough.set(channel, Math.max(this.closedThrough.get(channel) ?? -1, p.order - 1));
    if (message.streamState === 'closed' || message.isFinal) {
      this.closedThrough.set(channel, Math.max(this.closedThrough.get(channel) ?? -1, p.order));
    }
    const existing = this.blocks.get(id);
    if (p.offset !== undefined && isContent(message)) {
      const length = existing?.content?.length ?? 0;
      if (existing?.isFinal) return this.hasGap;
      if (p.offset < length) {
        if ((existing?.content ?? '').slice(p.offset, p.offset + (message.content?.length ?? 0)) !== (message.content ?? '')) this.conflicts.add(id);
        return this.hasGap;
      }
      if (p.offset > length) {
        const queued = this.pending.get(id) ?? new Map();
        queued.set(p.offset, message);
        this.pending.set(id, queued);
        return true;
      }
      this.blocks.set(id, this.row({ ...existing, ...message, content: (existing?.content ?? '') + (message.content ?? '') }));
    } else {
      if (existing && existing.timeline!.revision > p.revision) return this.hasGap;
      // A finalized snapshot cannot be reopened by its older live baseline.
      if (existing?.isFinal && !message.isFinal) return this.hasGap;
      this.blocks.set(id, this.row({ ...existing, ...message }));
      this.conflicts.delete(id);
    }
    const queued = this.pending.get(id);
    if (queued) {
      for (const offset of [...queued.keys()].sort((a, b) => a - b)) {
        const length = this.blocks.get(id)?.content?.length ?? 0;
        if (offset > length) break;
        const delta = queued.get(offset)!;
        queued.delete(offset);
        if (!delta) continue;
        if (offset === length && !this.blocks.get(id)?.isFinal) this.apply(delta);
      }
      if (!queued.size || this.blocks.get(id)?.isFinal) this.pending.delete(id);
    }
    return this.hasGap;
  }

  get hasGap(): boolean { return this.pending.size > 0 || this.missingPredecessors.size > 0 || this.conflicts.size > 0; }

  close(runId?: string, terminal = false, subagentId?: string, boundary?: { turnId: string; through: number }): void {
    const matches = (message: NormalizedMessage) =>
      (!runId || turn(message) === runId || message.runId === runId)
      && (subagentId !== undefined ? detailAgent(message) === subagentId : terminal || !detailAgent(message))
      && (!boundary || turn(message) === boundary.turnId);
    if (terminal) {
      if (subagentId) this.terminalAgents.add(JSON.stringify([runId, subagentId]));
      this.clearGaps(matches);
    }
    for (const message of this.blocks.values()) {
      if (!matches(message)) continue;
      const channel = scope(message);
      this.closedThrough.set(channel, Math.max(this.closedThrough.get(channel) ?? -1, boundary?.through ?? message.timeline!.order));
      if (terminal) this.terminalTurns.add(turn(message));
    }
    if (terminal && runId && subagentId === undefined) this.terminalTurns.add(runId);
  }

  removeTurn(runId: string): void {
    this.removedTurns.add(runId);
    this.clearGaps(message => turn(message) === runId || message.runId === runId);
    for (const [id, message] of this.blocks) if (turn(message) === runId || message.runId === runId) {
      this.blocks.delete(id);
      this.rendered.delete(id);
      this.pending.delete(id);
      this.conflicts.delete(id);
    }
    this.terminalTurns.add(runId);
  }

  /** A complete history replaces previously confirmed entities. Live-only
   * blocks are retained unless their previously confirmed user turn was removed.
   * A page of history cannot prove that an absent entity was deleted.
   */
  reconcileHistory(previous: NormalizedMessage[], next: NormalizedMessage[]): Set<string> {
    const nextKeys = new Set(next.filter(isTimelineMessage).map(key));
    const nextTurns = new Set(next.map(turn));
    const removed = new Set<string>();
    for (const message of previous) {
      const runId = turn(message);
      if (message.kind === 'text' && message.role === 'user' && !message.isSteer
          && runId && !nextTurns.has(runId)) removed.add(runId);
      if (!isTimelineMessage(message) || nextKeys.has(key(message))) continue;
      const id = key(message);
      this.removedBlocks.add(id);
      this.blocks.delete(id);
      this.rendered.delete(id);
      this.pending.delete(id);
      this.conflicts.delete(id);
      this.missingPredecessors.delete(id);
    }
    for (const runId of removed) this.removeTurn(runId);
    return removed;
  }

  values(subagentId?: string | null): NormalizedMessage[] {
    return [...this.blocks.values()].filter(m => subagentId === null || detailAgent(m) === subagentId).map(message => {
      const closed = message.isFinal || this.isTerminal(message)
        || message.timeline!.order <= (this.closedThrough.get(scope(message)) ?? -1);
      if (!isContent(message)) return message;
      const id = key(message);
      const cached = this.rendered.get(id);
      if (cached?.source === message && cached.closed === Boolean(closed)) return cached.row;
      const row: NormalizedMessage = { ...message,
        kind: message.kind === 'stream_delta' && closed ? 'text' : message.kind,
        streamState: closed ? 'closed' : 'open',
      };
      this.rendered.set(id, { source: message, closed: Boolean(closed), row });
      return row;
    });
  }

  private row(message: NormalizedMessage): NormalizedMessage {
    const id = key(message);
    return { ...message, id, renderKey: id, turnId: message.timeline!.turnId, timeline: { ...message.timeline!, offset: undefined } };
  }
}

/** Turn identity locates a transcript section; protocol order locates its blocks.
 * Legacy content is supplied by the compatibility reducer, never text-matched here.
 */
export function mergeTimeline(legacy: NormalizedMessage[], rows: NormalizedMessage[]): NormalizedMessage[] {
  if (!rows.length) return legacy;
  const groups = new Map<string, NormalizedMessage[]>();
  for (const row of rows) {
    const items = groups.get(turn(row)) ?? [];
    items.push(row);
    groups.set(turn(row), items);
  }
  for (const items of groups.values()) items.sort((a, b) => a.timeline!.order - b.timeline!.order);
  const output: NormalizedMessage[] = [];
  const emitted = new Set<string>();
  for (let index = 0; index < legacy.length; index++) {
    const message = legacy[index];
    const runId = turn(message);
    const group = groups.get(runId);
    // Initial user input precedes the turn's protocol. Status/terminal rows
    // cannot become insertion anchors ahead of user input.
    const initialUser = message.kind === 'text' && message.role === 'user' && !message.isSteer;
    if (group && !emitted.has(runId) && !initialUser && !legacy.slice(index + 1).some(m =>
      turn(m) === runId && m.kind === 'text' && m.role === 'user' && !m.isSteer)) {
      output.push(...group);
      emitted.add(runId);
    }
    output.push(message);
    if (group && initialUser && !emitted.has(runId)) {
      output.push(...group);
      emitted.add(runId);
    }
  }
  for (const [runId, group] of groups) if (!emitted.has(runId)) output.push(...group);
  return output;
}

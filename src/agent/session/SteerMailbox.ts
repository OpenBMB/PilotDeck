import type { CanonicalMessage } from "../../model/index.js";

export type AgentSteerMessage = {
  itemId: string;
  message: CanonicalMessage;
  allowedReadFiles?: string[];
};

export type AgentSteerResult = {
  accepted: boolean;
  reason?: "no_active_turn" | "turn_mismatch" | "turn_closing" | "cancelled";
};

export type AgentCancelSteerResult = {
  cancelled: boolean;
  reason?: "no_active_turn" | "turn_mismatch" | "too_late";
};

/**
 * Turn-scoped inbox for user guidance submitted while an agent is running.
 *
 * `drainOrClose` is deliberately synchronous: JavaScript cannot interleave an
 * enqueue between observing an empty inbox and closing it, which removes the
 * terminal-turn race where accepted guidance could otherwise be lost.
 */
export class SteerMailbox {
  private turnId: string | undefined;
  private open = false;
  private readonly pending: AgentSteerMessage[] = [];
  private readonly seenItemIds = new Set<string>();
  private readonly cancelledItemIds = new Set<string>();

  start(turnId: string): void {
    this.turnId = turnId;
    this.open = true;
    this.pending.splice(0);
    this.seenItemIds.clear();
    this.cancelledItemIds.clear();
  }

  enqueue(turnId: string, input: AgentSteerMessage): AgentSteerResult {
    if (!this.turnId) return { accepted: false, reason: "no_active_turn" };
    if (this.turnId !== turnId) return { accepted: false, reason: "turn_mismatch" };
    if (!this.open) return { accepted: false, reason: "turn_closing" };
    if (this.cancelledItemIds.has(input.itemId)) return { accepted: false, reason: "cancelled" };
    if (this.seenItemIds.has(input.itemId)) return { accepted: true };
    this.seenItemIds.add(input.itemId);
    this.pending.push(input);
    return { accepted: true };
  }

  /**
   * Retract guidance until the loop drains it at a model-call boundary.
   *
   * An unseen item is tombstoned as cancelled so a concurrent `enqueue`
   * request cannot resurrect guidance after the UI has reported a successful
   * deletion.
   */
  cancel(turnId: string, itemId: string): AgentCancelSteerResult {
    if (!this.turnId) return { cancelled: false, reason: "no_active_turn" };
    if (this.turnId !== turnId) return { cancelled: false, reason: "turn_mismatch" };
    if (this.cancelledItemIds.has(itemId)) return { cancelled: true };

    const index = this.pending.findIndex((entry) => entry.itemId === itemId);
    if (index >= 0) {
      this.pending.splice(index, 1);
      this.cancelledItemIds.add(itemId);
      return { cancelled: true };
    }
    if (this.seenItemIds.has(itemId)) {
      return { cancelled: false, reason: "too_late" };
    }

    this.cancelledItemIds.add(itemId);
    return { cancelled: true };
  }

  drain(turnId: string): AgentSteerMessage[] {
    if (!this.open || this.turnId !== turnId) return [];
    return this.pending.splice(0);
  }

  drainOrClose(turnId: string): { messages: AgentSteerMessage[]; closed: boolean } {
    if (!this.open || this.turnId !== turnId) return { messages: [], closed: true };
    if (this.pending.length > 0) {
      return { messages: this.pending.splice(0), closed: false };
    }
    this.open = false;
    return { messages: [], closed: true };
  }

  /**
   * Close a terminal turn and return guidance that never reached a model
   * boundary. The turn identity remains until `finish` so late submissions are
   * rejected as `turn_closing` instead of appearing to target no turn at all.
   */
  close(turnId: string): AgentSteerMessage[] {
    if (this.turnId !== turnId) return [];
    this.open = false;
    return this.pending.splice(0);
  }

  finish(turnId: string): AgentSteerMessage[] {
    if (this.turnId !== turnId) return [];
    this.open = false;
    this.turnId = undefined;
    const remaining = this.pending.splice(0);
    this.seenItemIds.clear();
    this.cancelledItemIds.clear();
    return remaining;
  }
}

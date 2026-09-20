import type { CanonicalMessage } from "../../../model/index.js";
import { parseAgentLoopSeedStateProjection, serializeAgentLoopSeedStateProjection } from "../checkpoint/seedStateProjection.js";
import type { AgentTranscriptEntry } from "../../../session/transcript/TranscriptEntry.js";
import type { AgentTranscriptWriter } from "../../../session/transcript/TranscriptWriter.js";
import type {
  AgentLoopOperationAccepted,
  AgentLoopOperationIdentity,
  AgentLoopOperationKnownTerminal,
  AgentLoopOperationLedger,
  AgentLoopOperationRecovery,
  AgentLoopOperationResolution,
  AgentLoopOperationUnknownTerminal,
} from "./operationLedger.js";

export type SessionAgentLoopOperationLedgerOptions = {
  sessionId: string;
  transcript: AgentTranscriptWriter;
  restoredEntries?: readonly AgentTranscriptEntry[];
};

type LedgerRecord = {
  identity: AgentLoopOperationIdentity;
  streamId?: string;
  lastAppliedSequence?: number;
  terminal?: AgentLoopOperationKnownTerminal | AgentLoopOperationUnknownTerminal;
};

/**
 * Session-owned durable operation ledger for sidecar attempts. It is a
 * provider for the transport capability, not a second Session or operation
 * state machine: all writes remain regular events in the current transcript.
 */
export class SessionAgentLoopOperationLedger implements AgentLoopOperationLedger {
  private readonly records = new Map<string, LedgerRecord>();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: SessionAgentLoopOperationLedgerOptions) {
    for (const entry of options.restoredEntries ?? []) this.restore(entry);
  }

  recover(input: AgentLoopOperationIdentity): AgentLoopOperationRecovery | undefined {
    this.assertSession(input);
    const record = this.records.get(input.operationId);
    if (!record || !sameDurableOperation(record.identity, input)) return undefined;
    if (!record.terminal) return { state: "incomplete" };
    if (isKnownTerminal(record.terminal)) {
      return { state: "terminal", resolution: resolutionFromTerminal(record.terminal) };
    }
    return { state: "result_unknown", unknown: cloneUnknownTerminal(record.terminal) };
  }

  start(input: AgentLoopOperationIdentity): Promise<void> {
    return this.enqueue(async () => {
      this.assertSession(input);
      const existing = this.records.get(input.operationId);
      if (existing) {
        if (!sameIdentity(existing.identity, input)) {
          throw new Error(`AgentLoop operation ${input.operationId} conflicts with its durable identity.`);
        }
        return;
      }
      await this.options.transcript.recordSessionEvent(input.sessionId, input.turnId, {
        type: "agent_loop_operation_started",
        runId: input.runId,
        operationId: input.operationId,
        requestId: input.requestId,
        binding: cloneBinding(input.binding),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      });
      this.records.set(input.operationId, { identity: cloneIdentity(input) });
    });
  }

  accept(input: AgentLoopOperationAccepted): Promise<void> {
    return this.enqueue(async () => {
      this.assertSession(input);
      const record = this.requireActive(input);
      if (record.streamId) {
        if (record.streamId !== input.streamId) {
          throw new Error(`AgentLoop operation ${input.operationId} changed its stream identity.`);
        }
        return;
      }
      await this.options.transcript.recordSessionEvent(input.sessionId, input.turnId, {
        type: "agent_loop_operation_accepted",
        runId: input.runId,
        operationId: input.operationId,
        requestId: input.requestId,
        binding: cloneBinding(input.binding),
        streamId: input.streamId,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      });
      record.streamId = input.streamId;
    });
  }

  terminal(input: AgentLoopOperationKnownTerminal): Promise<void> {
    return this.enqueue(async () => {
      this.assertSession(input);
      validateKnownTerminal(input);
      const record = this.requireActive(input, input.streamId);
      if (record.terminal) {
        if (isKnownTerminal(record.terminal) && sameKnownTerminal(record.terminal, input)) return;
        if (isKnownTerminal(record.terminal)) {
          throw new Error(`AgentLoop operation ${input.operationId} already has a different durable terminal.`);
        }
      }
      await this.options.transcript.recordSessionEvent(input.sessionId, input.turnId, {
        type: "agent_loop_operation_terminal",
        runId: input.runId,
        operationId: input.operationId,
        requestId: input.requestId,
        binding: cloneBinding(input.binding),
        ...(input.streamId ? { streamId: input.streamId } : {}),
        lastAppliedSequence: input.lastAppliedSequence,
        outcome: input.outcome,
        result: structuredClone(input.result),
        messages: structuredClone(input.messages),
        ...(input.seedState
          ? { seedState: serializeAgentLoopSeedStateProjection(input.seedState) }
          : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.code ? { code: input.code } : {}),
        ...(input.error === undefined ? {} : { error: structuredClone(input.error) }),
      });
      record.streamId ??= input.streamId;
      record.lastAppliedSequence = input.lastAppliedSequence;
      record.terminal = cloneKnownTerminal(input);
    });
  }

  resultUnknown(input: AgentLoopOperationUnknownTerminal): Promise<void> {
    return this.enqueue(async () => {
      this.assertSession(input);
      const record = this.requireActive(input, input.streamId);
      if (record.terminal) {
        if (isKnownTerminal(record.terminal)) return;
        if (sameUnknownTerminal(record.terminal, input)) return;
        throw new Error(`AgentLoop operation ${input.operationId} already has a different unresolved terminal.`);
      }
      await this.options.transcript.recordSessionEvent(input.sessionId, input.turnId, {
        type: "agent_loop_operation_terminal",
        runId: input.runId,
        operationId: input.operationId,
        requestId: input.requestId,
        binding: cloneBinding(input.binding),
        streamId: input.streamId,
        lastAppliedSequence: input.lastAppliedSequence,
        outcome: "result_unknown",
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.code ? { code: input.code } : {}),
        ...(input.error === undefined ? {} : { error: structuredClone(input.error) }),
      });
      record.lastAppliedSequence = input.lastAppliedSequence;
      record.terminal = cloneUnknownTerminal(input);
    });
  }

  reconcile(input: AgentLoopOperationUnknownTerminal): AgentLoopOperationResolution | undefined {
    this.assertSession(input);
    const record = this.records.get(input.operationId);
    if (!record || !sameIdentity(record.identity, input) || record.streamId !== input.streamId) return undefined;
    if (!record.terminal || !isKnownTerminal(record.terminal)) return undefined;
    return resolutionFromTerminal(record.terminal);
  }

  private requireActive(
    input: AgentLoopOperationIdentity,
    streamId?: string,
  ): LedgerRecord {
    const record = this.records.get(input.operationId);
    if (!record || !sameIdentity(record.identity, input)) {
      throw new Error(`AgentLoop operation ${input.operationId} is not durably started.`);
    }
    if (streamId && record.streamId && record.streamId !== streamId) {
      throw new Error(`AgentLoop operation ${input.operationId} stream does not match its durable binding.`);
    }
    return record;
  }

  private assertSession(input: AgentLoopOperationIdentity): void {
    if (input.sessionId !== this.options.sessionId) {
      throw new Error("AgentLoop operation ledger cannot write another session.");
    }
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.writeTail.then(work);
    this.writeTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private restore(entry: AgentTranscriptEntry): void {
    if (entry.sessionId !== this.options.sessionId) return;
    if (entry.type === "agent_loop_operation_started") {
      const identity = entryIdentity(entry);
      const existing = this.records.get(identity.operationId);
      if (existing && !sameIdentity(existing.identity, identity)) {
        throw new Error(`Restored AgentLoop operation ${identity.operationId} has conflicting identity.`);
      }
      this.records.set(identity.operationId, existing ?? { identity });
      return;
    }
    if (entry.type === "agent_loop_operation_accepted") {
      const record = this.records.get(entry.operationId);
      const identity = entryIdentity(entry);
      if (!record || !sameIdentity(record.identity, identity)) {
        throw new Error(`Restored AgentLoop operation ${entry.operationId} was accepted before it started.`);
      }
      if (record.streamId && record.streamId !== entry.streamId) {
        throw new Error(`Restored AgentLoop operation ${entry.operationId} has conflicting stream ids.`);
      }
      record.streamId = entry.streamId;
      return;
    }
    if (entry.type !== "agent_loop_operation_terminal") return;
    const record = this.records.get(entry.operationId);
    const identity = entryIdentity(entry);
    if (!record || !sameIdentity(record.identity, identity)) {
      throw new Error(`Restored AgentLoop operation ${entry.operationId} terminated before it started.`);
    }
    if (entry.streamId && record.streamId && entry.streamId !== record.streamId) {
      throw new Error(`Restored AgentLoop operation ${entry.operationId} terminal has the wrong stream id.`);
    }
    const terminal = terminalFromEntry(entry);
    if (
      record.terminal
      && isKnownTerminal(record.terminal)
      && isKnownTerminal(terminal)
      && !sameKnownTerminal(record.terminal, terminal)
    ) {
      throw new Error(`Restored AgentLoop operation ${entry.operationId} has conflicting durable terminals.`);
    }
    record.streamId ??= entry.streamId;
    record.lastAppliedSequence = entry.lastAppliedSequence;
    record.terminal = terminal;
  }
}

function entryIdentity(entry: Extract<AgentTranscriptEntry, {
  type: "agent_loop_operation_started" | "agent_loop_operation_accepted" | "agent_loop_operation_terminal";
}>): AgentLoopOperationIdentity {
  return {
    runId: entry.runId,
    operationId: entry.operationId,
    requestId: entry.requestId,
    sessionId: entry.sessionId,
    turnId: entry.turnId,
    binding: cloneBinding(entry.binding),
    ...(entry.idempotencyKey ? { idempotencyKey: entry.idempotencyKey } : {}),
  };
}

function terminalFromEntry(
  entry: Extract<AgentTranscriptEntry, { type: "agent_loop_operation_terminal" }>,
): AgentLoopOperationKnownTerminal | AgentLoopOperationUnknownTerminal {
  const identity = entryIdentity(entry);
  if (entry.outcome === "result_unknown") {
    if (!entry.streamId) throw new Error(`Restored AgentLoop operation ${entry.operationId} result_unknown lacks a stream id.`);
    return {
      ...identity,
      streamId: entry.streamId,
      lastAppliedSequence: entry.lastAppliedSequence,
      ...(entry.code ? { code: entry.code } : {}),
      ...(entry.error === undefined ? {} : { error: structuredClone(entry.error) }),
    };
  }
  if (!entry.result || !entry.messages) {
    throw new Error(`Restored AgentLoop operation ${entry.operationId} terminal lacks a result projection.`);
  }
  return {
    ...identity,
    ...(entry.streamId ? { streamId: entry.streamId } : {}),
    lastAppliedSequence: entry.lastAppliedSequence,
    outcome: entry.outcome,
    result: structuredClone(entry.result),
    messages: structuredClone(entry.messages),
    ...(entry.seedState === undefined ? {} : { seedState: parseAgentLoopSeedStateProjection(entry.seedState) }),
    ...(entry.code ? { code: entry.code } : {}),
    ...(entry.error === undefined ? {} : { error: structuredClone(entry.error) }),
  };
}

function validateKnownTerminal(input: AgentLoopOperationKnownTerminal): void {
  if (!Number.isInteger(input.lastAppliedSequence) || input.lastAppliedSequence < -1) {
    throw new Error("AgentLoop operation terminal sequence is invalid.");
  }
  if (input.result.sessionId !== input.sessionId || input.result.turnId !== input.turnId) {
    throw new Error("AgentLoop operation terminal result does not match its session or turn.");
  }
  if (!Array.isArray(input.messages)) {
    throw new Error("AgentLoop operation terminal messages are invalid.");
  }
}

function sameIdentity(left: AgentLoopOperationIdentity, right: AgentLoopOperationIdentity): boolean {
  return left.runId === right.runId
    && left.operationId === right.operationId
    && left.requestId === right.requestId
    && left.sessionId === right.sessionId
    && left.turnId === right.turnId
    && left.idempotencyKey === right.idempotencyKey
    && left.binding.moduleInstanceId === right.binding.moduleInstanceId
    && left.binding.connectionGeneration === right.binding.connectionGeneration;
}

/** Request, stream, and module binding identify a single transport attempt. */
function sameDurableOperation(left: AgentLoopOperationIdentity, right: AgentLoopOperationIdentity): boolean {
  return left.runId === right.runId
    && left.operationId === right.operationId
    && left.sessionId === right.sessionId
    && left.turnId === right.turnId
    && left.idempotencyKey === right.idempotencyKey;
}

function resolutionFromTerminal(terminal: AgentLoopOperationKnownTerminal): AgentLoopOperationResolution {
  return {
    outcome: terminal.outcome,
    result: structuredClone(terminal.result),
    messages: structuredClone(terminal.messages),
    ...(terminal.seedState ? { seedState: cloneSeedState(terminal.seedState) } : {}),
  };
}

function sameKnownTerminal(left: AgentLoopOperationKnownTerminal, right: AgentLoopOperationKnownTerminal): boolean {
  return left.outcome === right.outcome
    && left.streamId === right.streamId
    && left.lastAppliedSequence === right.lastAppliedSequence
    && JSON.stringify(left.result) === JSON.stringify(right.result)
    && JSON.stringify(left.messages) === JSON.stringify(right.messages)
    && JSON.stringify(left.seedState ? serializeAgentLoopSeedStateProjection(left.seedState) : undefined)
      === JSON.stringify(right.seedState ? serializeAgentLoopSeedStateProjection(right.seedState) : undefined);
}

function sameUnknownTerminal(left: AgentLoopOperationUnknownTerminal, right: AgentLoopOperationUnknownTerminal): boolean {
  return left.streamId === right.streamId
    && left.lastAppliedSequence === right.lastAppliedSequence
    && left.code === right.code
    && JSON.stringify(left.error) === JSON.stringify(right.error);
}

function isKnownTerminal(
  value: AgentLoopOperationKnownTerminal | AgentLoopOperationUnknownTerminal,
): value is AgentLoopOperationKnownTerminal {
  return "outcome" in value;
}

function cloneIdentity(input: AgentLoopOperationIdentity): AgentLoopOperationIdentity {
  return {
    ...input,
    binding: cloneBinding(input.binding),
  };
}

function cloneBinding(binding: AgentLoopOperationIdentity["binding"]): AgentLoopOperationIdentity["binding"] {
  return {
    moduleInstanceId: binding.moduleInstanceId,
    connectionGeneration: binding.connectionGeneration,
  };
}

function cloneKnownTerminal(input: AgentLoopOperationKnownTerminal): AgentLoopOperationKnownTerminal {
  return {
    ...cloneIdentity(input),
    ...(input.streamId ? { streamId: input.streamId } : {}),
    lastAppliedSequence: input.lastAppliedSequence,
    outcome: input.outcome,
    result: structuredClone(input.result),
    messages: structuredClone(input.messages),
    ...(input.seedState ? { seedState: cloneSeedState(input.seedState) } : {}),
    ...(input.code ? { code: input.code } : {}),
    ...(input.error === undefined ? {} : { error: structuredClone(input.error) }),
  };
}

function cloneUnknownTerminal(input: AgentLoopOperationUnknownTerminal): AgentLoopOperationUnknownTerminal {
  return {
    ...cloneIdentity(input),
    streamId: input.streamId,
    lastAppliedSequence: input.lastAppliedSequence,
    ...(input.code ? { code: input.code } : {}),
    ...(input.error === undefined ? {} : { error: structuredClone(input.error) }),
  };
}

function cloneSeedState(seedState: NonNullable<AgentLoopOperationKnownTerminal["seedState"]>) {
  const projection = serializeAgentLoopSeedStateProjection(seedState);
  return parseAgentLoopSeedStateProjection(projection)!;
}

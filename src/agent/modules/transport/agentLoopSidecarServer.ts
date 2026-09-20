import { createInterface } from "node:readline";
import type { Writable, Readable } from "node:stream";
import {
  serializeAgentLoopModelSessionStateProjection,
  type AgentLoop,
  type AgentLoopInput,
} from "../../loop/AgentLoop.js";
import { serializeAgentLoopSeedStateProjection } from "../checkpoint/seedStateProjection.js";
import type { SidecarModuleCall, SidecarModuleCallClient } from "./sidecarPorts.js";
import { ModuleOperationHost } from "./moduleRuntime.js";
import { SidecarStreamReplayStore } from "./streamReplayStore.js";
import {
  MODULE_PROTOCOL_VERSION,
  type ModuleBinding,
  type ModuleCallRequest,
  type ModuleCapabilities,
  type ModuleEvent,
  type ModuleExecuteRequest,
  type ModuleMessage,
  type ModuleResponse,
  type ModuleOutcome,
  validateModuleMessage,
} from "../protocol.js";

export type SidecarExecution = {
  loop: AgentLoop;
  input: AgentLoopInput;
  /** Optional sidecar-owned volatile work that must settle before final. */
  flush?: () => Promise<void>;
};

export type SidecarExecutionFactory = (input: {
  request: ModuleExecuteRequest;
  abortSignal: AbortSignal;
  abortExecution?: (reason?: unknown) => void;
  callModule: SidecarModuleCallClient;
}) => Promise<SidecarExecution> | SidecarExecution;

export type AgentLoopSidecarOptions = {
  moduleId?: string;
  moduleInstanceId?: string;
  capabilities?: ModuleCapabilities;
  /** Optional process-local replay provider for a reconnectable transport. */
  replayStore?: SidecarStreamReplayStore;
  uuid?: () => string;
};

type ActiveSidecarExecution = {
  runId: string;
  requestId: string;
  controller: AbortController;
  deadlineExceeded: boolean;
};

type SidecarConnection = {
  binding: ModuleBinding;
  output: Writable;
  writeChain: Promise<void>;
  closed: boolean;
};

type PendingModuleCall = {
  streamId: string;
  /** Immutable request retained only while this sidecar process is alive. */
  request: ModuleCallRequest;
  resolve: (response: ModuleResponse) => void;
  reject: (error: unknown) => void;
};

/**
 * JSON-lines server for a host-owned AgentLoop.
 *
 * The server intentionally has no process, HTTP, or provider knowledge. A host
 * supplies an execution factory and handles model/capability calls on the same
 * bidirectional stream.
 */
export class AgentLoopSidecarServer {
  readonly moduleId: string;
  readonly moduleInstanceId: string;
  readonly connectionGeneration: string;
  private readonly uuid: () => string;
  private readonly pendingCalls = new Map<string, PendingModuleCall>();
  private readonly moduleFailures = new Map<string, { code?: string; message: string; retryability?: string }>();
  private readonly abortControllers = new Map<string, ActiveSidecarExecution>();
  private readonly operations = new ModuleOperationHost();
  private readonly requestOperations = new Map<string, string>();
  private readonly activeExecutions = new Set<Promise<void>>();
  private readonly replayStore: SidecarStreamReplayStore;
  private readonly streamConnections = new Map<string, SidecarConnection>();
  private readonly streamDeliveryChains = new Map<string, Promise<void>>();

  constructor(
    private readonly factory: SidecarExecutionFactory,
    private readonly options: AgentLoopSidecarOptions = {},
  ) {
    this.uuid = options.uuid ?? (() => Math.random().toString(36).slice(2));
    this.moduleId = options.moduleId ?? "pilotdeck-agent-loop";
    // A stream can resume only inside the same sidecar process. The default
    // identity must therefore change for every server instance, while an
    // explicit deployment identity remains available for controlled hosts.
    this.moduleInstanceId = options.moduleInstanceId ?? `${this.moduleId}-instance-${this.uuid()}`;
    this.connectionGeneration = `${this.moduleInstanceId}-${this.uuid()}`;
    this.replayStore = options.replayStore ?? new SidecarStreamReplayStore();
  }

  async serve(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
    const connection = this.openConnection(output);
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          await this.send(connection, {
            kind: "error",
            messageId: this.nextId("parse"),
            code: "INVALID_JSON",
            message: "Module message is not valid JSON.",
            retryability: "unsafe",
          });
          continue;
        }
        const validation = validateModuleMessage(value);
        if (!validation.ok) {
          await this.send(connection, {
            kind: "error",
            messageId: this.nextId("validation"),
            code: validation.code,
            message: validation.message,
            retryability: "unsafe",
          });
          continue;
        }
        const message = value as ModuleMessage;
        if (message.kind === "response") {
          const pending = this.pendingCalls.get(message.inReplyTo);
          if (pending && this.streamConnections.get(pending.streamId) === connection) {
            this.pendingCalls.delete(message.inReplyTo);
            pending.resolve(message);
          }
          continue;
        }
        if (message.kind !== "request") continue;
        if (message.method === "hello") {
          await this.send(connection, this.handshake(connection, message.messageId, "hello"));
        } else if (message.method === "capabilities") {
          await this.send(connection, {
            ...this.handshake(connection, message.messageId, "capabilities"),
            payload: this.capabilities(),
          });
        } else if (message.method === "execute") {
          const execution = this.handleExecute(message, connection);
          this.activeExecutions.add(execution);
          void execution.finally(() => this.activeExecutions.delete(execution));
        } else if (message.method === "module_call") {
          // module_call is sidecar-originated; receiving one is a protocol error.
          await this.send(connection, {
            kind: "response",
            messageId: this.nextId("module-call"),
            inReplyTo: message.messageId,
            requestId: message.requestId,
            ok: false,
            final: true,
            outcome: "failed",
            code: "UNEXPECTED_MODULE_CALL",
          });
        } else if (message.method === "cancel") {
          const active = this.abortControllers.get(message.operationId);
          const identityMatches = Boolean(
            active
              && active.runId === message.runId
              && (message.requestId === undefined || active.requestId === message.requestId),
          );
          if (identityMatches) {
            this.operations.requestCancel(message.operationId);
            if (message.reason === `timeout:${message.runId}`) {
              active!.deadlineExceeded = true;
            }
            active!.controller.abort(message.reason);
          }
          await this.send(connection, {
            kind: "response",
            messageId: this.nextId("cancel"),
            inReplyTo: message.messageId,
            requestId: message.requestId,
            ok: identityMatches,
            ...(identityMatches
              ? { payload: { operationId: message.operationId, cancelled: true } }
              : { code: active ? "OPERATION_IDENTITY_MISMATCH" : "UNKNOWN_OPERATION" }),
          });
        } else if (message.method === "status") {
          await this.send(connection, this.status(message));
        } else if (message.method === "resume") {
          await this.resume(connection, message);
        } else if (message.method === "ack") {
          await this.acknowledge(connection, message);
        }
      }
    } finally {
      connection.closed = true;
      this.detachConnection(connection);
    }
    await Promise.all([...this.activeExecutions]);
  }

  private async handleExecute(request: ModuleExecuteRequest, connection: SidecarConnection): Promise<void> {
    const active = this.abortControllers.get(request.operationId);
    if (active) {
      await this.send(connection, {
        kind: "response",
        messageId: this.nextId("execute-rejected"),
        inReplyTo: request.messageId,
        requestId: request.requestId,
        ok: false,
        code: active.runId === request.runId ? "OPERATION_ALREADY_ACTIVE" : "OPERATION_IDENTITY_MISMATCH",
      });
      return;
    }
    this.operations.accept(request);
    this.requestOperations.set(request.requestId, request.operationId);
    const deadlineAt = earliestDeadline(request.operationDeadline, request.attemptDeadline);
    if (deadlineAt !== undefined && deadlineAt <= Date.now()) {
      this.operations.expire(request.operationId, request.requestId);
      await this.send(connection, {
        kind: "response",
        messageId: this.nextId("deadline"),
        inReplyTo: request.messageId,
        requestId: request.requestId,
        ok: false,
        final: true,
        outcome: "failed",
        code: "DEADLINE_EXCEEDED",
      });
      return;
    }
    const controller = new AbortController();
    const activeExecution: ActiveSidecarExecution = {
      runId: request.runId,
      requestId: request.requestId,
      controller,
      deadlineExceeded: false,
    };
    this.abortControllers.set(request.operationId, activeExecution);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (deadlineAt !== undefined) {
      const abortForDeadline = () => {
        activeExecution.deadlineExceeded = true;
        controller.abort({ code: "DEADLINE_EXCEEDED", message: "Module execution deadline exceeded." });
      };
      if (deadlineAt <= Date.now()) abortForDeadline();
      else deadlineTimer = setTimeout(abortForDeadline, Math.min(2_147_483_647, deadlineAt - Date.now()));
    }
    const streamId = this.nextId("stream");
    this.replayStore.start(streamId, connection.binding);
    this.streamConnections.set(streamId, connection);
    this.streamDeliveryChains.set(streamId, Promise.resolve());
    await this.send(connection, {
      kind: "response",
      messageId: this.nextId("accepted"),
      inReplyTo: request.messageId,
      requestId: request.requestId,
      ok: true,
      streamId,
      cursor: 0,
    });
    let sequence = 0;
    let finalSent = false;
    try {
      const execution = await this.factory({
        request,
          abortSignal: controller.signal,
          abortExecution: (reason?: unknown) => controller.abort(reason),
          callModule: (call) => this.callModule(streamId, call, controller.signal),
      });
      const iterator = execution.loop.run(execution.input);
      let next = await iterator.next();
      while (!next.done) {
        const event = next.value;
        await this.publishStreamEvent(streamId, {
          kind: "event",
          messageId: this.nextId("event"),
          eventType: `agent.${event.type}`,
          streamId,
          sequence: sequence++,
          runId: request.runId,
          operationId: request.operationId,
          requestId: request.requestId,
          final: false,
          payload: event as unknown as Record<string, unknown>,
        });
        next = await iterator.next();
      }
      const result = next.value;
      await execution.flush?.();
      if (activeExecution.deadlineExceeded) {
        await this.sendDeadlineUnknown(request, streamId, sequence++);
        finalSent = true;
        return;
      }
      const outcome = moduleOutcomeFromAgentResult(result.result);
      const moduleFailure = this.moduleFailures.get(request.operationId);
      // Preserve a host module's structured failure as diagnostic terminal
      // payload. The AgentLoop result remains the terminal classification;
      // host-owned adapters may use this source detail for their own mapping.
      const terminalModuleFailure = result.result.type === "error" ? moduleFailure : undefined;
      const terminalError = activeExecution.deadlineExceeded
        ? { code: "DEADLINE_EXCEEDED", message: "Module execution deadline exceeded." }
        : result.result.type === "max_turns"
          ? result.result.errors?.[0] ?? {
              code: "agent_max_turns_reached",
              message: "AgentLoop maximum turn limit reached.",
            }
          : result.result.type === "error"
            ? result.result.errors?.[0] ?? moduleFailure
            : undefined;
      this.operations.recordFinal(request.operationId, request.requestId, outcome);
      await this.publishStreamEvent(streamId, {
        kind: "event",
        messageId: this.nextId("final"),
        eventType: `agent.execute.${outcome}`,
        streamId,
        sequence: sequence++,
        runId: request.runId,
        operationId: request.operationId,
        requestId: request.requestId,
        final: true,
        outcome,
        ...(terminalError
          ? {
              ...(typeof terminalError.code === "string" ? { code: terminalError.code } : {}),
              error: terminalError,
            }
          : {}),
        payload: {
          result: result.result,
          messages: result.messages,
          ...(terminalModuleFailure ? { moduleFailure: terminalModuleFailure } : {}),
          // Test/integration runners may implement only the public run surface.
          // Seed state is an optional checkpoint projection, never a reason to
          // rewrite an otherwise valid execution terminal as failed.
          ...snapshotVolatileState(execution.loop),
        },
      });
      finalSent = true;
    } catch (error) {
      if (activeExecution.deadlineExceeded) {
        await this.sendDeadlineUnknown(request, streamId, sequence++);
        finalSent = true;
        return;
      }
      const outcome = controller.signal.aborted ? "cancelled" : "failed";
      const serialized = serializeExecutionError(error);
      this.operations.recordFinal(request.operationId, request.requestId, outcome);
      await this.publishStreamEvent(streamId, {
        kind: "event",
        messageId: this.nextId("failed"),
        eventType: `agent.execute.${outcome}`,
        streamId,
        sequence: sequence++,
        runId: request.runId,
        operationId: request.operationId,
        requestId: request.requestId,
        final: true,
        outcome,
        ...(typeof serialized.code === "string" ? { code: serialized.code } : {}),
        error: serialized,
        payload: { error: serialized },
      });
      finalSent = true;
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (!finalSent) {
        this.operations.recordFinal(request.operationId, request.requestId, "result_unknown");
        await this.publishStreamEvent(streamId, {
          kind: "event",
          messageId: this.nextId("unknown"),
          eventType: "agent.execute.unknown",
          streamId,
          sequence: sequence++,
          runId: request.runId,
          operationId: request.operationId,
          requestId: request.requestId,
          final: true,
          outcome: "result_unknown",
          payload: {},
        });
      }
      if (this.abortControllers.get(request.operationId)?.controller === controller) {
        this.abortControllers.delete(request.operationId);
        this.moduleFailures.delete(request.operationId);
      }
    }
  }

  private sendDeadlineUnknown(
    request: ModuleExecuteRequest,
    streamId: string,
    sequence: number,
  ): Promise<void> {
    const error = { code: "DEADLINE_EXCEEDED", message: "Module execution deadline exceeded." };
    this.operations.recordFinal(request.operationId, request.requestId, "result_unknown");
    return this.publishStreamEvent(streamId, {
      kind: "event",
      messageId: this.nextId("deadline-unknown"),
      eventType: "agent.execute.result_unknown",
      streamId,
      sequence,
      runId: request.runId,
      operationId: request.operationId,
      requestId: request.requestId,
      final: true,
      outcome: "result_unknown",
      code: error.code,
      error,
      payload: {},
    });
  }

  private async callModule(streamId: string, call: SidecarModuleCall, abortSignal?: AbortSignal): Promise<ModuleResponse> {
    const messageId = this.nextId("module-call");
    const { recordFailure = true, ...wireCall } = call;
    const request: ModuleCallRequest = {
      kind: "request",
      messageId,
      method: "module_call",
      ...wireCall,
    };
    const response = new Promise<ModuleResponse>((resolve, reject) => {
      const entry = { streamId, request, resolve, reject };
      this.pendingCalls.set(messageId, entry);
      if (abortSignal?.aborted) {
        this.pendingCalls.delete(messageId);
        reject(new SidecarAbortError());
      } else {
        abortSignal?.addEventListener("abort", () => {
          if (this.pendingCalls.delete(messageId)) reject(new SidecarAbortError());
        }, { once: true });
      }
    });
    try {
      await this.sendForStream(streamId, request);
    } catch {
      // Keep the request pending. A reconnectable transport can rebind the
      // stream and receive this exact request again; failing the loop here
      // would turn an otherwise recoverable host reply into a second terminal.
    }
    const result = await response;
    if (recordFailure && call.operationId) {
      if (!result.ok) {
        this.moduleFailures.set(call.operationId, {
          ...(result.code ? { code: result.code } : {}),
          message: String(result.error?.message ?? result.code ?? "Module call failed."),
        });
      } else {
        // A later successful attempt recovers a previous provider failure in
        // the same operation. Do not leak the stale failure into the final
        // AgentLoop outcome after a prepared-request retry succeeds.
        this.moduleFailures.delete(call.operationId);
      }
    }
    return result;
  }

  private handshake(
    connection: SidecarConnection,
    inReplyTo: string,
    method: "hello" | "capabilities",
  ): ModuleResponse {
    return {
      kind: "response",
      messageId: this.nextId(method),
      inReplyTo,
      ok: true,
      protocolVersion: MODULE_PROTOCOL_VERSION,
      moduleId: this.moduleId,
      moduleInstanceId: this.moduleInstanceId,
      connectionGeneration: connection.binding.connectionGeneration,
      capabilitiesVersion: this.capabilities().capabilitiesVersion,
      payload: {},
    };
  }

  private status(request: Extract<ModuleMessage, { kind: "request"; method: "status" }>): ModuleResponse {
    const operationId = this.requestOperations.get(request.requestId);
    const snapshot = operationId ? this.operations.status(operationId) : undefined;
    return {
      kind: "response",
      messageId: this.nextId("status"),
      inReplyTo: request.messageId,
      requestId: request.requestId,
      ok: snapshot !== undefined,
      ...(snapshot
        ? { payload: snapshot as unknown as Record<string, unknown> }
        : { code: "UNKNOWN_REQUEST" }),
    };
  }

  private async resume(
    connection: SidecarConnection,
    request: Extract<ModuleMessage, { kind: "request"; method: "resume" }>,
  ): Promise<void> {
    if (!this.supportsStreamResume()) {
      await this.send(connection, controlFailure(request.messageId, "RESUME_UNSUPPORTED", this.nextId("resume")));
      return;
    }
    const replay = this.replayStore.resume(request);
    if (!replay.ok) {
      await this.send(connection, controlFailure(request.messageId, replay.code, this.nextId("resume")));
      return;
    }
    this.replayStore.rebind(request.streamId, connection.binding);
    this.streamConnections.set(request.streamId, connection);
    const pendingRequests = [...this.pendingCalls.values()]
      .filter((pending) => pending.streamId === request.streamId)
      .map((pending) => pending.request);
    await this.enqueueStreamDelivery(request.streamId, connection, [
      {
        kind: "response",
        messageId: this.nextId("resume"),
        inReplyTo: request.messageId,
        ok: true,
        streamId: request.streamId,
        replayedThroughSequence: replay.replayedThroughSequence,
      },
      ...replay.events,
      ...pendingRequests,
    ]);
  }

  private async acknowledge(
    connection: SidecarConnection,
    request: Extract<ModuleMessage, { kind: "request"; method: "ack" }>,
  ): Promise<void> {
    if (!this.supportsStreamResume()) {
      await this.send(connection, controlFailure(request.messageId, "ACK_UNSUPPORTED", this.nextId("ack")));
      return;
    }
    const acknowledged = this.replayStore.acknowledge(request);
    await this.send(connection, acknowledged.ok
      ? {
          kind: "response",
          messageId: this.nextId("ack"),
          inReplyTo: request.messageId,
          ok: true,
        }
      : controlFailure(request.messageId, acknowledged.code, this.nextId("ack")));
  }

  private async publishStreamEvent(streamId: string, event: ModuleEvent): Promise<void> {
    this.replayStore.append(event);
    const connection = this.streamConnections.get(streamId);
    if (!connection || connection.closed) return;
    try {
      await this.sendForStream(streamId, event);
    } catch {
      // The event remains in the live replay store. A reconnectable transport
      // may bind a new connection; no durable state is inferred here.
      if (this.streamConnections.get(streamId) === connection) this.streamConnections.delete(streamId);
    }
  }

  private async sendForStream(streamId: string, message: ModuleMessage): Promise<void> {
    const connection = this.streamConnections.get(streamId);
    if (!connection || connection.closed) throw new Error("Sidecar stream has no active transport connection.");
    await this.enqueueStreamDelivery(streamId, connection, [message]);
  }

  private async enqueueStreamDelivery(
    streamId: string,
    connection: SidecarConnection,
    messages: readonly ModuleMessage[],
  ): Promise<void> {
    const previous = this.streamDeliveryChains.get(streamId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      for (const message of messages) await this.send(connection, message);
    });
    this.streamDeliveryChains.set(streamId, next);
    try {
      await next;
    } finally {
      if (this.streamDeliveryChains.get(streamId) === next) {
        this.streamDeliveryChains.set(streamId, next.catch(() => undefined));
      }
    }
  }

  private detachConnection(connection: SidecarConnection): void {
    for (const [streamId, current] of this.streamConnections) {
      if (current === connection) this.streamConnections.delete(streamId);
    }
  }

  private openConnection(output: Writable): SidecarConnection {
    return {
      binding: {
        moduleInstanceId: this.moduleInstanceId,
        connectionGeneration: `${this.connectionGeneration}-${this.uuid()}`,
      },
      output,
      writeChain: Promise.resolve(),
      closed: false,
    };
  }

  private capabilities(): ModuleCapabilities {
    return this.options.capabilities ?? defaultCapabilities();
  }

  private supportsStreamResume(): boolean {
    const capabilities = this.capabilities();
    const execute = capabilities.methods.find((method) => method.name === "execute");
    return execute?.resumeSupport === "streaming"
      && capabilities.methods.some((method) => method.name === "resume" && method.enabled !== false)
      && capabilities.methods.some((method) => method.name === "ack" && method.enabled !== false);
  }

  private async send(connection: SidecarConnection, message: ModuleMessage | Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    connection.writeChain = connection.writeChain.then(() => writeSidecarLine(connection.output, line));
    return connection.writeChain;
  }

  private nextId(prefix: string): string {
    return `${prefix}-${this.uuid()}`;
  }
}

/**
 * A TCP peer can disappear after accepting a write into its local buffer but
 * before Node invokes the write callback. Treat `error` and `close` as the
 * same failed delivery so a live stream can be rebound and replayed instead
 * of leaving its execution suspended on the retired connection.
 */
function writeSidecarLine(output: Writable, line: string): Promise<void> {
  if (output.destroyed || output.writableEnded) {
    return Promise.reject(new Error("Sidecar transport output is already closed."));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      output.removeListener("error", onError);
      output.removeListener("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("Sidecar transport output closed while writing."));
    output.once("error", onError);
    output.once("close", onClose);
    try {
      output.write(line, (error) => finish(error));
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function snapshotVolatileState(loop: AgentLoop): Record<string, unknown> {
  const snapshot = (loop as Partial<Pick<AgentLoop, "snapshotFileState">>).snapshotFileState;
  const modelSnapshot = (loop as Partial<Pick<AgentLoop, "snapshotModelSessionState">>).snapshotModelSessionState;
  return {
    ...(typeof snapshot === "function"
    ? { seedState: serializeAgentLoopSeedStateProjection(snapshot.call(loop)) }
    : {}),
    ...(typeof modelSnapshot === "function"
      ? { modelState: serializeAgentLoopModelSessionStateProjection(modelSnapshot.call(loop)) }
      : {}),
  };
}

function earliestDeadline(...values: Array<string | undefined>): number | undefined {
  const deadlines = values
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter((value) => Number.isFinite(value));
  return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}

function serializeExecutionError(error: unknown): Record<string, unknown> {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return {
      ...(typeof record.code === "string" ? { code: record.code } : {}),
      message: typeof record.message === "string" ? record.message : String(error),
      ...(Array.isArray(record.errors) ? { errors: record.errors } : {}),
    };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

function controlFailure(inReplyTo: string, code: string, messageId: string): ModuleResponse {
  return {
    kind: "response",
    messageId,
    inReplyTo,
    ok: false,
    code,
  };
}

class SidecarAbortError extends Error {
  constructor() {
    super("Sidecar module call aborted.");
    this.name = "SidecarAbortError";
  }
}

function defaultCapabilities(): ModuleCapabilities {
  return {
    capabilitiesVersion: "1",
    methods: [
      { name: "execute", enabled: true, profiles: ["streaming"], cancel: true, resumeSupport: "none", retry: "retry_after_status" },
      { name: "cancel", enabled: true },
      { name: "status", enabled: true },
      { name: "resume", enabled: false },
      { name: "ack", enabled: false },
    ],
  };
}

export function moduleOutcomeFromAgentResult(result: { type: string }): ModuleOutcome {
  return result.type === "aborted" ? "cancelled" : result.type === "success" ? "completed" : "failed";
}

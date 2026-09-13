import { randomUUID } from "node:crypto";
import type {
  PilotDeckUserDialogChannel,
  PilotDeckUserConfirmationAnswer,
  PilotDeckUserConfirmationRequest,
  PilotDeckUserFormAnswer,
  PilotDeckUserFormRequest,
  PilotDeckUserInputAnswer,
  PilotDeckUserInputRequest,
  PilotDeckUserSelectAnswer,
  PilotDeckUserSelectRequest,
} from "../../tool/dialog/PilotDeckUserDialogChannel.js";
import { acceptsFormDialogAnswer } from "../../tool/dialog/FormDialogSchema.js";
import type { GatewayEvent, GatewayUserDialogRequestEvent } from "../protocol/types.js";
import type { GatewayUserDialogBus, GatewayUserDialogKind } from "./GatewayUserDialogBus.js";
import type { GatewayUserDialogJournal } from "./GatewayUserDialogJournal.js";
import type {
  GatewayStoredUserDialog,
  GatewayStoredUserDialogAnswer,
  GatewayUserDialogStore,
  GatewayUserDialogStoreKey,
} from "./GatewayUserDialogStore.js";

export type GatewayUserDialogChannelOptions = {
  sessionKey: string;
  bus: GatewayUserDialogBus;
  emit(event: GatewayEvent): void;
  /** Persistent sessions use this before exposing a request to the renderer. */
  journal?: GatewayUserDialogJournal;
  /** Optional host-owned durable store for cross-process renderer discovery. */
  store?: GatewayUserDialogStore;
  storeKey?: GatewayUserDialogStoreKey;
  /** Reads a host-accepted answer submitted by another Gateway renderer. */
  takeStoredAnswer?: (requestId: string) => GatewayStoredUserDialogAnswer | undefined | Promise<GatewayStoredUserDialogAnswer | undefined>;
  /** Optional liveness lease for the Gateway that owns this native tool promise. */
  claimStoredOwner?: (requestId: string, ownerId: string) => boolean | Promise<boolean>;
  renewStoredOwner?: (requestId: string, ownerId: string) => boolean | Promise<boolean>;
  releaseStoredOwner?: (requestId: string, ownerId: string) => boolean | Promise<boolean>;
  uuid?: () => string;
};

const LIVE_OWNER_RENEW_INTERVAL_MS = 100;

/**
 * Bridges an opt-in native tool request to a Gateway event/RPC round trip.
 * The bus owns request identity and completion; this adapter only projects
 * the tool request into the public Gateway protocol.
 */
export class GatewayUserDialogChannel implements PilotDeckUserDialogChannel {
  private readonly uuid: () => string;

  constructor(private readonly options: GatewayUserDialogChannelOptions) {
    this.uuid = options.uuid ?? randomUUID;
  }

  requestInput(request: PilotDeckUserInputRequest): Promise<PilotDeckUserInputAnswer> {
    return this.request("input", request, (value) => typeof value === "string", (requestId) => ({
        type: "user_dialog_request",
        requestId,
        dialogKind: "input",
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        prompt: request.prompt,
        ...(request.placeholder ? { placeholder: request.placeholder } : {}),
        ...(request.allowEmpty === true ? { allowEmpty: true } : {}),
      }));
  }

  requestSelect(request: PilotDeckUserSelectRequest): Promise<PilotDeckUserSelectAnswer> {
    const values = new Set(request.choices.map((choice) => choice.value));
    return this.request("select", request, (value) => typeof value === "string" && values.has(value), (requestId) => ({
      type: "user_dialog_request",
      requestId,
      dialogKind: "select",
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      prompt: request.prompt,
      choices: request.choices.map((choice) => ({ ...choice })),
      ...(request.defaultValue !== undefined ? { defaultValue: request.defaultValue } : {}),
    }));
  }

  requestConfirm(request: PilotDeckUserConfirmationRequest): Promise<PilotDeckUserConfirmationAnswer> {
    return this.request("confirm", request, (value) => typeof value === "boolean", (requestId) => ({
      type: "user_dialog_request",
      requestId,
      dialogKind: "confirm",
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      prompt: request.prompt,
      ...(request.confirmLabel !== undefined ? { confirmLabel: request.confirmLabel } : {}),
      ...(request.cancelLabel !== undefined ? { cancelLabel: request.cancelLabel } : {}),
      ...(request.defaultValue !== undefined ? { defaultValue: request.defaultValue } : {}),
    }));
  }

  requestForm(request: PilotDeckUserFormRequest): Promise<PilotDeckUserFormAnswer> {
    return this.request("form", request, (value) => acceptsFormDialogAnswer(request.schema, value), (requestId) => ({
      type: "user_dialog_request",
      requestId,
      dialogKind: "form",
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      prompt: request.prompt,
      schema: structuredClone(request.schema),
    }));
  }

  private request<Answer extends { type: "answered"; value: unknown } | { type: "cancelled"; reason?: string }>(
    dialogKind: GatewayUserDialogKind,
    request: { toolCallId: string; toolName: string; signal?: AbortSignal },
    accepts: (value: unknown) => boolean,
    event: (requestId: string) => GatewayUserDialogRequestEvent,
  ): Promise<Answer> {
    const requestId = this.uuid();
    const ownerId = this.uuid();
    const { bus, emit, sessionKey } = this.options;
    const requestEvent = event(requestId);
    return new Promise<Answer>((resolve, reject) => {
      let abortHandler: (() => void) | undefined;
      let registered = false;
      let cancelledBeforeRegistration = false;
      let settled = false;
      let polling = false;
      let ownerClaimed = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      const clearAbort = () => {
        if (abortHandler && request.signal) request.signal.removeEventListener("abort", abortHandler);
      };
      const stopPolling = () => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
      };
      const stored: GatewayStoredUserDialog = {
        request: structuredClone(requestEvent),
        createdAt: new Date().toISOString(),
      };
      const persist = async (): Promise<void> => {
        this.options.journal?.record(requestEvent);
        if (this.options.store && this.options.storeKey) {
          await this.options.store.put(this.options.storeKey, stored);
          if (this.options.claimStoredOwner) {
            ownerClaimed = await this.options.claimStoredOwner(requestId, ownerId);
            if (!ownerClaimed) {
              throw new Error(`Gateway user-dialog owner lease was unavailable for ${requestId}.`);
            }
          }
        }
      };
      const settle = async (): Promise<void> => {
        if (ownerClaimed) {
          ownerClaimed = false;
          await this.options.releaseStoredOwner?.(requestId, ownerId);
        }
        this.options.journal?.remove(requestId);
        if (this.options.store && this.options.storeKey) {
          await this.options.store.remove(this.options.storeKey, requestId);
        }
      };
      const cancel = (reason: string) => {
        if (!registered) {
          cancelledBeforeRegistration = true;
          if (!settled) {
            settled = true;
            clearAbort();
            resolve({ type: "cancelled", reason } as Answer);
          }
          return;
        }
        try {
          const pending = bus.consume(sessionKey, requestId, "cancelled");
          pending?.resolve({ type: "cancelled", reason });
          emit({ type: "user_dialog_cancelled", requestId, dialogKind, reason });
        } catch (error) {
          clearAbort();
          reject(error);
        }
      };
      if (request.signal) {
        abortHandler = () => cancel("aborted");
        request.signal.addEventListener("abort", abortHandler, { once: true });
      }
      void (async () => {
        try {
          await persist();
          if (cancelledBeforeRegistration || request.signal?.aborted) {
            await settle();
            if (!settled) {
              settled = true;
              clearAbort();
              resolve({ type: "cancelled", reason: "aborted" } as Answer);
            }
            return;
          }
          bus.register(sessionKey, {
            requestId,
            dialogKind,
            toolCallId: request.toolCallId,
            toolName: request.toolName,
            event: requestEvent,
            accepts,
            resolve: (answer) => {
              if (settled) return;
              settled = true;
              stopPolling();
              clearAbort();
              resolve(answer as Answer);
            },
            reject: (error) => {
              if (settled) return;
              settled = true;
              stopPolling();
              clearAbort();
              reject(error);
            },
            onSettled: () => {
              stopPolling();
              void settle().catch(() => {});
            },
          });
          registered = true;
          emit(requestEvent);
          if (this.options.takeStoredAnswer) {
            const poll = async () => {
              if (polling || settled || !registered) return;
              polling = true;
              try {
                if (ownerClaimed && this.options.renewStoredOwner) {
                  const renewed = await this.options.renewStoredOwner(requestId, ownerId);
                  if (!renewed) return;
                }
                const answer = await this.options.takeStoredAnswer!(requestId);
                if (!answer || settled) return;
                const pending = bus.consume(sessionKey, requestId, "cross_gateway_answer");
                if (!pending) return;
                if (answer.result.behavior === "answered" && !accepts(answer.result.value)) {
                  pending.reject(new Error(`Cross-Gateway ${dialogKind} dialog result does not match the pending dialog contract.`));
                  return;
                }
                pending.resolve(answer.result.behavior === "answered"
                  ? { type: "answered", value: answer.result.value }
                  : { type: "cancelled", ...(answer.result.reason ? { reason: answer.result.reason } : {}) });
              } catch (error) {
                // A temporary host-store read failure must not abort a native
                // waiting tool. The next poll may observe a healthy store.
                void error;
              } finally {
                polling = false;
              }
            };
            pollTimer = setInterval(() => { void poll(); }, LIVE_OWNER_RENEW_INTERVAL_MS);
            void poll();
          }
          if (request.signal?.aborted) cancel("aborted");
        } catch (error) {
          if (settled) return;
          settled = true;
          clearAbort();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  }
}

import {
  PilotDeckError,
  type OnUserDialog,
  type PilotDeckClient,
  type PilotDeckPendingUserDialog,
} from "./types.js";

/** Options for one SDK-owned renderer of Gateway-owned manual dialogs. */
export type PilotDeckManualDialogRendererOptions = {
  sessionId: string;
  projectKey?: string;
  /** Called only after this renderer atomically obtains the Gateway lease. */
  render: OnUserDialog;
  /** 1,000 through 300,000 milliseconds; defaults to 30 seconds. */
  leaseTtlMs?: number;
};

/**
 * A local coordinator for one manual dialog renderer. Gateway remains the
 * pending-state, validation, lease, and turn-lifecycle authority.
 */
export type PilotDeckManualDialogRenderer = {
  /** Re-read the authoritative pending snapshot and attempt unclaimed work. */
  refresh(): Promise<void>;
  /** Stop observing and abort any in-flight local renderer callbacks. */
  close(): void;
};

type ActiveDialog = {
  controller: AbortController;
  stopRenewal(): void;
};

const DEFAULT_LEASE_TTL_MS = 30_000;

/**
 * Starts a resilient manual-dialog renderer for one session.
 *
 * Subscription is installed before the first list call so a dialog created
 * during attachment is either observed by the hint or present in the
 * authoritative snapshot. Hints are still lossy across disconnects; callers
 * may invoke refresh() after reconnect or at their own lifecycle boundary.
 */
export async function createManualUserDialogRenderer(
  client: PilotDeckClient,
  options: PilotDeckManualDialogRendererOptions,
): Promise<PilotDeckManualDialogRenderer> {
  if (!options.sessionId?.trim()) {
    throw new PilotDeckError({ code: "validation_error", message: "sessionId is required." });
  }
  if (typeof options.render !== "function") {
    throw new PilotDeckError({ code: "validation_error", message: "A manual dialog renderer is required." });
  }
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1_000 || leaseTtlMs > 300_000) {
    throw new PilotDeckError({ code: "validation_error", message: "leaseTtlMs must be a safe integer between 1000 and 300000." });
  }

  const renderer = new ManualUserDialogRenderer(client, {
    ...options,
    sessionId: options.sessionId.trim(),
    leaseTtlMs,
  });
  await renderer.start();
  return renderer;
}

class ManualUserDialogRenderer implements PilotDeckManualDialogRenderer {
  private readonly active = new Map<string, ActiveDialog>();
  private stopWatching?: () => void;
  private refreshInFlight?: Promise<void>;
  private closed = false;

  constructor(
    private readonly client: PilotDeckClient,
    private readonly options: Required<Pick<PilotDeckManualDialogRendererOptions, "sessionId" | "render" | "leaseTtlMs">>
      & Pick<PilotDeckManualDialogRendererOptions, "projectKey">,
  ) {}

  async start(): Promise<void> {
    this.stopWatching = await this.client.dialogs.watch({
      sessionId: this.options.sessionId,
      ...(this.options.projectKey ? { projectKey: this.options.projectKey } : {}),
    }, (change) => {
      if (change.type === "settled") {
        this.active.get(change.requestId)?.controller.abort("gateway_dialog_settled");
        return;
      }
      void this.refresh().catch(() => undefined);
    });
    await this.refresh();
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.refreshInFlight) return this.refreshInFlight;
    const refreshing = this.refreshInternal().finally(() => {
      if (this.refreshInFlight === refreshing) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = refreshing;
    return refreshing;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopWatching?.();
    this.stopWatching = undefined;
    for (const active of this.active.values()) {
      active.stopRenewal();
      active.controller.abort("manual_dialog_renderer_closed");
    }
    this.active.clear();
  }

  private async refreshInternal(): Promise<void> {
    const records = await this.client.dialogs.list({
      sessionId: this.options.sessionId,
      ...(this.options.projectKey ? { projectKey: this.options.projectKey } : {}),
    });
    for (const record of records) {
      if (this.closed || "type" in record || this.active.has(record.requestId)) continue;
      await this.claimAndRender(record);
    }
  }

  private async claimAndRender(request: PilotDeckPendingUserDialog): Promise<void> {
    const claim = await this.client.dialogs.claim({
      sessionId: this.options.sessionId,
      ...(this.options.projectKey ? { projectKey: this.options.projectKey } : {}),
      requestId: request.requestId,
      ttlMs: this.options.leaseTtlMs,
    });
    if (!claim.claimed || this.closed) return;

    const controller = new AbortController();
    const stopRenewal = this.renewLease(request.requestId, claim.leaseId, controller);
    this.active.set(request.requestId, { controller, stopRenewal });
    void this.renderClaimed(request, claim.leaseId, controller, stopRenewal).catch(() => undefined);
  }

  private renewLease(requestId: string, leaseId: string, controller: AbortController): () => void {
    let renewing = false;
    const intervalMs = Math.max(500, Math.floor(this.options.leaseTtlMs * 0.6));
    const timer = setInterval(() => {
      if (renewing || controller.signal.aborted || this.closed) return;
      renewing = true;
      void this.client.dialogs.claim({
        sessionId: this.options.sessionId,
        ...(this.options.projectKey ? { projectKey: this.options.projectKey } : {}),
        requestId,
        leaseId,
        ttlMs: this.options.leaseTtlMs,
      }).then((renewal) => {
        if (!renewal.claimed) controller.abort("gateway_dialog_lease_lost");
      }).catch(() => controller.abort("gateway_dialog_lease_renewal_failed"))
        .finally(() => { renewing = false; });
    }, intervalMs);
    return () => clearInterval(timer);
  }

  private async renderClaimed(
    request: PilotDeckPendingUserDialog,
    leaseId: string,
    controller: AbortController,
    stopRenewal: () => void,
  ): Promise<void> {
    let delivered = false;
    try {
      const result = await this.options.render(request, { signal: controller.signal });
      if (controller.signal.aborted || this.closed) return;
      const receipt = await this.client.dialogs.respond({
        sessionId: this.options.sessionId,
        ...(this.options.projectKey ? { projectKey: this.options.projectKey } : {}),
        requestId: request.requestId,
        leaseId,
        result,
      });
      delivered = receipt.delivered;
    } finally {
      stopRenewal();
      this.active.delete(request.requestId);
      if (!delivered) {
        await this.client.dialogs.release({
          sessionId: this.options.sessionId,
          ...(this.options.projectKey ? { projectKey: this.options.projectKey } : {}),
          requestId: request.requestId,
          leaseId,
        }).catch(() => undefined);
      }
    }
  }
}

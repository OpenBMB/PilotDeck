import type { GatewayUserDialogRequestEvent } from "../protocol/types.js";

/** Stable Gateway-host identity for one durable SDK dialog stream. */
export type GatewayUserDialogStoreKey = Readonly<{
  projectRoot: string;
  pilotHome: string;
  sessionId: string;
}>;

/** A host-owned durable pending dialog record. */
export type GatewayStoredUserDialog = Readonly<{
  request: GatewayUserDialogRequestEvent;
  createdAt: string;
}>;

export type GatewayStoredUserDialogResult =
  | { behavior: "answered"; value: unknown }
  | { behavior: "cancelled"; reason?: string };

export type GatewayStoredUserDialogLeaseClaim =
  | { claimed: true; leaseId: string; expiresAt: string }
  | { claimed: false; reason: "claimed" | "not_pending"; expiresAt?: string };

/** Optional liveness lease held by the Gateway that owns the native tool promise. */
export type GatewayStoredUserDialogOwnerClaim =
  | { owned: true; ownerId: string; expiresAt: string }
  | { owned: false; reason: "owned" | "not_pending"; expiresAt?: string };

/** A host-accepted response that the owning Gateway still has to consume. */
export type GatewayStoredUserDialogAnswer = Readonly<{
  requestId: string;
  result: GatewayStoredUserDialogResult;
  submittedAt: string;
}>;

/**
 * Optional persistence boundary for live SDK generic dialogs.
 *
 * The host owns atomicity and any cross-process locking. PilotDeck keeps the
 * dialog contract, validation, AgentLoop and transcript lifecycle in the
 * Gateway. This store intentionally carries no SDK callback or run state.
 */
export type GatewayUserDialogStore = {
  /** Atomically insert or replace the pending request for this session. */
  put(key: GatewayUserDialogStoreKey, dialog: GatewayStoredUserDialog): void | Promise<void>;
  /** Return the current pending requests for this session. */
  list(key: GatewayUserDialogStoreKey): readonly GatewayStoredUserDialog[] | Promise<readonly GatewayStoredUserDialog[]>;
  /** Atomically remove a settled or superseded request. Missing is success. */
  remove(key: GatewayUserDialogStoreKey, requestId: string): void | Promise<void>;
  /** Optional whole-session cleanup invoked after a superseding new turn. */
  clear?(key: GatewayUserDialogStoreKey): void | Promise<void>;
  /**
   * The following five operations form the optional cross-Gateway live
   * renderer protocol. They must be atomic at the host store boundary. A
   * store that omits any of them is recovery-only and is never exposed as a
   * live dialog by another Gateway process.
   */
  listLive?(key: GatewayUserDialogStoreKey): readonly GatewayStoredUserDialog[] | Promise<readonly GatewayStoredUserDialog[]>;
  claimLive?(key: GatewayUserDialogStoreKey, input: {
    requestId: string;
    ttlMs: number;
    leaseId?: string;
  }): GatewayStoredUserDialogLeaseClaim | Promise<GatewayStoredUserDialogLeaseClaim>;
  releaseLive?(key: GatewayUserDialogStoreKey, input: { requestId: string; leaseId: string }): boolean | Promise<boolean>;
  submitLiveAnswer?(key: GatewayUserDialogStoreKey, input: {
    requestId: string;
    leaseId?: string;
    result: GatewayStoredUserDialogResult;
  }): boolean | Promise<boolean>;
  /** Atomically returns and consumes the answer submitted by a remote renderer. */
  takeLiveAnswer?(key: GatewayUserDialogStoreKey, requestId: string): GatewayStoredUserDialogAnswer | undefined | Promise<GatewayStoredUserDialogAnswer | undefined>;
  /**
   * Optional owner-heartbeat protocol. A store that implements it may hide a
   * live dialog after the Gateway owning its native tool promise has stopped
   * renewing its lease, allowing the usual restart-terminal recovery path.
   * This does not transfer the AgentLoop to a second Gateway.
   */
  claimLiveOwner?(key: GatewayUserDialogStoreKey, input: {
    requestId: string;
    ownerId: string;
    ttlMs: number;
  }): GatewayStoredUserDialogOwnerClaim | Promise<GatewayStoredUserDialogOwnerClaim>;
  renewLiveOwner?(key: GatewayUserDialogStoreKey, input: {
    requestId: string;
    ownerId: string;
    ttlMs: number;
  }): boolean | Promise<boolean>;
  releaseLiveOwner?(key: GatewayUserDialogStoreKey, input: {
    requestId: string;
    ownerId: string;
  }): boolean | Promise<boolean>;
};

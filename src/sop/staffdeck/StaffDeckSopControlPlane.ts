import { join } from "node:path";

import { SopStateStore } from "./SopStateStore.js";
import type {
  StaffDeckSopResumeInput,
  StaffDeckSopResumeResult,
  SopRuntimeConfig,
  StaffDeckSopStatusSnapshot,
} from "./types.js";

export type StaffDeckSopControlInput = Readonly<{
  projectKey?: string;
  sessionKey: string;
}>;

export type StaffDeckSopControlResumeInput = StaffDeckSopControlInput & Omit<StaffDeckSopResumeInput, "sessionId">;

/** Host-side lifecycle control. It never changes StaffDeck's SOP transition engine. */
export class StaffDeckSopControlPlane {
  private readonly stores = new Map<string, SopStateStore>();

  constructor(
    private readonly resolveProfile: (projectKey?: string) => SopRuntimeConfig | undefined,
  ) {}

  async status(input: StaffDeckSopControlInput): Promise<StaffDeckSopStatusSnapshot | undefined> {
    return this.store(input.projectKey).status(input.sessionKey);
  }

  async resume(input: StaffDeckSopControlResumeInput): Promise<StaffDeckSopResumeResult> {
    return this.store(input.projectKey).resume({
      sessionId: input.sessionKey,
      requestId: input.requestId,
      waitId: input.waitId,
      source: input.source,
      message: input.message,
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      ...(input.slotUpdates ? { slotUpdates: input.slotUpdates } : {}),
    });
  }

  private store(projectKey?: string): SopStateStore {
    const profile = this.resolveProfile(projectKey);
    if (!profile) throw controlError("SOP_MODULE_DISABLED", "The StaffDeck SOP module is not enabled for this project.");
    const root = join(profile.stateRoot, "sessions");
    let store = this.stores.get(root);
    if (!store) {
      store = new SopStateStore(root);
      this.stores.set(root, store);
    }
    return store;
  }
}

function controlError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

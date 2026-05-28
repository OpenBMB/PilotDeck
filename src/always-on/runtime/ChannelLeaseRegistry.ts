import type { AlwaysOnChannelLease } from "../protocol/types.js";

export type LeaseUpdateInput = Omit<AlwaysOnChannelLease, "schemaVersion" | "writtenAt"> & {
  writtenAt?: string;
};

/**
 * In-memory channel-lease registry. Lease lifetime is server-process bound;
 * it is not persisted. Adapters mutate it on connect / disconnect / submit /
 * complete; the discovery scheduler reads it via `listFresh`.
 */
export class ChannelLeaseRegistry {
  private readonly leases = new Map<string, AlwaysOnChannelLease>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  set(input: LeaseUpdateInput): AlwaysOnChannelLease {
    const lease: AlwaysOnChannelLease = {
      schemaVersion: 1,
      writtenAt: input.writtenAt ?? this.now().toISOString(),
      channelKey: input.channelKey,
      writerId: input.writerId,
      projectKey: input.projectKey,
      sessionKey: input.sessionKey,
      agentBusy: input.agentBusy,
      lastUserMsgAt: input.lastUserMsgAt ?? null,
    };
    this.leases.set(this.key(lease.projectKey, lease.channelKey, lease.writerId), lease);
    return lease;
  }

  markBusy(input: { projectKey: string; channelKey: string; writerId: string }): void {
    const lease = this.leases.get(this.key(input.projectKey, input.channelKey, input.writerId));
    if (!lease) return;
    lease.agentBusy = true;
    lease.writtenAt = this.now().toISOString();
  }

  markIdle(input: { projectKey: string; channelKey: string; writerId: string }): void {
    const lease = this.leases.get(this.key(input.projectKey, input.channelKey, input.writerId));
    if (!lease) return;
    lease.agentBusy = false;
    lease.lastUserMsgAt = this.now().toISOString();
    lease.writtenAt = this.now().toISOString();
  }

  remove(input: { projectKey: string; channelKey: string; writerId: string }): void {
    this.leases.delete(this.key(input.projectKey, input.channelKey, input.writerId));
  }

  removeByWriter(writerId: string): void {
    for (const [key, lease] of this.leases) {
      if (lease.writerId === writerId) {
        this.leases.delete(key);
      }
    }
  }

  listFresh(input: { projectKey: string; staleSeconds: number; now?: Date }): AlwaysOnChannelLease[] {
    const cutoff = (input.now ?? this.now()).getTime() - input.staleSeconds * 1000;
    const fresh: AlwaysOnChannelLease[] = [];
    for (const lease of this.leases.values()) {
      if (lease.projectKey !== input.projectKey) continue;
      if (Date.parse(lease.writtenAt) >= cutoff) {
        fresh.push(lease);
      }
    }
    return fresh;
  }

  list(): AlwaysOnChannelLease[] {
    return Array.from(this.leases.values());
  }

  private key(projectKey: string, channelKey: string, writerId: string): string {
    return `${projectKey}\u0001${channelKey}\u0001${writerId}`;
  }
}

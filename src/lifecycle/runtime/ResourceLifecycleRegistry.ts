/**
 * ResourceLifecycleRegistry — centralized lifecycle management for PilotDeck resources.
 *
 * Provides a single place to register, track, and dispose of resources that need
 * coordinated cleanup on shutdown or invalidation. Replaces ad-hoc teardown logic
 * scattered throughout `createLocalGateway` and `ProjectRuntimeRegistry`.
 *
 * Usage:
 * ```ts
 * const registry = new ResourceLifecycleRegistry();
 * registry.register("mcp-runtime", async () => { await mcp.stop(); });
 * registry.register("memory-service", () => { memoryService.close(); });
 * await registry.disposeAll();
 * ```
 */

export type Disposable = () => void | Promise<void>;

export type ResourceLifecycleRegistryOptions = {
  /**
   * Called when a resource fails to dispose. Default logs to console.warn.
   */
  onError?: (name: string, error: unknown) => void;
  /**
   * Called when a resource is successfully disposed. Useful for debugging.
   */
  onDisposed?: (name: string) => void;
  /**
   * Called when a resource is registered. Useful for tracking registration order.
   */
  onRegistered?: (name: string) => void;
};

export class ResourceLifecycleRegistry {
  private readonly resources = new Map<string, Disposable>();
  private readonly options: Required<ResourceLifecycleRegistryOptions>;

  constructor(options: ResourceLifecycleRegistryOptions = {}) {
    this.options = {
      onError: options.onError ?? ((name, error) => {
        console.warn(`[ResourceLifecycleRegistry] disposal failed for "${name}": ${error instanceof Error ? error.message : String(error)}`);
      }),
      onDisposed: options.onDisposed ?? (() => { /* noop */ }),
      onRegistered: options.onRegistered ?? (() => { /* noop */ }),
    };
  }

  /**
   * Register a named disposable resource. If `name` is already registered,
   * the previous registration is replaced (the old disposable is NOT invoked).
   */
  register(name: string, dispose: Disposable): void {
    this.resources.set(name, dispose);
    this.options.onRegistered(name);
  }

  /**
   * Unregister a resource without invoking its dispose function.
   * Returns true if the resource was found and removed.
   */
  unregister(name: string): boolean {
    return this.resources.delete(name);
  }

  /**
   * Synchronously check whether a resource is registered.
   */
  has(name: string): boolean {
    return this.resources.has(name);
  }

  /**
   * Get a list of all registered resource names, in registration order.
   */
  registered(): string[] {
    return [...this.resources.keys()];
  }

  /**
   * Dispose a single named resource. No-op if `name` is not registered.
   * Returns true if the resource was found and disposed.
   */
  async dispose(name: string): Promise<boolean> {
    const dispose = this.resources.get(name);
    if (!dispose) return false;

    this.resources.delete(name);
    try {
      await dispose();
      this.options.onDisposed(name);
    } catch (error) {
      this.options.onError(name, error);
    }
    return true;
  }

  /**
   * Dispose all registered resources. Errors are collected and reported via
   * `onError` — a failing disposal does not prevent other resources from
   * being cleaned up.
   */
  async disposeAll(): Promise<void> {
    const entries = [...this.resources.entries()];
    this.resources.clear();

    await Promise.allSettled(
      entries.map(async ([name, dispose]) => {
        try {
          await dispose();
          this.options.onDisposed(name);
        } catch (error) {
          this.options.onError(name, error);
        }
      }),
    );
  }
}
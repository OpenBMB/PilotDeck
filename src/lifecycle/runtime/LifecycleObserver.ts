export type LifecycleObserver = {
  onEvent?(event: unknown): void;
};

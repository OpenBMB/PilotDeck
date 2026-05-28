export class RouterConfigError extends Error {
  readonly name = "RouterConfigError";

  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class RouterRuntimeError extends Error {
  readonly name = "RouterRuntimeError";

  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type RestartSplashCopy = {
  title?: string;
  description?: string;
  documentTitle?: string;
};

type RestartRequestContext = {
  signal: AbortSignal;
};

type RestartRequest = (context: RestartRequestContext) => Promise<unknown>;

export type RestartUiStatus =
  | "restarting"
  | "request-rejected"
  | "not-confirmed"
  | "confirmed";

type PollHealthOptions = {
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  timeoutMs?: number;
  reload?: () => void;
  setIntervalImpl?: typeof window.setInterval;
  clearIntervalImpl?: typeof window.clearInterval;
};

type RestartAndReloadOptions = PollHealthOptions & {
  copy?: RestartSplashCopy;
  onStatusChange?: (status: RestartUiStatus) => void;
};

type HealthPayload = {
  instanceId?: unknown;
  startedAt?: unknown;
  pid?: unknown;
};

type RestartAcceptedPayload = {
  previousInstanceId?: unknown;
  previousStartedAt?: unknown;
  previousPid?: unknown;
};

type HealthSnapshot = {
  marker: string | null;
};

type PollHealthInternalOptions = PollHealthOptions & {
  baseline?: HealthSnapshot | null;
  onStatusChange?: (status: RestartUiStatus) => void;
  deadline?: RestartDeadline;
};

const DEFAULT_TIMEOUT_MS = 120_000;

class RestartTimeoutError extends Error {
  constructor() {
    super("Restart confirmation timed out");
    this.name = "RestartTimeoutError";
  }
}

type RestartDeadline = {
  signal: AbortSignal;
  remainingMs: () => number;
  run: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  finish: () => void;
  hasExpired: () => boolean;
};

function createRestartDeadline(timeoutMs: number, onTimeout: () => void): RestartDeadline {
  const timeout = Math.max(0, timeoutMs);
  const expiresAt = Date.now() + timeout;
  const controller = new AbortController();
  let finished = false;
  let timeoutNotified = false;

  const notifyTimeout = () => {
    if (finished || timeoutNotified) return;
    timeoutNotified = true;
    controller.abort();
    onTimeout();
  };

  const timer = window.setTimeout(notifyTimeout, timeout);

  const finish = () => {
    finished = true;
    window.clearTimeout(timer);
  };

  const remainingMs = () => Math.max(0, expiresAt - Date.now());

  const run = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (controller.signal.aborted || remainingMs() <= 0) {
      notifyTimeout();
      throw new RestartTimeoutError();
    }

    let operationTimer: number | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      operationTimer = window.setTimeout(() => {
        notifyTimeout();
        reject(new RestartTimeoutError());
      }, remainingMs());
    });

    try {
      return await Promise.race([
        operation(controller.signal),
        timeoutPromise,
      ]);
    } finally {
      if (operationTimer !== null) window.clearTimeout(operationTimer);
    }
  };

  return {
    signal: controller.signal,
    remainingMs,
    run,
    finish,
    hasExpired: () => controller.signal.aborted || remainingMs() <= 0,
  };
}

function isRestartTimeout(error: unknown) {
  return error instanceof RestartTimeoutError
    || (error instanceof DOMException && error.name === "AbortError");
}

async function readHealthSnapshot(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<HealthSnapshot | null> {
  const res = await fetchImpl("/health", signal ? { signal } : undefined);
  if (!res.ok) return null;

  let payload: HealthPayload = {};
  try {
    payload = await res.json();
  } catch {
    payload = {};
  }

  if (typeof payload.instanceId === "string" && payload.instanceId) {
    return {
      marker: `instance:${payload.instanceId}`,
    };
  }

  const pid = typeof payload.pid === "number" || typeof payload.pid === "string"
    ? String(payload.pid)
    : "";
  const startedAt = typeof payload.startedAt === "string" ? payload.startedAt : "";
  if (pid && startedAt) {
    return {
      marker: `legacy:${pid}:${startedAt}`,
    };
  }

  return {
    marker: null,
  };
}

function hasAcceptedRestart(value: unknown) {
  if (
    value
    && typeof value === "object"
    && "ok" in value
    && typeof (value as { ok?: unknown }).ok === "boolean"
  ) {
    return (value as { ok: boolean }).ok;
  }
  return true;
}

function isResponseLike(value: unknown): value is Response {
  return Boolean(
    value
    && typeof value === "object"
    && "ok" in value
    && typeof (value as { ok?: unknown }).ok === "boolean",
  );
}

function markerFromRestartPayload(payload: RestartAcceptedPayload): HealthSnapshot | null {
  if (typeof payload.previousInstanceId === "string" && payload.previousInstanceId) {
    return {
      marker: `instance:${payload.previousInstanceId}`,
    };
  }

  const pid = typeof payload.previousPid === "number" || typeof payload.previousPid === "string"
    ? String(payload.previousPid)
    : "";
  const startedAt = typeof payload.previousStartedAt === "string" ? payload.previousStartedAt : "";
  if (pid && startedAt) {
    return {
      marker: `legacy:${pid}:${startedAt}`,
    };
  }

  return null;
}

async function readRestartBaseline(value: unknown, deadline?: RestartDeadline): Promise<HealthSnapshot | null> {
  if (!isResponseLike(value) || !value.ok) return null;

  try {
    const payload = await (deadline
      ? deadline.run(() => value.clone().json() as Promise<RestartAcceptedPayload>)
      : value.clone().json() as Promise<RestartAcceptedPayload>);
    return markerFromRestartPayload(payload);
  } catch {
    return null;
  }
}

export function pollHealthAndReload({
  fetchImpl = fetch,
  intervalMs = 2000,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  reload = () => window.location.reload(),
  setIntervalImpl = window.setInterval,
  clearIntervalImpl = window.clearInterval,
  baseline = null,
  onStatusChange,
  deadline,
}: PollHealthInternalOptions = {}) {
  let sawUnavailable = false;
  const startedAtMs = Date.now();
  const poll = setIntervalImpl(() => {
    void (async () => {
      if (deadline?.hasExpired() || Date.now() - startedAtMs >= timeoutMs) {
        clearIntervalImpl(poll);
        onStatusChange?.("not-confirmed");
        return;
      }

      try {
        const snapshot = await (deadline
          ? deadline.run((signal) => readHealthSnapshot(fetchImpl, signal))
          : readHealthSnapshot(fetchImpl));
        if (!snapshot) {
          sawUnavailable = true;
          return;
        }

        if (baseline?.marker && snapshot.marker) {
          if (snapshot.marker !== baseline.marker) {
            clearIntervalImpl(poll);
            onStatusChange?.("confirmed");
            reload();
          }
          return;
        }

        if (baseline && !baseline.marker && snapshot.marker) {
          clearIntervalImpl(poll);
          onStatusChange?.("confirmed");
          reload();
          return;
        }

        if (!baseline && sawUnavailable && snapshot.marker) {
          clearIntervalImpl(poll);
          onStatusChange?.("confirmed");
          reload();
          return;
        }

        if (!baseline?.marker && !snapshot.marker && sawUnavailable) {
          clearIntervalImpl(poll);
          onStatusChange?.("confirmed");
          reload();
        }
      } catch {
        if (deadline?.hasExpired()) {
          clearIntervalImpl(poll);
          onStatusChange?.("not-confirmed");
          return;
        }
        sawUnavailable = true;
      }
    })();
  }, intervalMs);

  return poll;
}

export function restartAndReload(
  requestRestart: RestartRequest | (() => Promise<unknown>),
  options: RestartAndReloadOptions = {},
) {
  void (async () => {
    let settled = false;
    const markNotConfirmed = () => {
      if (settled) return;
      settled = true;
      options.onStatusChange?.("not-confirmed");
    };
    const deadline = createRestartDeadline(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, markNotConfirmed);
    options.onStatusChange?.("restarting");
    if (options.copy?.documentTitle || options.copy?.title) {
      document.title = options.copy.documentTitle ?? options.copy.title ?? document.title;
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    let baseline: HealthSnapshot | null = null;
    try {
      baseline = await deadline.run((signal) => readHealthSnapshot(fetchImpl, signal));
    } catch (error) {
      if (isRestartTimeout(error)) return;
      baseline = null;
    }
    try {
      const restartResponse = await deadline.run((signal) => (
        requestRestart as RestartRequest
      )({ signal }));
      if (!hasAcceptedRestart(restartResponse)) {
        settled = true;
        deadline.finish();
        options.onStatusChange?.("request-rejected");
        return;
      }
      baseline = await readRestartBaseline(restartResponse, deadline) ?? baseline;
    } catch (error) {
      if (isRestartTimeout(error)) return;
      // The restart request can be interrupted when the server exits.
    }

    if (deadline.hasExpired()) return;
    pollHealthAndReload({
      ...options,
      timeoutMs: deadline.remainingMs(),
      baseline,
      deadline,
      onStatusChange: (status) => {
        if (status === "confirmed") {
          settled = true;
          deadline.finish();
          options.onStatusChange?.(status);
        } else if (status === "not-confirmed") {
          markNotConfirmed();
        } else {
          options.onStatusChange?.(status);
        }
      },
    });
  })();
}

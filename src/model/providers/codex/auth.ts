import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolvePilotHome, type PilotPathEnv } from "../../../pilot/paths.js";
import {
  CODEX_ACCESS_TOKEN_REFRESH_SKEW_MS,
  CODEX_AUTH_REQUEST_TIMEOUT_MS,
  CODEX_DEVICE_CODE_URL,
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_DEVICE_VERIFICATION_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
} from "./constants.js";
import {
  codexAccessTokenExpiresAt,
  extractChatGptAccountId,
  isCodexAccessTokenExpiring,
} from "./jwt.js";

const AUTH_STORE_VERSION = 1;
const AUTH_LOCK_TIMEOUT_MS = 20_000;
const AUTH_LOCK_STALE_MS = 60_000;
const AUTH_LOCK_POLL_MS = 75;
const CODEX_OAUTH_USER_AGENT = "pilotdeck/0.1.0";

export type CodexTokenSet = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
};

export type CodexAuthSource = "device-code" | "codex-cli-import" | "refresh";

export type CodexStoredAuthState = {
  tokens: CodexTokenSet;
  last_refresh: string;
  auth_mode: "chatgpt";
  source: CodexAuthSource;
};

type AuthStore = {
  version: number;
  updated_at?: string;
  providers: Record<string, unknown> & {
    codex?: CodexStoredAuthState;
  };
};

export type CodexRuntimeCredentials = {
  accessToken: string;
  accountId?: string;
  expiresAt?: number;
  source: CodexAuthSource;
};

export type CodexAuthStatus = {
  authenticated: boolean;
  importAvailable: boolean;
  accountId?: string;
  expiresAt?: number;
  source?: CodexAuthSource;
  lastRefresh?: string;
};

export type CodexDeviceCode = {
  userCode: string;
  deviceAuthId: string;
  verificationUrl: string;
  intervalMs: number;
};

export type CodexDevicePollResult =
  | { status: "pending"; retryAfterMs?: number }
  | {
      status: "authorized";
      authorizationCode: string;
      codeVerifier: string;
    };

export type CodexAuthOptions = {
  env?: PilotPathEnv;
  fetch?: typeof fetch;
  now?: () => number;
};

export class CodexAuthError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly reloginRequired: boolean;

  constructor(
    message: string,
    options: { code: string; status?: number; reloginRequired?: boolean },
  ) {
    super(message);
    this.name = "CodexAuthError";
    this.code = options.code;
    this.status = options.status;
    this.reloginRequired = options.reloginRequired ?? false;
  }
}

export function getPilotDeckAuthFilePath(env: PilotPathEnv = process.env): string {
  return join(resolvePilotHome(env), "auth.json");
}

export function getCodexCliAuthFilePath(env: PilotPathEnv = process.env): string {
  const codexHome = env.CODEX_HOME?.trim()
    ? resolve(env.CODEX_HOME)
    : join(homedir(), ".codex");
  return join(codexHome, "auth.json");
}

export async function getCodexAuthStatus(
  options: CodexAuthOptions = {},
): Promise<CodexAuthStatus> {
  const env = options.env ?? process.env;
  const now = options.now?.() ?? Date.now();
  const authPath = getPilotDeckAuthFilePath(env);
  let store = await loadAuthStore(authPath);
  let state = normalizeStoredState(store.providers.codex);
  const importable = await readCodexCliTokens(env, now);
  if (!state) {
    return {
      authenticated: false,
      importAvailable: Boolean(importable),
    };
  }
  if (isCodexAccessTokenExpiring(state.tokens.access_token, 0, now)) {
    try {
      await resolveCodexRuntimeCredentials({
        ...options,
        importIfMissing: false,
      });
      store = await loadAuthStore(authPath);
      state = normalizeStoredState(store.providers.codex);
    } catch {
      return {
        authenticated: false,
        importAvailable: Boolean(importable),
      };
    }
  }
  if (!state) {
    return {
      authenticated: false,
      importAvailable: Boolean(importable),
    };
  }
  const expiresAt = codexAccessTokenExpiresAt(state.tokens.access_token);
  return {
    authenticated: !isCodexAccessTokenExpiring(state.tokens.access_token, 0, now),
    importAvailable: Boolean(importable),
    accountId: extractChatGptAccountId(state.tokens.access_token),
    expiresAt,
    source: state.source,
    lastRefresh: state.last_refresh,
  };
}

export async function importCodexCliCredentials(
  options: CodexAuthOptions = {},
): Promise<CodexRuntimeCredentials | undefined> {
  const env = options.env ?? process.env;
  const now = options.now?.() ?? Date.now();
  const tokens = await readCodexCliTokens(env, now);
  if (!tokens) return undefined;
  const state = await saveCodexTokens(tokens, "codex-cli-import", options);
  return runtimeCredentials(state);
}

export async function resolveCodexRuntimeCredentials(
  input: CodexAuthOptions & { forceRefresh?: boolean; importIfMissing?: boolean } = {},
): Promise<CodexRuntimeCredentials> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetch ?? fetch;
  const nowFn = input.now ?? Date.now;
  const authPath = getPilotDeckAuthFilePath(env);
  const importIfMissing = input.importIfMissing ?? true;

  return withAuthFileLock(authPath, async () => {
    const store = await loadAuthStore(authPath);
    let state = normalizeStoredState(store.providers.codex);

    if (!state && importIfMissing) {
      const imported = await readCodexCliTokens(env, nowFn());
      if (imported) {
        state = createStoredState(imported, "codex-cli-import", nowFn());
        store.providers.codex = state;
        await saveAuthStore(authPath, store);
      }
    }

    if (!state) {
      throw new CodexAuthError(
        "No Codex subscription credentials are stored. Sign in with ChatGPT or import ~/.codex/auth.json.",
        { code: "codex_auth_missing", reloginRequired: true },
      );
    }

    const shouldRefresh = input.forceRefresh
      || isCodexAccessTokenExpiring(
        state.tokens.access_token,
        CODEX_ACCESS_TOKEN_REFRESH_SKEW_MS,
        nowFn(),
      );
    if (shouldRefresh) {
      try {
        const refreshed = await refreshCodexTokens(state.tokens, {
          fetch: fetchImpl,
          now: nowFn,
        });
        state = createStoredState(refreshed, "refresh", nowFn());
        store.providers.codex = state;
        await saveAuthStore(authPath, store);
      } catch (error) {
        if (!(error instanceof CodexAuthError) || !error.reloginRequired) throw error;
        const recovered = await readCodexCliTokens(env, nowFn());
        if (
          !recovered
          || recovered.access_token === state.tokens.access_token
        ) {
          throw error;
        }
        state = createStoredState(recovered, "codex-cli-import", nowFn());
        store.providers.codex = state;
        await saveAuthStore(authPath, store);
      }
    }

    return runtimeCredentials(state);
  });
}

export async function saveCodexTokens(
  tokens: CodexTokenSet,
  source: CodexAuthSource,
  options: CodexAuthOptions = {},
): Promise<CodexStoredAuthState> {
  const env = options.env ?? process.env;
  const now = options.now?.() ?? Date.now();
  const normalized = normalizeTokens(tokens);
  if (!normalized) {
    throw new CodexAuthError(
      "Codex OAuth did not return both an access token and a refresh token.",
      { code: "codex_token_response_incomplete", reloginRequired: true },
    );
  }
  const authPath = getPilotDeckAuthFilePath(env);
  return withAuthFileLock(authPath, async () => {
    const store = await loadAuthStore(authPath);
    const state = createStoredState(normalized, source, now);
    store.providers.codex = state;
    await saveAuthStore(authPath, store);
    return state;
  });
}

export async function clearCodexCredentials(
  options: CodexAuthOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const authPath = getPilotDeckAuthFilePath(env);
  await withAuthFileLock(authPath, async () => {
    const store = await loadAuthStore(authPath);
    delete store.providers.codex;
    await saveAuthStore(authPath, store);
  });
}

export async function refreshCodexTokens(
  tokens: CodexTokenSet,
  options: Pick<CodexAuthOptions, "fetch" | "now"> = {},
): Promise<CodexTokenSet> {
  const fetchImpl = options.fetch ?? fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: CODEX_OAUTH_CLIENT_ID,
  });
  const response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": CODEX_OAUTH_USER_AGENT,
    },
    body,
    signal: AbortSignal.timeout(CODEX_AUTH_REQUEST_TIMEOUT_MS),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw tokenEndpointError(response, payload, "Codex token refresh failed");
  }
  const next = normalizeTokens({
    access_token: readString(payload.access_token),
    refresh_token: readString(payload.refresh_token) || tokens.refresh_token,
    id_token: readString(payload.id_token) || tokens.id_token,
  });
  if (!next) {
    throw new CodexAuthError(
      "Codex token refresh response was missing required tokens.",
      { code: "codex_refresh_incomplete", reloginRequired: true },
    );
  }
  return next;
}

export async function requestCodexDeviceCode(
  options: Pick<CodexAuthOptions, "fetch"> = {},
): Promise<CodexDeviceCode> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(CODEX_DEVICE_CODE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
    signal: AbortSignal.timeout(CODEX_AUTH_REQUEST_TIMEOUT_MS),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw authEndpointError(response, payload, "Could not start Codex sign-in", "device_code_request_failed");
  }
  const userCode = readString(payload.user_code);
  const deviceAuthId = readString(payload.device_auth_id);
  if (!userCode || !deviceAuthId) {
    throw new CodexAuthError(
      "Codex device-code response was missing required fields.",
      { code: "device_code_incomplete" },
    );
  }
  const intervalSeconds = readPositiveNumber(payload.interval) ?? 5;
  return {
    userCode,
    deviceAuthId,
    verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
    intervalMs: Math.max(1_000, intervalSeconds * 1000),
  };
}

export async function pollCodexDeviceCode(
  input: Pick<CodexDeviceCode, "userCode" | "deviceAuthId">,
  options: Pick<CodexAuthOptions, "fetch"> = {},
): Promise<CodexDevicePollResult> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(CODEX_DEVICE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_auth_id: input.deviceAuthId,
      user_code: input.userCode,
    }),
    signal: AbortSignal.timeout(CODEX_AUTH_REQUEST_TIMEOUT_MS),
  });
  const payload = await readJson(response);
  if (
    response.status === 429
    || (
      (response.status === 403 || response.status === 404)
      && (Object.keys(payload).length === 0 || isDeviceCodePending(payload))
    )
  ) {
    const retryAfterSeconds = readPositiveNumber(payload.retry_after)
      ?? readPositiveNumber(payload.retryAfter)
      ?? readRetryAfterHeader(response.headers.get("retry-after"));
    return {
      status: "pending",
      ...(retryAfterSeconds ? { retryAfterMs: Math.max(1_000, retryAfterSeconds * 1000) } : {}),
    };
  }
  if (!response.ok) {
    throw authEndpointError(response, payload, "Codex sign-in polling failed", "device_code_poll_failed");
  }
  const authorizationCode = readString(payload.authorization_code);
  const codeVerifier = readString(payload.code_verifier);
  if (!authorizationCode || !codeVerifier) {
    throw new CodexAuthError(
      "Codex device authorization response was incomplete.",
      { code: "device_code_authorization_incomplete" },
    );
  }
  return { status: "authorized", authorizationCode, codeVerifier };
}

export async function exchangeCodexDeviceAuthorization(
  input: Extract<CodexDevicePollResult, { status: "authorized" }>,
  options: CodexAuthOptions = {},
): Promise<CodexRuntimeCredentials> {
  const fetchImpl = options.fetch ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.authorizationCode,
    redirect_uri: CODEX_DEVICE_REDIRECT_URI,
    client_id: CODEX_OAUTH_CLIENT_ID,
    code_verifier: input.codeVerifier,
  });
  const response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": CODEX_OAUTH_USER_AGENT,
    },
    body,
    signal: AbortSignal.timeout(CODEX_AUTH_REQUEST_TIMEOUT_MS),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw tokenEndpointError(response, payload, "Codex token exchange failed");
  }
  const tokens = normalizeTokens(payload);
  if (!tokens) {
    throw new CodexAuthError(
      "Codex token exchange did not return both an access token and a refresh token.",
      { code: "token_exchange_incomplete", reloginRequired: true },
    );
  }
  const state = await saveCodexTokens(tokens, "device-code", options);
  return runtimeCredentials(state);
}

async function readCodexCliTokens(
  env: PilotPathEnv,
  now: number,
): Promise<CodexTokenSet | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(getCodexCliAuthFilePath(env), "utf8"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    return undefined;
  }
  const tokens = normalizeTokens(isRecord(raw) ? raw.tokens : undefined);
  if (!tokens || isCodexAccessTokenExpiring(tokens.access_token, 0, now)) {
    return undefined;
  }
  return tokens;
}

function createStoredState(
  tokens: CodexTokenSet,
  source: CodexAuthSource,
  now: number,
): CodexStoredAuthState {
  return {
    tokens,
    last_refresh: new Date(now).toISOString(),
    auth_mode: "chatgpt",
    source,
  };
}

function runtimeCredentials(state: CodexStoredAuthState): CodexRuntimeCredentials {
  return {
    accessToken: state.tokens.access_token,
    accountId: extractChatGptAccountId(state.tokens.access_token),
    expiresAt: codexAccessTokenExpiresAt(state.tokens.access_token),
    source: state.source,
  };
}

async function loadAuthStore(authPath: string): Promise<AuthStore> {
  let text: string;
  try {
    text = await readFile(authPath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return emptyAuthStore();
    throw error;
  }
  try {
    const value = JSON.parse(text);
    if (!isRecord(value)) return emptyAuthStore();
    return {
      ...value,
      version: typeof value.version === "number" ? value.version : AUTH_STORE_VERSION,
      providers: isRecord(value.providers)
        ? value.providers as AuthStore["providers"]
        : {},
    };
  } catch {
    await copyFile(authPath, `${authPath}.corrupt`).catch(() => undefined);
    return emptyAuthStore();
  }
}

async function saveAuthStore(authPath: string, store: AuthStore): Promise<void> {
  const parent = resolve(authPath, "..");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700).catch(() => undefined);
  const next: AuthStore = {
    ...store,
    version: AUTH_STORE_VERSION,
    updated_at: new Date().toISOString(),
    providers: store.providers ?? {},
  };
  const tempPath = `${authPath}.tmp.${process.pid}.${randomUUID()}`;
  const handle = await open(tempPath, "wx", 0o600);
  let renamed = false;
  try {
    await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, authPath);
    renamed = true;
  } finally {
    if (!renamed) await unlink(tempPath).catch(() => undefined);
  }
  await chmod(authPath, 0o600).catch(() => undefined);
}

async function withAuthFileLock<T>(
  authPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const parent = resolve(authPath, "..");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const lockPath = `${authPath}.lock`;
  const deadline = Date.now() + AUTH_LOCK_TIMEOUT_MS;
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;

  while (!lockHandle) {
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
      await lockHandle.writeFile(String(process.pid), "utf8");
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs > AUTH_LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new CodexAuthError(
          "Timed out waiting for the PilotDeck authentication store lock.",
          { code: "auth_store_lock_timeout" },
        );
      }
      await delay(AUTH_LOCK_POLL_MS);
    }
  }

  try {
    return await action();
  } finally {
    await lockHandle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

function emptyAuthStore(): AuthStore {
  return { version: AUTH_STORE_VERSION, providers: {} };
}

function normalizeStoredState(value: unknown): CodexStoredAuthState | undefined {
  if (!isRecord(value)) return undefined;
  const tokens = normalizeTokens(value.tokens);
  if (!tokens) return undefined;
  const source = value.source === "device-code"
    || value.source === "codex-cli-import"
    || value.source === "refresh"
    ? value.source
    : "codex-cli-import";
  return {
    tokens,
    last_refresh: readString(value.last_refresh) || new Date(0).toISOString(),
    auth_mode: "chatgpt",
    source,
  };
}

function normalizeTokens(value: unknown): CodexTokenSet | undefined {
  if (!isRecord(value)) return undefined;
  const accessToken = readString(value.access_token);
  const refreshToken = readString(value.refresh_token);
  if (!accessToken || !refreshToken) return undefined;
  const idToken = readString(value.id_token);
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    ...(idToken ? { id_token: idToken } : {}),
  };
}

function tokenEndpointError(
  response: Response,
  payload: Record<string, unknown>,
  fallback: string,
): CodexAuthError {
  const nested = isRecord(payload.error) ? payload.error : undefined;
  const code = readString(nested?.code)
    || readString(nested?.type)
    || readString(payload.error)
    || (response.status === 429 ? "codex_rate_limited" : "codex_oauth_failed");
  const detail = readString(nested?.message)
    || readString(payload.error_description)
    || readString(payload.message);
  const reloginRequired = response.status === 401
    || response.status === 403
    || code === "invalid_grant"
    || code === "invalid_token"
    || code === "refresh_token_reused";
  return new CodexAuthError(
    detail ? `${fallback}: ${detail}` : `${fallback} with HTTP ${response.status}.`,
    { code, status: response.status, reloginRequired },
  );
}

function isDeviceCodePending(payload: Record<string, unknown>): boolean {
  const nested = isRecord(payload.error) ? payload.error : undefined;
  const code = readString(nested?.code)
    || readString(nested?.type)
    || readString(payload.error)
    || readString(payload.code);
  return code === "authorization_pending" || code === "device_code_pending";
}

function readRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function authEndpointError(
  response: Response,
  payload: Record<string, unknown>,
  fallback: string,
  defaultCode: string,
): CodexAuthError {
  const nested = isRecord(payload.error) ? payload.error : undefined;
  const detail = readString(payload.error_description)
    || readString(payload.message)
    || readString(nested?.message);
  const code = readString(nested?.code)
    || readString(nested?.type)
    || readString(payload.error)
    || readString(payload.code)
    || (response.status === 429 ? "codex_rate_limited" : defaultCode);
  return new CodexAuthError(
    detail ? `${fallback}: ${detail}` : `${fallback} with HTTP ${response.status}.`,
    {
      code,
      status: response.status,
    },
  );
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return { message: text };
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readPositiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

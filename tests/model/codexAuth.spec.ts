import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  exchangeCodexDeviceAuthorization,
  getPilotDeckAuthFilePath,
  importCodexCliCredentials,
  pollCodexDeviceCode,
  refreshCodexTokens,
  requestCodexDeviceCode,
} from "../../src/model/providers/codex/auth.js";
import {
  codexAccessTokenExpiresAt,
  isCodexAccessTokenExpiring,
} from "../../src/model/providers/codex/jwt.js";
import {
  CODEX_DEVICE_CODE_URL,
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_DEVICE_VERIFICATION_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
} from "../../src/model/providers/codex/constants.js";

test("treats malformed and missing-exp Codex access tokens as expiring", () => {
  const now = Date.now();
  assert.equal(codexAccessTokenExpiresAt("not-a-jwt"), undefined);
  assert.equal(isCodexAccessTokenExpiring("not-a-jwt", 0, now), true);
  assert.equal(isCodexAccessTokenExpiring(jwt({}), 0, now), true);
  assert.equal(isCodexAccessTokenExpiring(jwt({ exp: "later" }), 0, now), true);
  assert.equal(
    isCodexAccessTokenExpiring(jwt({ exp: Math.floor(now / 1000) + 3600 }), 0, now),
    false,
  );
});

test("imports Codex CLI credentials into PilotDeck's private auth store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-codex-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pilotHome = join(root, "pilotdeck");
  const codexHome = join(root, "codex");
  const env = { ...process.env, PILOT_HOME: pilotHome, CODEX_HOME: codexHome };
  const now = Date.now();
  const accessToken = jwt({
    exp: Math.floor(now / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_import" },
  });
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "auth.json"), JSON.stringify({
    tokens: {
      access_token: accessToken,
      refresh_token: "refresh-import",
      id_token: "id-import",
    },
  }));

  const credentials = await importCodexCliCredentials({ env, now: () => now });

  assert.deepEqual(credentials, {
    accessToken,
    accountId: "acct_import",
    expiresAt: (Math.floor(now / 1000) + 3600) * 1000,
    source: "codex-cli-import",
  });
  const authPath = getPilotDeckAuthFilePath(env);
  const stored = JSON.parse(await readFile(authPath, "utf8"));
  assert.equal(stored.providers.codex.tokens.access_token, accessToken);
  assert.equal(stored.providers.codex.tokens.refresh_token, "refresh-import");
  assert.equal((await stat(authPath)).mode & 0o777, 0o600);
});

test("only treats recognized or empty device polling errors as pending", async () => {
  const device = { userCode: "ABCD-EFGH", deviceAuthId: "device-auth" };
  for (const [status, payload] of [
    [403, { error: "authorization_pending" }],
    [404, {}],
  ] as const) {
    assert.deepEqual(await pollCodexDeviceCode(device, {
      fetch: (async () => jsonResponse(payload, status)) as typeof fetch,
    }), { status: "pending" });
  }

  for (const [status, payload, code] of [
    [403, { error: "access_denied", error_description: "User denied access" }, "access_denied"],
    [404, { error: { code: "expired_token", message: "Device code expired" } }, "expired_token"],
  ] as const) {
    await assert.rejects(
      pollCodexDeviceCode(device, {
        fetch: (async () => jsonResponse(payload, status)) as typeof fetch,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, code);
        assert.match((error as Error).message, /denied|expired/i);
        return true;
      },
    );
  }
});

test("uses Hermes-compatible refresh and device authorization requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-codex-device-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const accessToken = jwt({
    exp: Math.floor(now / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_device" },
  });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let pollCount = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === CODEX_DEVICE_CODE_URL) {
      return jsonResponse({
        user_code: "ABCD-EFGH",
        device_auth_id: "device-auth",
        interval: 1,
      });
    }
    if (url === CODEX_DEVICE_TOKEN_URL) {
      pollCount += 1;
      return pollCount === 1
        ? jsonResponse({}, 403)
        : jsonResponse({
            authorization_code: "authorization-code",
            code_verifier: "code-verifier",
          });
    }
    if (url === CODEX_OAUTH_TOKEN_URL) {
      const body = new URLSearchParams(String(init?.body));
      if (body.get("grant_type") === "refresh_token") {
        return jsonResponse({
          access_token: accessToken,
          refresh_token: "refresh-rotated",
        });
      }
      return jsonResponse({
        access_token: accessToken,
        refresh_token: "refresh-device",
      });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;

  const refreshed = await refreshCodexTokens({
    access_token: "old-access",
    refresh_token: "old-refresh",
  }, { fetch: fetchImpl });
  assert.equal(refreshed.refresh_token, "refresh-rotated");
  const refreshBody = new URLSearchParams(String(calls[0].init?.body));
  assert.equal(calls[0].url, CODEX_OAUTH_TOKEN_URL);
  assert.equal(refreshBody.get("grant_type"), "refresh_token");
  assert.equal(refreshBody.get("refresh_token"), "old-refresh");
  assert.equal(refreshBody.get("client_id"), CODEX_OAUTH_CLIENT_ID);

  const device = await requestCodexDeviceCode({ fetch: fetchImpl });
  assert.equal(device.verificationUrl, CODEX_DEVICE_VERIFICATION_URL);
  assert.equal(device.intervalMs, 1_000);
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    client_id: CODEX_OAUTH_CLIENT_ID,
  });

  assert.deepEqual(
    await pollCodexDeviceCode(device, { fetch: fetchImpl }),
    { status: "pending" },
  );
  const authorized = await pollCodexDeviceCode(device, { fetch: fetchImpl });
  assert.deepEqual(authorized, {
    status: "authorized",
    authorizationCode: "authorization-code",
    codeVerifier: "code-verifier",
  });
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), {
    device_auth_id: "device-auth",
    user_code: "ABCD-EFGH",
  });

  const env = { ...process.env, PILOT_HOME: join(root, "pilotdeck") };
  const credentials = await exchangeCodexDeviceAuthorization(authorized, {
    env,
    fetch: fetchImpl,
    now: () => now,
  });
  assert.equal(credentials.accountId, "acct_device");
  const exchangeBody = new URLSearchParams(String(calls.at(-1)?.init?.body));
  assert.equal(exchangeBody.get("grant_type"), "authorization_code");
  assert.equal(exchangeBody.get("code"), "authorization-code");
  assert.equal(exchangeBody.get("redirect_uri"), CODEX_DEVICE_REDIRECT_URI);
  assert.equal(exchangeBody.get("client_id"), CODEX_OAUTH_CLIENT_ID);
  assert.equal(exchangeBody.get("code_verifier"), "code-verifier");
});

test("honors device authorization polling intervals longer than ten seconds", async () => {
  const device = await requestCodexDeviceCode({
    fetch: (async () => jsonResponse({
      user_code: "ABCD-EFGH",
      device_auth_id: "device-auth",
      interval: 30,
    })) as typeof fetch,
  });

  assert.equal(device.intervalMs, 30_000);
});

test("treats a rate-limited device poll as pending", async () => {
  const result = await pollCodexDeviceCode(
    { userCode: "ABCD-EFGH", deviceAuthId: "device-auth" },
    {
      fetch: (async () => new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "3" },
      })) as typeof fetch,
    },
  );

  assert.deepEqual(result, { status: "pending", retryAfterMs: 3_000 });
});

function jwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.signature`;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

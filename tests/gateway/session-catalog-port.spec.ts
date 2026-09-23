import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { createGateway } from "../../src/gateway/Gateway.js";
import {
  InMemorySessionPersistence,
  InMemorySessionProjectionCheckpointStore,
  type ProjectSessionStorageProvider,
  type SessionCatalogPort,
  type SessionInfo,
} from "../../src/session/index.js";

test("default Gateway session lister consumes the injected catalog port", async () => {
  const calls: unknown[] = [];
  const catalog: SessionCatalogPort = {
    async list(input) {
      calls.push(input);
      return [session("gateway-session")];
    },
  };
  const gateway = createGateway({
    projectStorage: { projectRoot: "/workspace", pilotHome: "/pilot-home" },
    session: { catalog },
  });

  const result = await gateway.listSessions({ limit: 1, cursor: "3" });

  assert.deepEqual(calls, [{
    projectRoot: "/workspace",
    pilotHome: "/pilot-home",
    limit: 1,
    offset: 3,
  }]);
  assert.deepEqual(result, { sessions: [session("gateway-session")], nextCursor: "4" });

  const invalidCursor = await gateway.listSessions({ limit: 1, cursor: "not-a-number" });
  assert.deepEqual(calls[1], {
    projectRoot: "/workspace",
    pilotHome: "/pilot-home",
    limit: 1,
    offset: 0,
  });
  assert.deepEqual(invalidCursor, { sessions: [session("gateway-session")], nextCursor: "1" });
});

test("local Gateway composes its project session lister from the injected catalog port", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-session-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  const calls: unknown[] = [];
  const catalog: SessionCatalogPort = {
    async list(input) {
      calls.push(input);
      return [session("local-session")];
    },
  };
  const local = createLocalGateway({ projectRoot: root, pilotHome: root, sessionCatalog: catalog });
  t.after(() => local.dispose());

  const result = await local.gateway.listSessions({ projectKey: root, limit: 1, cursor: "2" });

  assert.deepEqual(calls, [{
    projectRoot: root,
    pilotHome: root,
    limit: 1,
    offset: 2,
  }]);
  assert.deepEqual(result, { sessions: [session("local-session")], nextCursor: "3" });
});

test("local Gateway forwards the host manager browser provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-manager-browser-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    managerBrowsers: async (input) => ({
      items: [{ browserId: "browser-1", projectKey: input.projectKey, sessionKey: input.sessionKey }],
    }),
  });
  t.after(() => local.dispose());

  assert.deepEqual(await local.gateway.managerBrowsers?.({ projectKey: root, sessionKey: "session-1" }), {
    items: [{ browserId: "browser-1", projectKey: root, sessionKey: "session-1" }],
  });
  assert.ok((await local.gateway.describeServer()).capabilities?.includes("manager_browsers"));
});

test("default Gateway selects the catalog owned by its selected session storage provider", async () => {
  const calls: unknown[] = [];
  const provider: ProjectSessionStorageProvider = {
    create() {
      return {
        persistence: new InMemorySessionPersistence(),
        projectionCheckpointStore: new InMemorySessionProjectionCheckpointStore(),
      };
    },
    catalog: {
      async list(input) {
        calls.push(input);
        return [session("storage-provider-session")];
      },
    },
  };
  const gateway = createGateway({
    projectStorage: {
      projectRoot: "/provider-workspace",
      pilotHome: "/provider-home",
      storageProvider: provider,
    },
  });

  const result = await gateway.listSessions({ limit: 2, cursor: "1" });

  assert.deepEqual(calls, [{
    projectRoot: "/provider-workspace",
    pilotHome: "/provider-home",
    limit: 2,
    offset: 1,
  }]);
  assert.deepEqual(result, { sessions: [session("storage-provider-session")], nextCursor: undefined });
});

test("local Gateway selects the catalog owned by its selected session storage provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-session-storage-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  const calls: unknown[] = [];
  const provider: ProjectSessionStorageProvider = {
    create() {
      return {
        persistence: new InMemorySessionPersistence(),
        projectionCheckpointStore: new InMemorySessionProjectionCheckpointStore(),
      };
    },
    catalog: {
      async list(input) {
        calls.push(input);
        return [session("local-storage-provider-session")];
      },
    },
  };
  const local = createLocalGateway({ projectRoot: root, pilotHome: root, storageProvider: provider });
  t.after(() => local.dispose());

  const result = await local.gateway.listSessions({ projectKey: root, limit: 3 });

  assert.deepEqual(calls, [{ projectRoot: root, pilotHome: root, limit: 3, offset: 0 }]);
  assert.deepEqual(result, { sessions: [session("local-storage-provider-session")], nextCursor: undefined });
});

function session(sessionId: string): SessionInfo {
  return {
    sessionId,
    summary: sessionId,
    lastModified: 1,
  };
}

const TEST_CONFIG = `
schemaVersion: 1
agent:
  model: test/test
  maxContextTokens: 8192
  maxOutputTokens: 1024
model:
  providers:
    test:
      protocol: openai
      url: http://127.0.0.1:1
      apiKey: test-only
      models:
        test:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 8192
            maxOutputTokens: 1024
`;

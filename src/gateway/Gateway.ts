import { randomUUID } from "node:crypto";
import { createAgentSessionWithStorageAsync, type CreateAgentSessionOptions } from "../agent/index.js";
import {
  createProjectSessionCatalog,
  type SessionCatalogPort,
} from "../session/index.js";
import type { ProjectSessionPersistenceProvider } from "../session/storage/ProjectSessionStorageProvider.js";
import { InProcessGateway } from "./client/InProcessGateway.js";
import { createGatewaySessionCatalogConsumer } from "./GatewaySessionCatalog.js";
import {
  SessionRouter,
  type GatewaySessionFactory,
  type GatewaySessionSetup,
  type SessionRouterOptions,
} from "./SessionRouter.js";
import type { Gateway, GatewayCronController, GatewayServerInfo } from "./protocol/types.js";
import type { ModelInvocationLogSink } from "../storage/legalDataStorage.js";

export type GatewayProjectStorageOptions = {
  projectRoot: string;
  pilotHome: string;
  /** Optional application-selected project-session persistence/cache provider. */
  storageProvider?: ProjectSessionPersistenceProvider;
};

export type CreateGatewayOptions = {
  invocationLogSink?: ModelInvocationLogSink;
  storageConfigVersion?: string;
  session?: {
    create?: GatewaySessionFactory;
    setup?: GatewaySessionSetup;
    list?: SessionRouterOptions["listSessions"];
    /** Read-only durable-session catalog used by the default list consumer. */
    catalog?: SessionCatalogPort;
  };
  agent?: Omit<CreateAgentSessionOptions, "sessionId" | "projectStorage">;
  projectStorage?: GatewayProjectStorageOptions;
  idleSessionTimeoutMs?: number;
  now?: () => Date;
  uuid?: () => string;
  serverInfo?: Partial<GatewayServerInfo>;
  cron?: GatewayCronController;
};

export function createGateway(options: CreateGatewayOptions): Gateway {
  const now = options.now ?? (() => new Date());
  const uuid = options.uuid ?? randomUUID;
  const createSession = options.session?.create ?? createDefaultSessionFactory(options);
  const listSessions = options.session?.list ?? createDefaultSessionLister(options);
  const router = new SessionRouter({
    createSession,
    setupSession: options.session?.setup,
    listSessions,
    idleSessionTimeoutMs: options.idleSessionTimeoutMs,
    now,
  });

  return new InProcessGateway(router, {
    invocationLogSink: options.invocationLogSink,
    storageConfigVersion: options.storageConfigVersion,
    now,
    uuid,
    serverInfo: {
      mode: "in_process",
      projectKey: options.projectStorage?.projectRoot,
      ...options.serverInfo,
    },
    cron: options.cron,
  });
}

function createDefaultSessionFactory(options: CreateGatewayOptions): GatewaySessionFactory {
  return async ({ sessionKey }) => {
    if (!options.agent) {
      throw new Error("createGateway requires either session.create or agent options.");
    }

    const { handle } = await createAgentSessionWithStorageAsync({
      ...options.agent,
      sessionId: sessionKey,
      projectStorage: options.projectStorage,
    });
    return handle;
  };
}

function createDefaultSessionLister(options: CreateGatewayOptions): SessionRouterOptions["listSessions"] {
  if (!options.projectStorage) {
    return async () => ({ sessions: [] });
  }

  const catalog = options.session?.catalog ?? createProjectSessionCatalog({
    storageProvider: options.projectStorage.storageProvider,
  });
  return createGatewaySessionCatalogConsumer({
    catalog,
    resolveStorage: () => options.projectStorage!,
  });
}

export type { Gateway, GatewayServerInfo };
export { InProcessGateway, SessionRouter };

import { randomUUID } from "node:crypto";
import { createAgentSession, type AgentSession, type CreateAgentSessionOptions } from "../agent/index.js";
import type { SessionInfo } from "../session/index.js";
import { listProjectSessions } from "../session/index.js";
import { InProcessGateway } from "./client/InProcessGateway.js";
import { SessionRouter, type GatewaySessionFactory, type SessionRouterOptions } from "./SessionRouter.js";
import type { Gateway, GatewayCronController, GatewayServerInfo } from "./protocol/types.js";

export type GatewayProjectStorageOptions = {
  projectRoot: string;
  pilotHome: string;
};

export type CreateGatewayOptions = {
  session?: {
    create?: GatewaySessionFactory;
    list?: SessionRouterOptions["listSessions"];
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
    listSessions,
    idleSessionTimeoutMs: options.idleSessionTimeoutMs,
    now,
  });

  return new InProcessGateway(router, {
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

    return createAgentSession({
      ...options.agent,
      sessionId: sessionKey,
      projectStorage: options.projectStorage,
    });
  };
}

function createDefaultSessionLister(options: CreateGatewayOptions): SessionRouterOptions["listSessions"] {
  if (!options.projectStorage) {
    return async () => ({ sessions: [] });
  }

  return async ({ limit, cursor }) => {
    const offset = cursor ? Number.parseInt(cursor, 10) : 0;
    const sessions = await listProjectSessions({
      ...options.projectStorage!,
      limit,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    const nextOffset = (Number.isFinite(offset) ? offset : 0) + sessions.length;
    return {
      sessions: sessions.map(toGatewaySessionInfo),
      nextCursor: limit && sessions.length === limit ? String(nextOffset) : undefined,
    };
  };
}

function toGatewaySessionInfo(session: SessionInfo): SessionInfo {
  return session;
}

export type { Gateway, GatewayServerInfo };
export { InProcessGateway, SessionRouter };

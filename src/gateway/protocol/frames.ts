import type { GatewayEvent, GatewayServerInfo } from "./types.js";

export type GatewayWsClientName = "cli" | "tui" | "web" | "feishu" | "test";

export type WsHelloFrame = {
  type: "hello";
  protocolVersion: string;
  clientName: GatewayWsClientName;
  clientVersion: string;
  token: string;
};

export type WsHelloOk = {
  type: "hello_ok";
  protocolVersion: string;
  serverVersion: string;
  serverInfo: GatewayServerInfo;
};

export type WsGatewayMethod =
  | "submit_turn"
  | "abort_turn"
  | "list_sessions"
  | "resume_session"
  | "new_session"
  | "close_session"
  | "describe_server"
  | "active_turn_snapshot"
  | "cron_create"
  | "cron_list"
  | "cron_delete"
  | "cron_stop"
  | "cron_run_now"
  | "elicitation_respond"
  | "permission_decide"
  | "grant_session_permission"
  | "read_session_messages"
  | "read_subagent_messages"
  | "fork_session"
  | "list_projects"
  | "describe_project"
  | "reload_config"
  | "reload_extensions"
  | "skill_list"
  | "skill_read"
  | "skill_write"
  | "skill_create"
  | "skill_delete"
  | "skill_import"
  | "skill_validate"
  | "skill_scan"
  | "always_on_apply"
  | "always_on_rerun_plan";

export type WsRequestFrame = {
  type: "request";
  id: string;
  method: WsGatewayMethod;
  params: unknown;
};

export type WsResponseFrame =
  | {
      type: "response";
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "response";
      id: string;
      ok: false;
      error: { code: string; message: string };
    };

export type WsEventFrame = {
  type: "event";
  id: string;
  seq: number;
  final: boolean;
  event: GatewayEvent;
};

/**
 * Server-pushed notification (no request id). Sent after `hello_ok` to
 * inform connected clients about asynchronous state changes (e.g. a
 * config reload triggered by a file-system watcher or another client).
 */
export type WsNotificationFrame = {
  type: "notification";
  name: string;
  payload?: unknown;
};

export type WsGatewayFrame = WsHelloFrame | WsHelloOk | WsRequestFrame | WsResponseFrame | WsEventFrame | WsNotificationFrame;

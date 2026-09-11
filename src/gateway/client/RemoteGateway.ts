import type {
  AlwaysOnApplyInput,
  AlwaysOnApplyResult,
  AlwaysOnRerunPlanInput,
  AlwaysOnRerunPlanResult,
  Gateway,
  GatewayElicitationResponseInput,
  GatewayUserDialogResponseInput,
  GatewayListUserDialogsInput,
  GatewayListUserDialogsResult,
  GatewayUserDialogClaimInput,
  GatewayUserDialogClaimResult,
  GatewayUserDialogReleaseInput,
  GatewayUserDialogReleaseResult,
  GatewayEvent,
  GatewayPermissionDecisionInput,
  GatewayServerInfo,
  GatewaySubmitTurnInput,
  GatewayCancelSteerInput,
  GatewayCancelSteerResult,
  GatewaySteerTurnInput,
  GatewaySteerTurnResult,
  ProjectFilesListInput,
  ProjectFilesListResult,
  CommandsListInput,
  CommandsListResult,
  ModelCatalogListInput,
  ModelCatalogListResult,
  SessionModelInput,
  SessionModelSetInput,
  SessionModelResult,
  ListSessionsInput,
  ListSessionsResult,
  NewSessionInput,
  GatewayExportSessionTranscriptInput,
  GatewayRestoreSessionTranscriptInput,
  GatewayRestoreSessionTranscriptResult,
  GatewaySessionTranscriptArchive,
  PrepareWeixinLoginResult,
  ReloadConfigResult,
  ReloadExtensionsInput,
  ReloadExtensionsResult,
  WebDescribeProjectInput,
  WebListProjectsResult,
  WebProjectSummary,
  WebReadSessionMessagesInput,
  WebReadSessionMessagesResult,
  WebReadSubagentMessagesInput,
  WebReadSubagentMessagesResult,
  WebForkSessionInput,
  WebForkSessionResult,
  WebReplaceLastTurnInput,
  WebReplaceLastTurnResult,
  WebFinalizeLastTurnReplacementInput,
  WebFinalizeLastTurnReplacementResult,
} from "../protocol/types.js";
import type {
  SkillAddressInput,
  SkillCreateInput,
  SkillCreateResult,
  SkillDeleteInput,
  SkillDeleteResult,
  SkillImportInput,
  SkillImportResult,
  SkillReadResult,
  SkillScanInput,
  SkillScanResult,
  SkillValidateInput,
  SkillValidationResult,
  SkillWriteInput,
  SkillWriteResult,
  SkillsListInput,
  SkillsListResult,
} from "../../extension/skills/types.js";
import type {
  CronCreateInput,
  CronCreateResult,
  CronDeleteInput,
  CronDeleteResult,
  CronListInput,
  CronListResult,
  CronRunNowInput,
  CronRunNowResult,
  CronStopInput,
  CronStopResult,
  CronUpdateInput,
  CronUpdateResult,
} from "../../cron/protocol/types.js";
import { GatewayWsClient, type GatewayWsNotificationHandler } from "./GatewayWsClient.js";
import { parseReloadConfigResult } from "../protocol/reloadConfigResult.js";

export class RemoteGateway implements Gateway {
  constructor(private readonly client: GatewayWsClient) {}

  onNotification(handler: GatewayWsNotificationHandler): void {
    this.client.onNotification(handler);
  }

  submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
    return this.client.stream("submit_turn", input);
  }

  async steerTurn(input: GatewaySteerTurnInput): Promise<GatewaySteerTurnResult> {
    return (await this.client.request("steer_turn", input)) as GatewaySteerTurnResult;
  }

  async cancelSteer(input: GatewayCancelSteerInput): Promise<GatewayCancelSteerResult> {
    return (await this.client.request("cancel_steer", input)) as GatewayCancelSteerResult;
  }

  async abortTurn(input: { sessionKey: string; runId?: string; reason?: string }): Promise<void> {
    await this.client.request("abort_turn", input);
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsResult> {
    return (await this.client.request("list_sessions", input)) as ListSessionsResult;
  }

  async resumeSession(input: { sessionKey: string }): Promise<{ sessionKey: string }> {
    return (await this.client.request("resume_session", input)) as { sessionKey: string };
  }

  async newSession(input: NewSessionInput): Promise<{ sessionKey: string }> {
    return (await this.client.request("new_session", input)) as { sessionKey: string };
  }

  async closeSession(input: { sessionKey: string; reason?: string }): Promise<void> {
    await this.client.request("close_session", input);
  }

  async deleteSession(input: { sessionKey: string; projectKey?: string }): Promise<void> {
    await this.client.request("delete_session", input);
  }

  async exportSessionTranscript(input: GatewayExportSessionTranscriptInput): Promise<GatewaySessionTranscriptArchive> {
    return (await this.client.request("export_session_transcript", input)) as GatewaySessionTranscriptArchive;
  }

  async restoreSessionTranscript(
    input: GatewayRestoreSessionTranscriptInput,
  ): Promise<GatewayRestoreSessionTranscriptResult> {
    return (await this.client.request("restore_session_transcript", input)) as GatewayRestoreSessionTranscriptResult;
  }

  async renameSession(input: import("../protocol/types.js").GatewaySessionMetadataInput): Promise<{ updated: boolean }> {
    return (await this.client.request("rename_session", input)) as { updated: boolean };
  }

  async tagSession(input: import("../protocol/types.js").GatewaySessionMetadataInput): Promise<{ updated: boolean }> {
    return (await this.client.request("tag_session", input)) as { updated: boolean };
  }

  async recordAgentStatusMessage(input: import("../protocol/types.js").GatewayRecordAgentStatusMessageInput): Promise<{ recorded: boolean }> {
    return (await this.client.request("record_agent_status_message", input)) as { recorded: boolean };
  }

  async describeServer(): Promise<GatewayServerInfo> {
    return (await this.client.request("describe_server", {})) as GatewayServerInfo;
  }

  async projectFilesList(input: ProjectFilesListInput): Promise<ProjectFilesListResult> {
    return (await this.client.request("project_files_list", input)) as ProjectFilesListResult;
  }

  async commandsList(input: CommandsListInput): Promise<CommandsListResult> {
    return (await this.client.request("commands_list", input)) as CommandsListResult;
  }

  async modelCatalogList(input: ModelCatalogListInput): Promise<ModelCatalogListResult> {
    return (await this.client.request("model_catalog_list", input)) as ModelCatalogListResult;
  }

  async sessionModelGet(input: SessionModelInput): Promise<SessionModelResult> {
    return (await this.client.request("session_model_get", input)) as SessionModelResult;
  }

  async sessionModelSet(input: SessionModelSetInput): Promise<SessionModelResult> {
    return (await this.client.request("session_model_set", input)) as SessionModelResult;
  }

  async sessionModelClear(input: SessionModelInput): Promise<void> {
    await this.client.request("session_model_clear", input);
  }

  async supportedAgents(): Promise<import("../protocol/types.js").GatewaySupportedAgentsResult> {
    return (await this.client.request("supported_agents", {})) as import("../protocol/types.js").GatewaySupportedAgentsResult;
  }

  async mcpServerStatus(input: import("../protocol/types.js").GatewayMcpServerStatusInput): Promise<import("../protocol/types.js").GatewayMcpServerStatusResult> {
    return (await this.client.request("mcp_server_status", input)) as import("../protocol/types.js").GatewayMcpServerStatusResult;
  }

  async setMcpServers(input: import("../protocol/types.js").GatewaySetMcpServersInput): Promise<import("../protocol/types.js").GatewayMcpSetServersResult> {
    return (await this.client.request("set_mcp_servers", input)) as import("../protocol/types.js").GatewayMcpSetServersResult;
  }

  async reconnectMcpServer(input: import("../protocol/types.js").GatewayMcpServerControlInput): Promise<void> {
    await this.client.request("mcp_server_reconnect", input);
  }

  async toggleMcpServer(input: import("../protocol/types.js").GatewayMcpServerToggleInput): Promise<void> {
    await this.client.request("mcp_server_toggle", input);
  }

  async setMcpPermissionModeOverride(
    input: import("../protocol/types.js").GatewayMcpPermissionModeOverrideInput,
  ): Promise<import("../protocol/types.js").GatewayMcpPermissionModeOverrideResult> {
    return (await this.client.request("set_mcp_permission_mode_override", input)) as import("../protocol/types.js").GatewayMcpPermissionModeOverrideResult;
  }

  async projectFileRead(input: import("../protocol/types.js").GatewayProjectFileReadInput): Promise<import("../protocol/types.js").GatewayProjectFileReadResult | null> {
    return (await this.client.request("project_file_read", input)) as import("../protocol/types.js").GatewayProjectFileReadResult | null;
  }

  async setPermissionMode(input: import("../protocol/types.js").GatewaySetPermissionModeInput): Promise<{ applied: boolean }> {
    return (await this.client.request("set_permission_mode", input)) as { applied: boolean };
  }

  async applyFlagSettings(
    input: import("../protocol/types.js").GatewayApplyFlagSettingsInput,
  ): Promise<import("../protocol/types.js").GatewayApplyFlagSettingsResult> {
    return (await this.client.request("apply_flag_settings", input)) as import("../protocol/types.js").GatewayApplyFlagSettingsResult;
  }

  async updateSettings(
    input: import("../protocol/types.js").GatewayUpdateSettingsInput,
  ): Promise<import("../protocol/types.js").GatewayUpdateSettingsResult> {
    return (await this.client.request("update_settings", input)) as import("../protocol/types.js").GatewayUpdateSettingsResult;
  }

  async resolveSettings(): Promise<import("../protocol/types.js").GatewayResolvedSettingsResult> {
    return (await this.client.request("resolve_settings", {})) as import("../protocol/types.js").GatewayResolvedSettingsResult;
  }

  async setSessionThinking(input: import("../protocol/types.js").GatewaySetSessionThinkingInput): Promise<{ applied: boolean }> {
    return (await this.client.request("set_session_thinking", input)) as { applied: boolean };
  }

  async outputStylesList(input: import("../protocol/types.js").GatewayOutputStylesListInput): Promise<import("../protocol/types.js").GatewayOutputStylesListResult> {
    return (await this.client.request("output_styles_list", input)) as import("../protocol/types.js").GatewayOutputStylesListResult;
  }

  async setOutputStyle(input: import("../protocol/types.js").GatewaySetOutputStyleInput): Promise<import("../protocol/types.js").GatewaySetOutputStyleResult> {
    return (await this.client.request("set_output_style", input)) as import("../protocol/types.js").GatewaySetOutputStyleResult;
  }

  async reloadOutputStyles(input: import("../protocol/types.js").GatewayReloadOutputStylesInput = {}): Promise<import("../protocol/types.js").GatewayReloadOutputStylesResult> {
    return (await this.client.request("reload_output_styles", input)) as import("../protocol/types.js").GatewayReloadOutputStylesResult;
  }

  async usageSnapshot(input: import("../protocol/types.js").GatewayUsageSnapshotInput): Promise<import("../protocol/types.js").GatewayUsageSnapshotResult> {
    return (await this.client.request("usage_snapshot", input)) as import("../protocol/types.js").GatewayUsageSnapshotResult;
  }

  async modelUsageSnapshot(input: import("../protocol/types.js").GatewayModelUsageSnapshotInput): Promise<import("../protocol/types.js").GatewayModelUsageSnapshotResult> {
    return (await this.client.request("model_usage_snapshot", input)) as import("../protocol/types.js").GatewayModelUsageSnapshotResult;
  }

  async rewindFiles(input: import("../protocol/types.js").GatewayRewindFilesInput): Promise<import("../protocol/types.js").GatewayRewindFilesResult> {
    return (await this.client.request("rewind_files", input)) as import("../protocol/types.js").GatewayRewindFilesResult;
  }

  async stopBackgroundTask(input: import("../protocol/types.js").GatewayStopBackgroundTaskInput): Promise<import("../protocol/types.js").GatewayStopBackgroundTaskResult> {
    return (await this.client.request("background_task_stop", input)) as import("../protocol/types.js").GatewayStopBackgroundTaskResult;
  }

  async backgroundTasks(input: import("../protocol/types.js").GatewayBackgroundTasksInput): Promise<import("../protocol/types.js").GatewayBackgroundTasksResult> {
    return (await this.client.request("background_tasks", input)) as import("../protocol/types.js").GatewayBackgroundTasksResult;
  }

  async submitAsyncHookResult(
    input: import("../protocol/types.js").GatewayAsyncHookResultInput,
  ): Promise<import("../protocol/types.js").GatewayAsyncHookResult> {
    return (await this.client.request("hook_async_result", input)) as import("../protocol/types.js").GatewayAsyncHookResult;
  }

  async seedReadState(input: import("../protocol/types.js").GatewaySeedReadStateInput): Promise<import("../protocol/types.js").GatewaySeedReadStateResult> {
    return (await this.client.request("seed_read_state", input)) as import("../protocol/types.js").GatewaySeedReadStateResult;
  }

  async getActiveTurnSnapshot(input: import("../protocol/types.js").GatewayActiveTurnSnapshotInput): Promise<import("../protocol/types.js").GatewayActiveTurnSnapshot> {
    return (await this.client.request("active_turn_snapshot", input)) as import("../protocol/types.js").GatewayActiveTurnSnapshot;
  }

  async cronCreate(input: CronCreateInput): Promise<CronCreateResult> {
    return (await this.client.request("cron_create", input)) as CronCreateResult;
  }

  async cronList(input: CronListInput): Promise<CronListResult> {
    return (await this.client.request("cron_list", input)) as CronListResult;
  }

  async cronUpdate(input: CronUpdateInput): Promise<CronUpdateResult> {
    return (await this.client.request("cron_update", input)) as CronUpdateResult;
  }

  async cronDelete(input: CronDeleteInput): Promise<CronDeleteResult> {
    return (await this.client.request("cron_delete", input)) as CronDeleteResult;
  }

  async cronStop(input: CronStopInput): Promise<CronStopResult> {
    return (await this.client.request("cron_stop", input)) as CronStopResult;
  }

  async cronRunNow(input: CronRunNowInput): Promise<CronRunNowResult> {
    return (await this.client.request("cron_run_now", input)) as CronRunNowResult;
  }

  async respondElicitation(input: GatewayElicitationResponseInput): Promise<{ delivered: boolean }> {
    return (await this.client.request("elicitation_respond", input)) as { delivered: boolean };
  }

  async respondUserDialog(input: GatewayUserDialogResponseInput): Promise<{
    delivered: boolean;
    recovered?: true;
    reason?: "gateway_restarted";
  }> {
    return (await this.client.request("user_dialog_respond", input)) as {
      delivered: boolean;
      recovered?: true;
      reason?: "gateway_restarted";
    };
  }

  async listUserDialogs(input: GatewayListUserDialogsInput): Promise<GatewayListUserDialogsResult> {
    return (await this.client.request("user_dialog_list", input)) as GatewayListUserDialogsResult;
  }

  async claimUserDialog(input: GatewayUserDialogClaimInput): Promise<GatewayUserDialogClaimResult> {
    return (await this.client.request("user_dialog_claim", input)) as GatewayUserDialogClaimResult;
  }

  async releaseUserDialog(input: GatewayUserDialogReleaseInput): Promise<GatewayUserDialogReleaseResult> {
    return (await this.client.request("user_dialog_release", input)) as GatewayUserDialogReleaseResult;
  }

  async permissionDecide(input: GatewayPermissionDecisionInput): Promise<{ delivered: boolean }> {
    return (await this.client.request("permission_decide", input)) as { delivered: boolean };
  }

  async grantSessionPermission(input: import("../protocol/types.js").GatewaySessionPermissionGrantInput): Promise<{ granted: boolean; entry?: string }> {
    return (await this.client.request("grant_session_permission", input)) as { granted: boolean; entry?: string };
  }

  async readSessionMessages(input: WebReadSessionMessagesInput): Promise<WebReadSessionMessagesResult> {
    return (await this.client.request("read_session_messages", input)) as WebReadSessionMessagesResult;
  }

  async readSubagentMessages(input: WebReadSubagentMessagesInput): Promise<WebReadSubagentMessagesResult> {
    return (await this.client.request("read_subagent_messages", input)) as WebReadSubagentMessagesResult;
  }

  async forkSession(input: WebForkSessionInput): Promise<WebForkSessionResult> {
    return (await this.client.request("fork_session", input)) as WebForkSessionResult;
  }

  async replaceLastTurn(input: WebReplaceLastTurnInput): Promise<WebReplaceLastTurnResult> {
    return (await this.client.request("replace_last_turn", input)) as WebReplaceLastTurnResult;
  }

  async finalizeLastTurnReplacement(
    input: WebFinalizeLastTurnReplacementInput,
  ): Promise<WebFinalizeLastTurnReplacementResult> {
    return (await this.client.request(
      "finalize_last_turn_replacement",
      input,
    )) as WebFinalizeLastTurnReplacementResult;
  }

  async listProjects(): Promise<WebListProjectsResult> {
    return (await this.client.request("list_projects", {})) as WebListProjectsResult;
  }

  async describeProject(input: WebDescribeProjectInput): Promise<WebProjectSummary> {
    return (await this.client.request("describe_project", input)) as WebProjectSummary;
  }

  async reloadConfig(): Promise<ReloadConfigResult> {
    return parseReloadConfigResult(await this.client.request("reload_config", {}));
  }

  async prepareWeixinLogin(): Promise<PrepareWeixinLoginResult> {
    return (await this.client.request("prepare_weixin_login", {})) as PrepareWeixinLoginResult;
  }

  async reloadExtensions(input: ReloadExtensionsInput = {}): Promise<ReloadExtensionsResult> {
    return (await this.client.request("reload_extensions", input)) as ReloadExtensionsResult;
  }

  async skillsList(input: SkillsListInput): Promise<SkillsListResult> {
    return (await this.client.request("skill_list", input)) as SkillsListResult;
  }

  async skillRead(input: SkillAddressInput): Promise<SkillReadResult> {
    return (await this.client.request("skill_read", input)) as SkillReadResult;
  }

  async skillWrite(input: SkillWriteInput): Promise<SkillWriteResult> {
    return (await this.client.request("skill_write", input)) as SkillWriteResult;
  }

  async skillCreate(input: SkillCreateInput): Promise<SkillCreateResult> {
    return (await this.client.request("skill_create", input)) as SkillCreateResult;
  }

  async skillDelete(input: SkillDeleteInput): Promise<SkillDeleteResult> {
    return (await this.client.request("skill_delete", input)) as SkillDeleteResult;
  }

  async skillImport(input: SkillImportInput): Promise<SkillImportResult> {
    return (await this.client.request("skill_import", input)) as SkillImportResult;
  }

  async skillValidate(input: SkillValidateInput): Promise<SkillValidationResult> {
    return (await this.client.request("skill_validate", input)) as SkillValidationResult;
  }

  async skillScan(input: SkillScanInput): Promise<SkillScanResult> {
    return (await this.client.request("skill_scan", input)) as SkillScanResult;
  }

  async alwaysOnApply(input: AlwaysOnApplyInput): Promise<AlwaysOnApplyResult> {
    return (await this.client.request("always_on_apply", input)) as AlwaysOnApplyResult;
  }

  async alwaysOnRerunPlan(input: AlwaysOnRerunPlanInput): Promise<AlwaysOnRerunPlanResult> {
    return (await this.client.request("always_on_rerun_plan", input)) as AlwaysOnRerunPlanResult;
  }
}

export async function createRemoteGateway(options: ConstructorParameters<typeof GatewayWsClient>[0]): Promise<RemoteGateway> {
  const client = new GatewayWsClient(options);
  await client.connect();
  return new RemoteGateway(client);
}

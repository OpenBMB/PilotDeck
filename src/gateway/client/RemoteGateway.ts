import type {
  AlwaysOnApplyInput,
  AlwaysOnApplyResult,
  AlwaysOnRerunPlanInput,
  AlwaysOnRerunPlanResult,
  Gateway,
  GatewayElicitationResponseInput,
  GatewayEvent,
  GatewayPermissionDecisionInput,
  GatewayServerInfo,
  GatewaySubmitTurnInput,
  ListSessionsInput,
  ListSessionsResult,
  NewSessionInput,
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
  SkillEvolutionApplyInput,
  SkillEvolutionApplyResult,
  SkillEvolutionProposeInput,
  SkillEvolutionProposeResult,
  SkillEvolutionRecordInput,
  SkillEvolutionRecordResult,
  SkillEvolutionRollbackInput,
  SkillEvolutionRollbackResult,
  SkillEvolutionStatusInput,
  SkillEvolutionStatusResult,
} from "../../extension/skills/skillEvolutionTypes.js";
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

  async recordAgentStatusMessage(input: import("../protocol/types.js").GatewayRecordAgentStatusMessageInput): Promise<{ recorded: boolean }> {
    return (await this.client.request("record_agent_status_message", input)) as { recorded: boolean };
  }

  async describeServer(): Promise<GatewayServerInfo> {
    return (await this.client.request("describe_server", {})) as GatewayServerInfo;
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

  async listProjects(): Promise<WebListProjectsResult> {
    return (await this.client.request("list_projects", {})) as WebListProjectsResult;
  }

  async describeProject(input: WebDescribeProjectInput): Promise<WebProjectSummary> {
    return (await this.client.request("describe_project", input)) as WebProjectSummary;
  }

  async reloadConfig(): Promise<ReloadConfigResult> {
    return parseReloadConfigResult(await this.client.request("reload_config", {}));
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

  async skillEvoStatus(input: SkillEvolutionStatusInput): Promise<SkillEvolutionStatusResult> {
    return (await this.client.request("skill_evo_status", input)) as SkillEvolutionStatusResult;
  }

  async skillEvoRecord(input: SkillEvolutionRecordInput): Promise<SkillEvolutionRecordResult> {
    return (await this.client.request("skill_evo_record", input)) as SkillEvolutionRecordResult;
  }

  async skillEvoPropose(input: SkillEvolutionProposeInput): Promise<SkillEvolutionProposeResult> {
    return (await this.client.request("skill_evo_propose", input)) as SkillEvolutionProposeResult;
  }

  async skillEvoApply(input: SkillEvolutionApplyInput): Promise<SkillEvolutionApplyResult> {
    return (await this.client.request("skill_evo_apply", input)) as SkillEvolutionApplyResult;
  }

  async skillEvoRollback(input: SkillEvolutionRollbackInput): Promise<SkillEvolutionRollbackResult> {
    return (await this.client.request("skill_evo_rollback", input)) as SkillEvolutionRollbackResult;
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

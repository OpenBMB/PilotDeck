import type { BackgroundTaskPort } from "../../task/runtime/BackgroundTaskPort.js";
import { createAgentTool, type CreateAgentToolOptions } from "../builtin/agent.js";
import { createAskUserQuestionTool } from "../builtin/askUserQuestion.js";
import { createBashTool, type CreateBashToolOptions } from "../builtin/bash.js";
import { createEditFileTool } from "../builtin/editFile.js";
import { createEditNotebookTool } from "../builtin/editNotebook.js";
import { createExecuteCodeTool, type CreateExecuteCodeToolOptions } from "../builtin/executeCode.js";
import { createGlobTool } from "../builtin/glob.js";
import { createGrepTool } from "../builtin/grep.js";
import { createGetCurrentTimeTool } from "../builtin/getCurrentTime.js";
import { createReadFileTool } from "../builtin/readFile.js";
import { createSendAttachmentTool } from "../builtin/sendAttachment.js";
import { createEnterPlanModeTool, createExitPlanModeTool } from "../builtin/planMode.js";
import { createStructuredOutputTool } from "../builtin/structuredOutput.js";
import { createTodoWriteTool } from "../builtin/todoWrite.js";
import { createLspTool } from "../builtin/lsp.js";
import type { LspServicePort } from "../../lsp/index.js";
import {
  createTaskCreateTool,
  createTaskListTool,
  createTaskOutputTool,
  createTaskStopTool,
  createTaskWaitTool,
} from "../builtin/taskTools.js";
import { createWebFetchTool, type CreateWebFetchToolOptions } from "../builtin/webFetch.js";
import { createWebSearchTool, type CreateWebSearchToolOptions } from "../builtin/webSearch.js";
import { createReadSkillTool, type ReadSkillDeps } from "../builtin/readSkill.js";
import { createWriteFileTool } from "../builtin/writeFile.js";
import { createGoalTools } from "../builtin/goal.js";
import { createNodeFsPort } from "../execution-world/NodeFsPort.js";
import type { FsPort } from "../execution-world/FsPort.js";
import { createNodeSubprocessPort } from "../execution-world/SubprocessPort.js";
import type { SubprocessPort } from "../execution-world/SubprocessPort.js";
import { createNodeShellPort } from "../execution-world/ShellPort.js";
import type { ShellPort } from "../execution-world/ShellPort.js";
import { createNodeExecutionWorkspacePort } from "../execution-world/NodeExecutionWorkspacePort.js";
import type { ExecutionWorkspacePort } from "../execution-world/ExecutionWorkspacePort.js";
import { createNodeCodeRuntimePort } from "../execution-world/NodeCodeRuntimePort.js";
import type { CodeRuntimePort } from "../execution-world/CodeRuntimePort.js";
import { createNodeExecutionTransportPort } from "../execution-world/ExecutionTransportPort.js";
import type { ExecutionTransportPort } from "../execution-world/ExecutionTransportPort.js";
import { createNodeAttachmentDeliveryPort } from "../execution-world/AttachmentDeliveryPort.js";
import type { AttachmentDeliveryPort } from "../execution-world/AttachmentDeliveryPort.js";
import { ToolRegistry } from "./ToolRegistry.js";

export type CreateBuiltinRegistryOptions = {
  /** Optional project-scoped LSP service. When present, registers the `lsp` consumer. */
  lsp?: LspServicePort;
  /** Execution-world filesystem provider used by filesystem tools. */
  fs?: FsPort;
  /** Execution-world subprocess provider used by search consumers. */
  subprocess?: SubprocessPort;
  /** Execution-world shell provider used by the `bash` consumer. */
  shell?: ShellPort;
  /** Private temporary workspace provider used by `execute_code`. */
  executionWorkspace?: ExecutionWorkspacePort;
  /** Code process provider used by `execute_code`. */
  codeRuntime?: CodeRuntimePort;
  /** Private RPC transport provider used by `execute_code`. */
  executionTransport?: ExecutionTransportPort;
  /** Optional sandbox adapter/policy for the `execute_code` consumer. */
  executeCodeSandbox?: NonNullable<CreateExecuteCodeToolOptions["sandbox"]>;
  /** Attachment-delivery provider used by `send_attachment`. */
  attachmentDelivery?: AttachmentDeliveryPort;
  bash?: CreateBashToolOptions;
  /**
   * `web_search` defaults to the GLM/Z.AI provider. Pass `false` to skip
   * registering web_search; pass an options object to select GLM or Tavily
   * and customize apiKey / endpoint.
   */
  webSearch?: CreateWebSearchToolOptions | false;
  /**
   * `agent` subagent tool. **Opt-in** because it requires a model client at
   * execution time — the AgentLoop forwards the loop's model client through
   * `PilotDeckToolRuntimeContext.model`, but stand-alone tool runtimes (e.g.
   * tests) may not have one. Pass `true` (default) to register; pass `false`
   * to skip; pass an options object to customize the subagent presets or
   * lock the provider/model.
   */
  agent?: CreateAgentToolOptions | boolean;
  /** Effective project/session cap used to describe nested delegation accurately. */
  maxSubagentDepth?: number;
  /**
   * `web_fetch` builtin tool. **Opt-in** (default: registered) because it
   * issues HTTP requests and a secondary model call. Pass `false` to skip.
   * Pass an options object to override the provider / model id used for the
   * secondary model call. Without a model client the tool returns the raw
   * markdown without summarization.
   */
  webFetch?: CreateWebFetchToolOptions | false;
  /**
   * Background task tools (`task_create` / `task_list` / `task_output` /
   * `task_wait` / `task_stop`). **Opt-in** — pass `{ runtime }` to register; absent or
   * `false` keeps them out of the registry. Stand-alone runtimes that do
   * not provide a `BackgroundTaskPort` would otherwise see every call
   * fail with `unsupported_tool`.
   */
  backgroundTasks?: { runtime: BackgroundTaskPort } | false;
  /**
   * `structured_output` builtin (A3). Registered by default — the tool is
   * inert without a model client requesting it via `tool_choice`, but the
   * registry must contain it so non-interactive hosts can opt in. Pass
   * `false` to skip.
   */
  structuredOutput?: false;
  /**
   * `ask_user_question` builtin (B1). Registered by default; an absent
   * `PilotDeckElicitationChannel` at execution time causes the tool to
   * return a runtime error rather than crash the loop. Pass `false` to
   * skip registration in headless contexts.
   */
  askUserQuestion?: false;
  /**
   * `read_skill` builtin. **Opt-in** — pass `{ loader, lister }` to
   * register; absent or `false` keeps it out of the registry. The loader
   * fetches skill content by name; the lister enumerates available skill
   * names for the "not found" diagnostic message.
   */
  readSkill?: ReadSkillDeps | false;
  /**
   * `enter_plan_mode` / `exit_plan_mode` builtins. Registered by default —
   * these lightweight skeleton tools let the model request a permission-mode
   * switch to plan (read-only) and back. Pass `false` to skip.
   */
  planMode?: false;
};

export function createBuiltinRegistry(options?: CreateBuiltinRegistryOptions): ToolRegistry {
  const registry = new ToolRegistry();
  const fs = options?.fs ?? createNodeFsPort();
  const subprocess = options?.subprocess ?? createNodeSubprocessPort();
  const executionWorkspace = options?.executionWorkspace ?? createNodeExecutionWorkspacePort();
  const codeRuntime = options?.codeRuntime ?? createNodeCodeRuntimePort();
  const executionTransport = options?.executionTransport ?? createNodeExecutionTransportPort();
  const attachmentDelivery = options?.attachmentDelivery ?? createNodeAttachmentDeliveryPort();
  const bashOptions = options?.bash?.shell || options?.bash?.subprocess || options?.bash?.runner
    ? options.bash
    : { ...(options?.bash ?? {}), shell: options?.shell ?? createNodeShellPort(subprocess) };
  registry.register(createGetCurrentTimeTool());
  registry.register(createReadFileTool({ fs }));
  registry.register(createSendAttachmentTool({ delivery: attachmentDelivery }));
  registry.register(createGlobTool({ fs, subprocess }));
  registry.register(createGrepTool({ fs, subprocess }));
  registry.register(createEditFileTool({ fs, subprocess }));
  registry.register(createEditNotebookTool({ fs }));
  registry.register(createWriteFileTool({ fs }));
  registry.register(createBashTool(bashOptions));
  registry.register(createExecuteCodeTool({
    webSearch: options?.webSearch !== false,
    executionWorkspace,
    codeRuntime,
    executionTransport,
    ...(options?.executeCodeSandbox ? { sandbox: options.executeCodeSandbox } : {}),
  }));
  if (options?.webSearch !== false) {
    registry.register(createWebSearchTool(options?.webSearch));
  } else {
    registry.markUnavailable({
      toolName: "web_search",
      code: "unavailable",
      reason: "web_search is disabled in this session.",
    }, ["WebSearch"]);
  }
  if (options?.webFetch !== false) {
    registry.register(createWebFetchTool(options?.webFetch));
  } else {
    registry.markUnavailable({
      toolName: "web_fetch",
      code: "unavailable",
      reason: "web_fetch is disabled in this session.",
    }, ["WebFetch"]);
  }
  if (options?.agent !== false) {
    const agentOpts = options?.agent === true || options?.agent === undefined ? undefined : options.agent;
    registry.register(createAgentTool({
      ...(agentOpts ?? {}),
      ...(options?.maxSubagentDepth !== undefined ? { maxSubagentDepth: options.maxSubagentDepth } : {}),
    }));
  }
  if (options?.backgroundTasks) {
    const runtime = options.backgroundTasks.runtime;
    registry.register(createTaskCreateTool(runtime));
    registry.register(createTaskListTool(runtime));
    registry.register(createTaskOutputTool(runtime));
    registry.register(createTaskWaitTool(runtime));
    registry.register(createTaskStopTool(runtime));
  }
  if (options?.structuredOutput !== false) {
    registry.register(createStructuredOutputTool());
  }
  if (options?.askUserQuestion !== false) {
    registry.register(createAskUserQuestionTool());
  }
  if (options?.planMode !== false) {
    registry.register(createEnterPlanModeTool());
    registry.register(createExitPlanModeTool());
  }
  registry.register(createTodoWriteTool());
  for (const tool of createGoalTools()) registry.register(tool);
  if (options?.readSkill) {
    registry.register(createReadSkillTool(options.readSkill));
  }
  if (options?.lsp) {
    registry.register(createLspTool(options.lsp));
  }
  return registry;
}

import { createInstructionSanitizer, type InstructionSanitizer } from "./sanitize/instruction-sanitizer.js";
import { createMcpInstructionGuard } from "./guards/mcp-instruction-guard.js";
import { createHookPostGuard } from "./guards/hook-guard.js";
import { createWebGuard } from "./guards/web-guard.js";
import { createAnnotationPreGuard } from "./guards/annotation-guard.js";
import { loadSecurityPolicy } from "./policy/loader.js";
import type { SecurityPolicy } from "./policy/types.js";
import type { CallbackHookHandler } from "../extension/hooks/execution/CallbackHookExecutor.js";

export type SecurityGuard = {
  instructionSanitizer: InstructionSanitizer;
  mcpGuard: CallbackHookHandler;
  hookPostGuard: CallbackHookHandler;
  webGuard: CallbackHookHandler;
  annotationGuard: CallbackHookHandler;
  policy: SecurityPolicy;
};

export type CreateSecurityGuardOptions = {
  pilotHome: string;
};

export function createSecurityGuard(
  options: CreateSecurityGuardOptions,
): SecurityGuard {
  const policy = loadSecurityPolicy(options.pilotHome);

  return {
    instructionSanitizer: createInstructionSanitizer(policy),
    mcpGuard: createMcpInstructionGuard(policy),
    hookPostGuard: createHookPostGuard(policy),
    webGuard: createWebGuard(policy),
    annotationGuard: createAnnotationPreGuard(policy),
    policy,
  };
}

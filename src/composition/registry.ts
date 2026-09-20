import {
  HOST_CONTEXT_MODULE_METHODS,
  HOST_MODEL_MODULE_METHODS,
  HOST_CAPABILITY_MODULE_METHODS,
} from "../agent/modules/protocol.js";
import { MODULE_HTTP_TRANSPORT, MODULE_SLOT_CONTRACTS, type ComposableModuleSlot } from "./types.js";

const CONTRACT_METHODS: Readonly<Record<ComposableModuleSlot, readonly string[]>> = Object.freeze({
  agentLoop: ["execute", "cancel", "status", "resume", "ack"],
  skills: ["list", "read", "create", "write", "delete", "validate", "import", "scan"],
  tools: HOST_CAPABILITY_MODULE_METHODS,
  context: HOST_CONTEXT_MODULE_METHODS,
  modelProvider: HOST_MODEL_MODULE_METHODS,
  knowledge: [
    "list_bases", "create_base", "get_base", "update_base", "delete_base", "list_versions",
    "sync_base", "publish_version", "rollback_version", "list_documents", "get_document",
    "import_document", "import_okf", "update_document", "delete_document", "list_document_buckets",
    "update_bucket", "list_bucket_chunks", "update_chunk", "get_job", "list_jobs", "cancel_job",
    "list_okf_concepts", "get_okf_concept", "upsert_okf_concept", "export_okf", "lint_okf",
    "list_discoveries", "confirm_discovery", "reject_discovery", "query", "resolve_citation",
  ],
});

export function supportedContract(slot: ComposableModuleSlot): string {
  return MODULE_SLOT_CONTRACTS[slot];
}

export function supportedMethods(slot: ComposableModuleSlot): readonly string[] {
  return CONTRACT_METHODS[slot];
}

export function validateExternalContract(input: {
  slot: ComposableModuleSlot;
  contract: string;
  transport: string;
  methods: readonly string[];
}): string | undefined {
  if (input.contract !== supportedContract(input.slot)) {
    return `modules.${input.slot}.contract must be ${supportedContract(input.slot)}.`;
  }
  const transports = input.slot === "agentLoop"
    ? ["module-stdio-v2", "module-tcp-v2"]
    : [MODULE_HTTP_TRANSPORT];
  if (!transports.includes(input.transport)) {
    return `modules.${input.slot}.transport must be one of ${transports.join(", ")}.`;
  }
  const allowed = new Set(supportedMethods(input.slot));
  const unknown = input.methods.find((method) => !allowed.has(method));
  if (unknown) return `modules.${input.slot}.methods contains unsupported operation '${unknown}'.`;
  const required = requiredMethods(input.slot);
  const missing = required.find((method) => !input.methods.includes(method));
  if (missing) return `modules.${input.slot}.methods must include '${missing}'.`;
  return undefined;
}

function requiredMethods(slot: ComposableModuleSlot): readonly string[] {
  switch (slot) {
    case "modelProvider": return ["prepare", "stream"];
    case "tools": return ["execute"];
    case "context": return ["prepare_for_model"];
    case "skills": return ["list", "read"];
    case "knowledge": return ["query"];
    case "agentLoop": return ["execute"];
  }
}

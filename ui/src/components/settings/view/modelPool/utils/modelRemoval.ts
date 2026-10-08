import type { ConfigResponse } from "../../../../../hooks/usePilotDeckConfig";
import { authenticatedFetch } from "../../../../../utils/api";

export type ModelRemovalAction = "replace" | "inherit" | "remove" | "clear";

export type ModelRemovalChange = {
  path: string;
  value: string;
  kind: string;
  action: ModelRemovalAction;
  to?: string;
  reason?: "redundant";
};

export type ModelRemovalBlockedCode =
  | "NOT_FOUND"
  | "REPLACEMENT_REQUIRED"
  | "REPLACEMENT_INVALID"
  | "ROUTER_REQUIRES_MODEL";

export type ModelRemovalPlan = {
  target: { providerId: string; modelId?: string };
  replacement: string;
  replacementOptions: string[];
  requiresReplacement: boolean;
  changes: ModelRemovalChange[];
  blocked: { code: ModelRemovalBlockedCode; message: string } | null;
  revision: string;
};

/** Config payload returned after a successful removal (same shape as GET /api/config). */
export type ModelRemovalConfigResponse = ConfigResponse & { removal?: ModelRemovalPlan };

export type ModelRemovalTarget = {
  providerId: string;
  modelId?: string;
};

export type ModelRemovalFailure = {
  ok: false;
  code: string;
  message: string;
  plan?: ModelRemovalPlan;
};

async function postRemoval<T>(body: Record<string, unknown>): Promise<{ ok: true; data: T } | ModelRemovalFailure> {
  try {
    const response = await authenticatedFetch("/api/config/model-removal", {
      method: "POST",
      body: JSON.stringify(body),
      suppressServerErrorToast: true,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        code: typeof data.code === "string" ? data.code : "REQUEST_FAILED",
        message: typeof data.message === "string" ? data.message : typeof data.error === "string" ? data.error : "",
        ...(data.plan ? { plan: data.plan as ModelRemovalPlan } : {}),
      };
    }
    return { ok: true, data: data as T };
  } catch (error) {
    return { ok: false, code: "REQUEST_FAILED", message: error instanceof Error ? error.message : String(error) };
  }
}

/** Ask the server what removing the target would change, without writing. */
export function previewModelRemoval(target: ModelRemovalTarget, replacement = "") {
  return postRemoval<ModelRemovalPlan>({ ...target, replacement, dryRun: true });
}

/** Remove the target and repair every reference in one atomic config write. */
export function applyModelRemoval(target: ModelRemovalTarget, replacement: string, baseRevision: string) {
  return postRemoval<ModelRemovalConfigResponse>({ ...target, replacement, baseRevision });
}

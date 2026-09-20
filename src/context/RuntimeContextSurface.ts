export const RUNTIME_CONTEXT_SURFACES = ["system_prompt", "user_message"] as const;

export type RuntimeContextSurface = (typeof RUNTIME_CONTEXT_SURFACES)[number];

/** Default projection preserves the native owner system-prompt surface. */
export const DEFAULT_RUNTIME_CONTEXT_SURFACE: RuntimeContextSurface = "system_prompt";

/** Direct ContextRuntime compatibility default. */
export const LEGACY_RUNTIME_CONTEXT_SURFACE: RuntimeContextSurface = "system_prompt";

export function isRuntimeContextSurface(value: unknown): value is RuntimeContextSurface {
  return value === "system_prompt" || value === "user_message";
}

export function resolveRuntimeContextSurface(
  value: unknown,
  fallback: RuntimeContextSurface = DEFAULT_RUNTIME_CONTEXT_SURFACE,
): RuntimeContextSurface {
  return isRuntimeContextSurface(value) ? value : fallback;
}

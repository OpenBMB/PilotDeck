import type { PilotDeckMarketplaceReference } from "./manifest.js";

export type PilotDeckPluginMarketplaceStatus = "resolved" | "deferred";

export type PilotDeckMarketplaceResolution = {
  status: PilotDeckPluginMarketplaceStatus;
  reference: PilotDeckMarketplaceReference;
  reason?: string;
};

export function resolveMarketplaceReference(reference: PilotDeckMarketplaceReference): PilotDeckMarketplaceResolution {
  if (reference.source === "git" || reference.source === "zip" || reference.source === "mcpb") {
    return {
      status: "deferred",
      reference,
      reason: `${reference.source} installation is not implemented in the local runtime.`,
    };
  }
  return { status: "resolved", reference };
}

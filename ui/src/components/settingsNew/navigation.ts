import type { SettingsNewMenuKey } from "./types";

export function mapInitialTabToMenuKey(
  tab: string | undefined,
): SettingsNewMenuKey {
  const normalized = String(tab || "");
  if (normalized === "config:officePreview") {
    return "officePreview";
  }

  const [base] = normalized.split(":", 1);
  switch (base) {
    case "permissions":
      return "privacy";
    case "mcp":
      return "mcpServers";
    case "gateway":
      return "integrations";
    case "config":
      return "modelPool";
    default:
      return "general";
  }
}

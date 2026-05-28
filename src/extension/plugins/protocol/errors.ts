export type PilotDeckPluginError = {
  code: "plugin_manifest_invalid" | "plugin_not_found" | "plugin_load_failed";
  message: string;
  path?: string;
};

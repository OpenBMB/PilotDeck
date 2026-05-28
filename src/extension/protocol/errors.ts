export type PilotDeckExtensionError = {
  code: "extension_load_failed" | "extension_invalid";
  message: string;
};

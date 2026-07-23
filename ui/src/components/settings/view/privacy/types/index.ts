export type PermissionsExport = {
  version: 2;
  exportedAt: string;
  source: "pilotdeck";
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
};

export type ParsedPermissionsImport = {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions?: boolean;
};

export type StatusBanner =
  | { kind: "success"; message: string }
  | { kind: "error"; message: string }
  | null;

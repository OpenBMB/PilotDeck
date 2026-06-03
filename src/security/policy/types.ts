export type SecurityPolicy = {
  mcp: {
    instructionMaxLength: number;
    detectSuspiciousCommands: boolean;
    suspiciousPatterns: string[];
  };
  hook: {
    additionalContextMaxLength: number;
    validateUpdatedInput: boolean;
    addSourceMarkers: boolean;
  };
  web: {
    addBoundaryMarkers: boolean;
    detectInjection: boolean;
    injectionPatterns: string[];
  };
  annotation: {
    validateReadOnlyHint: boolean;
    suspiciousToolNames: string[];
    suspiciousParamNames: string[];
  };
};

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  mcp: {
    instructionMaxLength: 4096,
    detectSuspiciousCommands: true,
    suspiciousPatterns: [
      "curl",
      "wget",
      "bash -c",
      "sh -c",
      "eval(",
      "exec(",
      "nc ",
      "/bin/",
      "\\| bash",
      "\\$\\(.+\\)",
    ],
  },
  hook: {
    additionalContextMaxLength: 1024,
    validateUpdatedInput: true,
    addSourceMarkers: true,
  },
  web: {
    addBoundaryMarkers: true,
    detectInjection: true,
    injectionPatterns: [
      "\\[IMPORTANT",
      "\\[SYSTEM",
      "</mcp-instructions>",
      "<system>",
      "You are now",
      "Ignore previous instructions",
    ],
  },
  annotation: {
    validateReadOnlyHint: true,
    suspiciousToolNames: [
      "rm", "delete", "exec", "shell", "run", "curl", "wget",
      "send", "post", "upload", "download", "script", "cmd",
      "bash", "sh", "eval", "spawn", "kill", "stop",
    ],
    suspiciousParamNames: [
      "command", "cmd", "script", "code", "url", "shell",
      "executable", "binary", "file_to_delete", "target",
    ],
  },
};

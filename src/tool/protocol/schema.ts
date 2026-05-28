export type PilotDeckToolInputSchema = {
  type: "object";
  properties?: Record<string, PilotDeckJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

export type PilotDeckJsonSchema = {
  type?: string | string[];
  properties?: Record<string, PilotDeckJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: PilotDeckJsonSchema;
  enum?: unknown[];
  [key: string]: unknown;
};

export type PilotDeckToolValidationIssue = {
  path: string;
  code: "required" | "unknown_property" | "invalid_type" | "invalid_enum" | "invalid_schema";
  message: string;
};

export type PilotDeckToolValidationResult =
  | { ok: true; input: unknown }
  | { ok: false; issues: PilotDeckToolValidationIssue[] };

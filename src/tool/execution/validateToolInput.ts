import type {
  PilotDeckJsonSchema,
  PilotDeckToolInputSchema,
  PilotDeckToolValidationIssue,
  PilotDeckToolValidationResult,
} from "../protocol/schema.js";

export function validateToolInput(input: unknown, schema: PilotDeckToolInputSchema): PilotDeckToolValidationResult {
  const issues: PilotDeckToolValidationIssue[] = [];
  validateValue(input, schema, "$", issues);
  return issues.length === 0 ? { ok: true, input } : { ok: false, issues };
}

function validateValue(
  value: unknown,
  schema: PilotDeckJsonSchema,
  path: string,
  issues: PilotDeckToolValidationIssue[],
): void {
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    issues.push({
      path,
      code: "invalid_enum",
      message: `${path} must be one of ${schema.enum.map(String).join(", ")}.`,
    });
    return;
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    issues.push({
      path,
      code: "invalid_type",
      message: `${path} must be ${Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type}.`,
    });
    return;
  }

  const effectiveType = Array.isArray(schema.type) ? schema.type.find((type) => type !== "null") : schema.type;
  if (effectiveType === "object" || (effectiveType === undefined && isPlainObject(value))) {
    validateObject(value, schema, path, issues);
  }

  if (effectiveType === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateValue(item, schema.items!, `${path}[${index}]`, issues));
  }
}

function validateObject(
  value: unknown,
  schema: PilotDeckJsonSchema,
  path: string,
  issues: PilotDeckToolValidationIssue[],
): void {
  if (!isPlainObject(value)) {
    return;
  }

  const objectValue = value as Record<string, unknown>;
  const properties = schema.properties ?? {};
  for (const requiredKey of schema.required ?? []) {
    if (!(requiredKey in objectValue)) {
      issues.push({
        path: `${path}.${requiredKey}`,
        code: "required",
        message: `${path}.${requiredKey} is required.`,
      });
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(objectValue)) {
      if (!(key in properties)) {
        issues.push({
          path: `${path}.${key}`,
          code: "unknown_property",
          message: `${path}.${key} is not allowed.`,
        });
      }
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (key in objectValue) {
      validateValue(objectValue[key], propertySchema, `${path}.${key}`, issues);
    }
  }
}

function matchesType(value: unknown, type: string | string[]): boolean {
  if (Array.isArray(type)) {
    return type.some((item) => matchesType(value, item));
  }

  switch (type) {
    case "null":
      return value === null;
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

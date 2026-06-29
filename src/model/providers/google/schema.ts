const GOOGLE_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "patternProperties",
  "additionalProperties",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "examples",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

const META_KEYS = ["description", "title", "default"] as const;
const VALID_GOOGLE_PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

type SchemaDefs = Map<string, unknown>;

export function normalizeGoogleToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const flattened = flattenTopLevelObjectUnion(schema);
  const cleaned = cleanSchemaForGoogle(flattened);
  if (isRecord(cleaned)) {
    const result: Record<string, unknown> = { ...cleaned };
    if (result.type === undefined) {
      result.type = "object";
    }
    if (!isRecord(result.properties)) {
      result.properties = {};
    }
    return result;
  }
  return { type: "object", properties: {} };
}

export function cleanSchemaForGoogle(schema: unknown): unknown {
  return cleanSchemaForGoogleWithDefs(schema, undefined, undefined);
}

function cleanSchemaForGoogleWithDefs(
  schema: unknown,
  defs: SchemaDefs | undefined,
  refStack: Set<string> | undefined,
): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => cleanSchemaForGoogleWithDefs(item, defs, refStack));
  }

  const obj = schema as Record<string, unknown>;
  const nextDefs = extendSchemaDefs(defs, obj);
  const refValue = typeof obj.$ref === "string" ? obj.$ref : undefined;
  if (refValue) {
    if (refStack?.has(refValue)) {
      return {};
    }
    const resolved = tryResolveLocalRef(refValue, nextDefs);
    if (resolved !== undefined) {
      const nextRefStack = refStack ? new Set(refStack) : new Set<string>();
      nextRefStack.add(refValue);
      const cleaned = cleanSchemaForGoogleWithDefs(resolved, nextDefs, nextRefStack);
      if (!isRecord(cleaned)) {
        return cleaned;
      }
      const result: Record<string, unknown> = { ...cleaned };
      copySchemaMeta(obj, result);
      return result;
    }
    const result: Record<string, unknown> = {};
    copySchemaMeta(obj, result);
    return result;
  }

  const union = simplifyUnion(obj, nextDefs, refStack);
  if (union !== undefined) {
    return union;
  }

  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (GOOGLE_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }
    if (key === "const") {
      next.enum = [value];
      continue;
    }
    if (key === "type") {
      next.type = normalizeType(value);
      continue;
    }
    if (key === "properties") {
      next.properties = cleanProperties(value, nextDefs, refStack);
      continue;
    }
    if (key === "items") {
      next.items = cleanSchemaForGoogleWithDefs(value, nextDefs, refStack);
      continue;
    }
    if (key === "required") {
      continue;
    }
    next[key] = cleanSchemaForGoogleWithDefs(value, nextDefs, refStack);
  }

  if (next.type === "array" && next.items === undefined) {
    next.items = {};
  }

  const required = cleanRequired(obj.required, next.properties);
  if (required.length > 0) {
    next.required = required;
  }

  return next;
}

function flattenTopLevelObjectUnion(schema: Record<string, unknown>): Record<string, unknown> {
  const variantKey = Array.isArray(schema.anyOf)
    ? "anyOf"
    : Array.isArray(schema.oneOf)
      ? "oneOf"
      : null;
  if (!variantKey) {
    return schema;
  }

  const variants = (schema[variantKey] as unknown[])
    .filter((variant) => isRecord(variant) && isRecord(variant.properties)) as Record<string, unknown>[];
  if (variants.length === 0) {
    return schema;
  }

  const mergedProperties: Record<string, unknown> = {};
  const requiredCounts = new Map<string, number>();
  for (const variant of variants) {
    for (const [key, value] of Object.entries(variant.properties as Record<string, unknown>)) {
      mergedProperties[key] = key in mergedProperties
        ? mergePropertySchemas(mergedProperties[key], value)
        : value;
    }
    const required = Array.isArray(variant.required) ? variant.required : [];
    for (const key of required) {
      if (typeof key === "string") {
        requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const baseRequired = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : undefined;
  const required = baseRequired && baseRequired.length > 0
    ? baseRequired
    : Array.from(requiredCounts.entries())
        .filter(([, count]) => count === variants.length)
        .map(([key]) => key);

  return {
    ...schema,
    type: "object",
    properties: mergedProperties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function simplifyUnion(
  obj: Record<string, unknown>,
  defs: SchemaDefs | undefined,
  refStack: Set<string> | undefined,
): unknown {
  const variants = Array.isArray(obj.anyOf)
    ? obj.anyOf
    : Array.isArray(obj.oneOf)
      ? obj.oneOf
      : undefined;
  if (!variants) {
    return undefined;
  }

  const nonNullVariants = variants.filter((variant) => !isNullSchema(variant));
  const flattened = tryFlattenLiteralUnion(nonNullVariants);
  if (flattened) {
    const result: Record<string, unknown> = flattened;
    copySchemaMeta(obj, result);
    return result;
  }

  if (nonNullVariants.length === 1) {
    const cleaned = cleanSchemaForGoogleWithDefs(nonNullVariants[0], defs, refStack);
    if (isRecord(cleaned)) {
      const result: Record<string, unknown> = { ...cleaned };
      copySchemaMeta(obj, result);
      return result;
    }
    return cleaned;
  }

  return undefined;
}

function cleanProperties(
  properties: unknown,
  defs: SchemaDefs | undefined,
  refStack: Set<string> | undefined,
): Record<string, unknown> {
  if (!isRecord(properties)) {
    return {};
  }

  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!VALID_GOOGLE_PARAMETER_NAME.test(key)) {
      continue;
    }
    next[key] = cleanSchemaForGoogleWithDefs(value, defs, refStack);
  }
  return next;
}

function cleanRequired(required: unknown, properties: unknown): string[] {
  if (!Array.isArray(required) || !isRecord(properties)) {
    return [];
  }
  return required.filter(
    (key): key is string => typeof key === "string" && key in properties,
  );
}

function mergePropertySchemas(existing: unknown, incoming: unknown): unknown {
  const existingValues = extractEnumValues(existing);
  const incomingValues = extractEnumValues(incoming);
  if (existingValues || incomingValues) {
    const values = Array.from(new Set([...(existingValues ?? []), ...(incomingValues ?? [])]));
    const result: Record<string, unknown> = { enum: values };
    const type = values.length > 0 && values.every((value) => typeof value === typeof values[0])
      ? typeof values[0]
      : undefined;
    if (type) {
      result.type = type;
    }
    for (const source of [existing, incoming]) {
      if (isRecord(source)) {
        copySchemaMeta(source, result);
      }
    }
    return result;
  }
  return existing ?? incoming;
}

function tryFlattenLiteralUnion(variants: unknown[]): { type: string; enum: unknown[] } | undefined {
  if (variants.length === 0) {
    return undefined;
  }
  const values: unknown[] = [];
  let commonType: string | undefined;
  for (const variant of variants) {
    const extracted = extractSingleEnumValue(variant);
    if (!extracted) {
      return undefined;
    }
    if (commonType === undefined) {
      commonType = extracted.type;
    } else if (commonType !== extracted.type) {
      return undefined;
    }
    values.push(extracted.value);
  }
  return commonType ? { type: commonType, enum: values } : undefined;
}

function extractEnumValues(schema: unknown): unknown[] | undefined {
  if (!isRecord(schema)) {
    return undefined;
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum;
  }
  if ("const" in schema) {
    return [schema.const];
  }
  const variants = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (!variants) {
    return undefined;
  }
  const values = variants.flatMap((variant) => extractEnumValues(variant) ?? []);
  return values.length > 0 ? values : undefined;
}

function extractSingleEnumValue(schema: unknown): { type: string; value: unknown } | undefined {
  if (!isRecord(schema)) {
    return undefined;
  }
  const value = "const" in schema
    ? schema.const
    : Array.isArray(schema.enum) && schema.enum.length === 1
      ? schema.enum[0]
      : undefined;
  const type = typeof schema.type === "string" ? schema.type : typeof value;
  return value !== undefined && type !== "undefined" ? { type, value } : undefined;
}

function normalizeType(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value === "null" ? undefined : value;
  }
  const withoutNull = value.filter((entry) => entry !== "null");
  return withoutNull.length === 1 ? withoutNull[0] : withoutNull;
}

function isNullSchema(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "null" || value.const === null) {
    return true;
  }
  return Array.isArray(value.enum) && value.enum.length === 1 && value.enum[0] === null;
}

function extendSchemaDefs(
  defs: SchemaDefs | undefined,
  schema: Record<string, unknown>,
): SchemaDefs | undefined {
  const entries = [
    isRecord(schema.$defs) ? schema.$defs : undefined,
    isRecord(schema.definitions) ? schema.definitions : undefined,
  ].filter((entry): entry is Record<string, unknown> => entry !== undefined);
  if (entries.length === 0) {
    return defs;
  }
  const next = defs ? new Map(defs) : new Map<string, unknown>();
  for (const entry of entries) {
    for (const [key, value] of Object.entries(entry)) {
      next.set(key, value);
    }
  }
  return next;
}

function tryResolveLocalRef(ref: string, defs: SchemaDefs | undefined): unknown {
  if (!defs) {
    return undefined;
  }
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (!match) {
    return undefined;
  }
  return defs.get(decodeJsonPointerSegment(match[1] ?? ""));
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function copySchemaMeta(from: Record<string, unknown>, to: Record<string, unknown>): void {
  for (const key of META_KEYS) {
    if (to[key] === undefined && from[key] !== undefined) {
      to[key] = from[key];
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

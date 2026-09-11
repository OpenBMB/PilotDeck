import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv/dist/2020.js";

type Draft202012Validator = {
  compile(schema: object): ValidateFunction;
};

type Draft202012Constructor = new (options: {
  allErrors: boolean;
  strict: boolean;
  strictTuples: boolean;
  validateFormats: boolean;
  unevaluated: boolean;
}) => Draft202012Validator;

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default as Draft202012Constructor;
const addFormats = require("ajv-formats").default as (ajv: Draft202012Validator) => unknown;

const MAX_FORM_SCHEMA_BYTES = 64_000;
const MAX_FORM_SCHEMA_DEPTH = 8;
const MAX_FORM_SCHEMA_NODES = 256;
const MAX_FORM_PROPERTIES = 64;
const MAX_FORM_DEFINITIONS = 64;
const MAX_FORM_ENUM_VALUES = 64;
const MAX_FORM_COMPOSITION_BRANCHES = 32;
const MAX_FORM_DEPENDENCIES = 64;
const MAX_FORM_PATTERN_LENGTH = 4_096;
const SUPPORTED_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const SUPPORTED_STRING_FORMATS = new Set<FormDialogStringFormat>([
  "email", "uri", "uuid", "date", "time", "date-time",
]);
const SUPPORTED_KEYS = new Set([
  "type", "title", "description", "format", "default", "enum", "const",
  "$ref", "$defs",
  "properties", "patternProperties", "required", "additionalProperties", "items", "prefixItems",
  "contains", "minContains", "maxContains", "propertyNames",
  "allOf", "anyOf", "oneOf", "not",
  "if", "then", "else", "dependentRequired", "dependentSchemas",
  "minLength", "maxLength", "pattern",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minItems", "maxItems", "uniqueItems",
  "minProperties", "maxProperties",
]);

/**
 * Opts a form into the standards-based validator. Schemas without this value
 * continue to use the historical PilotDeck subset, which preserves existing
 * validation and error behavior for installed SDK clients.
 */
export const FORM_DIALOG_DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

const standardSchemaValidators = new WeakMap<object, ValidateFunction>();

export type FormDialogStringFormat = "email" | "uri" | "uuid" | "date" | "time" | "date-time";

export type FormDialogFieldSchema = {
  /** A local root definition reference in the form `#/$defs/<name>`. */
  $ref?: string;
  type?: string | string[];
  title?: string;
  description?: string;
  /** Gateway validates this format when the answer is a string. */
  format?: FormDialogStringFormat;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, FormDialogFieldSchema>;
  patternProperties?: Record<string, FormDialogFieldSchema>;
  required?: string[];
  additionalProperties?: boolean | FormDialogFieldSchema;
  items?: FormDialogFieldSchema;
  prefixItems?: FormDialogFieldSchema[];
  contains?: FormDialogFieldSchema;
  minContains?: number;
  maxContains?: number;
  propertyNames?: FormDialogFieldSchema;
  allOf?: FormDialogFieldSchema[];
  anyOf?: FormDialogFieldSchema[];
  oneOf?: FormDialogFieldSchema[];
  not?: FormDialogFieldSchema;
  if?: FormDialogFieldSchema;
  then?: FormDialogFieldSchema;
  else?: FormDialogFieldSchema;
  dependentRequired?: Record<string, string[]>;
  dependentSchemas?: Record<string, FormDialogFieldSchema>;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
  [key: string]: unknown;
};

export type FormDialogSchema = FormDialogFieldSchema & {
  type: "object";
  /**
   * Declares standards-based Draft 2020-12 validation. The form remains an
   * object, while nested schemas may use the full local draft vocabulary.
   */
  $schema?: typeof FORM_DIALOG_DRAFT_2020_12;
  /** Reusable local schemas; only root-level definitions are supported by the legacy subset. */
  $defs?: Record<string, FormDialogFieldSchema>;
};

export type FormDialogSchemaValidation =
  | { ok: true; schema: FormDialogSchema }
  | { ok: false; message: string };

/**
 * Validates an opt-in form dialog schema. The historical PilotDeck subset is
 * preserved unless the schema explicitly declares Draft 2020-12. The latter
 * accepts the standard local vocabulary (including arbitrary local JSON
 * pointers and unevaluated keywords) but deliberately never resolves a
 * remote reference from the Gateway process.
 *
 * This remains separate from ToolRuntime's input-schema validator: form
 * answers are Gateway-owned interactive data and these constraints must not
 * change existing native tool validation semantics.
 */
export function validateFormDialogSchema(value: unknown): FormDialogSchemaValidation {
  if (!isPlainRecord(value)) return { ok: false, message: "schema must be a JSON object." };
  if (value.type !== "object") return { ok: false, message: "schema.type must be object." };
  if (!isJsonValue(value)) return { ok: false, message: "schema must contain only finite JSON values." };
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > MAX_FORM_SCHEMA_BYTES) return { ok: false, message: `schema must not exceed ${MAX_FORM_SCHEMA_BYTES} bytes.` };

  if (value.$schema === FORM_DIALOG_DRAFT_2020_12) {
    return validateDraft202012FormSchema(value);
  }
  if (value.$schema !== undefined) {
    return {
      ok: false,
      message: `schema.$schema must be ${FORM_DIALOG_DRAFT_2020_12} to enable standards-based form validation.`,
    };
  }

  const issue = validateSchemaNode(value, "$", 0, { nodes: 0 });
  if (issue) return { ok: false, message: issue };
  const referenceIssue = validateLocalDefinitionReferences(value);
  return referenceIssue ? { ok: false, message: referenceIssue } : { ok: true, schema: value as FormDialogSchema };
}

/** Returns whether a Gateway may safely resume a pending form tool call. */
export function acceptsFormDialogAnswer(schema: FormDialogSchema, value: unknown): value is Record<string, unknown> {
  if (schema.$schema === FORM_DIALOG_DRAFT_2020_12) {
    if (!isPlainRecord(value)) return false;
    try {
      return getDraft202012Validator(schema)(value) === true;
    } catch {
      // A schema is compiled before a request reaches the dialog bus. Keep a
      // fail-closed fallback in case a caller constructs an invalid object at
      // runtime instead of using the validated tool input.
      return false;
    }
  }
  return isPlainRecord(value) && validateAnswerValue(value, schema, schema.$defs ?? {});
}

function validateDraft202012FormSchema(value: Record<string, unknown>): FormDialogSchemaValidation {
  const externalReference = findExternalReference(value);
  if (externalReference) {
    return {
      ok: false,
      message: `${externalReference.path} must use a local # reference; Gateway form dialogs never fetch remote schemas.`,
    };
  }
  try {
    getDraft202012Validator(value as FormDialogSchema);
  } catch (error) {
    return {
      ok: false,
      message: `schema must be a valid local Draft 2020-12 JSON Schema: ${formatSchemaCompileError(error)}`,
    };
  }
  return { ok: true, schema: value as FormDialogSchema };
}

function getDraft202012Validator(schema: FormDialogSchema): ValidateFunction {
  const cached = standardSchemaValidators.get(schema);
  if (cached) return cached;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    // Draft 2020-12 permits a trailing `items` schema after `prefixItems`.
    // This is a useful form shape, although Ajv's style check flags it.
    strictTuples: false,
    validateFormats: true,
    unevaluated: true,
  });
  addFormats(ajv);
  const validator = ajv.compile(schema);
  standardSchemaValidators.set(schema, validator);
  return validator;
}

function findExternalReference(
  value: unknown,
  path = "$",
): { path: string } | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const reference = findExternalReference(value[index], `${path}[${index}]`);
      if (reference) return reference;
    }
    return undefined;
  }
  if (!isPlainRecord(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "$ref" || key === "$dynamicRef" || key === "$recursiveRef")
      && typeof child === "string" && !child.startsWith("#")) {
      return { path: `${path}.${key}` };
    }
    const reference = findExternalReference(child, `${path}.${key}`);
    if (reference) return reference;
  }
  return undefined;
}

function formatSchemaCompileError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").slice(0, 1_000);
}

function validateSchemaNode(value: unknown, path: string, depth: number, state: { nodes: number }): string | undefined {
  if (!isPlainRecord(value)) return `${path} must be an object.`;
  state.nodes += 1;
  if (state.nodes > MAX_FORM_SCHEMA_NODES) return `schema may contain at most ${MAX_FORM_SCHEMA_NODES} nodes.`;
  if (depth > MAX_FORM_SCHEMA_DEPTH) return `schema nesting may not exceed ${MAX_FORM_SCHEMA_DEPTH} levels.`;
  for (const key of Object.keys(value)) {
    if (!SUPPORTED_KEYS.has(key)) return `${path}.${key} is not supported by form dialogs.`;
  }
  const referenceIssue = validateLocalReference(value.$ref, path);
  if (referenceIssue) return referenceIssue;
  if (value.$defs !== undefined) {
    if (path !== "$") return `${path}.$defs is only supported on the root form schema.`;
    if (!isPlainRecord(value.$defs)) return `${path}.$defs must be an object.`;
    const definitions = Object.entries(value.$defs);
    if (definitions.length > MAX_FORM_DEFINITIONS) return `${path}.$defs may contain at most ${MAX_FORM_DEFINITIONS} definitions.`;
    for (const [name, definition] of definitions) {
      if (!isLocalDefinitionName(name)) return `${path}.$defs.${name} must use a simple local definition name.`;
      const issue = validateSchemaNode(definition, `${path}.$defs.${name}`, depth + 1, state);
      if (issue) return issue;
    }
  }
  if (value.type !== undefined && !isSupportedType(value.type)) return `${path}.type must name supported JSON value types.`;
  for (const key of ["title", "description", "format", "pattern"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") return `${path}.${key} must be a string.`;
  }
  if (typeof value.format === "string" && !SUPPORTED_STRING_FORMATS.has(value.format as FormDialogStringFormat)) {
    return `${path}.format must be one of ${[...SUPPORTED_STRING_FORMATS].join(", ")}.`;
  }
  if (typeof value.pattern === "string") {
    if (value.pattern.length > MAX_FORM_PATTERN_LENGTH) return `${path}.pattern must not exceed ${MAX_FORM_PATTERN_LENGTH} characters.`;
    try { new RegExp(value.pattern); } catch { return `${path}.pattern must be a valid JavaScript regular expression.`; }
  }
  for (const key of ["default", "const"] as const) {
    if (value[key] !== undefined && !isJsonValue(value[key])) return `${path}.${key} must be JSON-serializable.`;
  }
  const countIssue = validateCountBounds(value, path);
  if (countIssue) return countIssue;
  const numericIssue = validateNumericBounds(value, path);
  if (numericIssue) return numericIssue;

  if (value.required !== undefined) {
    if (!Array.isArray(value.required) || value.required.some((key) => typeof key !== "string" || !key.trim())
      || new Set(value.required).size !== value.required.length) return `${path}.required must be an array of unique non-empty property names.`;
  }
  if (value.properties !== undefined) {
    const properties = value.properties;
    if (!isPlainRecord(properties)) return `${path}.properties must be an object.`;
    const entries = Object.entries(properties);
    if (entries.length > MAX_FORM_PROPERTIES) return `${path}.properties may contain at most ${MAX_FORM_PROPERTIES} fields.`;
    for (const [key, child] of entries) {
      if (!key.trim()) return `${path}.properties cannot contain an empty field name.`;
      const issue = validateSchemaNode(child, `${path}.properties.${key}`, depth + 1, state);
      if (issue) return issue;
    }
    if (Array.isArray(value.required) && value.required.some((key) => !(key in properties))) {
      return `${path}.required must only reference declared properties.`;
    }
  } else if (Array.isArray(value.required) && value.required.length > 0) {
    return `${path}.required requires properties.`;
  }
  if (value.patternProperties !== undefined) {
    if (!isPlainRecord(value.patternProperties)) return `${path}.patternProperties must be an object.`;
    const entries = Object.entries(value.patternProperties);
    if (entries.length > MAX_FORM_PROPERTIES) return `${path}.patternProperties may contain at most ${MAX_FORM_PROPERTIES} patterns.`;
    for (const [pattern, child] of entries) {
      const patternIssue = validateSchemaPattern(pattern, `${path}.patternProperties`);
      if (patternIssue) return patternIssue;
      const issue = validateSchemaNode(child, `${path}.patternProperties.${pattern}`, depth + 1, state);
      if (issue) return issue;
    }
  }
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") {
    const issue = validateSchemaNode(value.additionalProperties, `${path}.additionalProperties`, depth + 1, state);
    if (issue) return issue;
  }
  if (value.items !== undefined) {
    const issue = validateSchemaNode(value.items, `${path}.items`, depth + 1, state);
    if (issue) return issue;
  }
  if (value.prefixItems !== undefined) {
    if (!Array.isArray(value.prefixItems) || value.prefixItems.length === 0 || value.prefixItems.length > MAX_FORM_COMPOSITION_BRANCHES) {
      return `${path}.prefixItems must contain 1-${MAX_FORM_COMPOSITION_BRANCHES} schema entries.`;
    }
    for (let index = 0; index < value.prefixItems.length; index += 1) {
      const issue = validateSchemaNode(value.prefixItems[index], `${path}.prefixItems[${index}]`, depth + 1, state);
      if (issue) return issue;
    }
  }
  if (value.contains !== undefined) {
    const issue = validateSchemaNode(value.contains, `${path}.contains`, depth + 1, state);
    if (issue) return issue;
  }
  const containsIssue = validateContainsBounds(value, path);
  if (containsIssue) return containsIssue;
  if (value.propertyNames !== undefined) {
    const issue = validateSchemaNode(value.propertyNames, `${path}.propertyNames`, depth + 1, state);
    if (issue) return issue;
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].length === 0 || value[key].length > MAX_FORM_COMPOSITION_BRANCHES) {
      return `${path}.${key} must contain 1-${MAX_FORM_COMPOSITION_BRANCHES} schema branches.`;
    }
    for (let index = 0; index < value[key].length; index += 1) {
      const issue = validateSchemaNode(value[key][index], `${path}.${key}[${index}]`, depth + 1, state);
      if (issue) return issue;
    }
  }
  if (value.not !== undefined) {
    const issue = validateSchemaNode(value.not, `${path}.not`, depth + 1, state);
    if (issue) return issue;
  }
  const hasIf = value.if !== undefined;
  const hasThen = value.then !== undefined;
  const hasElse = value.else !== undefined;
  if ((hasThen || hasElse) && !hasIf) return `${path}.then and ${path}.else require ${path}.if.`;
  if (hasIf && !hasThen && !hasElse) return `${path}.if requires ${path}.then or ${path}.else.`;
  for (const key of ["if", "then", "else"] as const) {
    if (value[key] === undefined) continue;
    const issue = validateSchemaNode(value[key], `${path}.${key}`, depth + 1, state);
    if (issue) return issue;
  }
  const declaredProperties = isPlainRecord(value.properties) ? value.properties : undefined;
  const dependentRequiredIssue = validateDependentRequired(value.dependentRequired, declaredProperties, path);
  if (dependentRequiredIssue) return dependentRequiredIssue;
  if (value.dependentSchemas !== undefined) {
    if (!isPlainRecord(value.dependentSchemas)) return `${path}.dependentSchemas must be an object.`;
    const entries = Object.entries(value.dependentSchemas);
    if (entries.length > MAX_FORM_DEPENDENCIES) return `${path}.dependentSchemas may contain at most ${MAX_FORM_DEPENDENCIES} dependencies.`;
    for (const [trigger, dependencySchema] of entries) {
      if (!trigger.trim()) return `${path}.dependentSchemas cannot contain an empty property name.`;
      if (!declaredProperties || !(trigger in declaredProperties)) {
        return `${path}.dependentSchemas.${trigger} must reference a declared property.`;
      }
      const issue = validateSchemaNode(dependencySchema, `${path}.dependentSchemas.${trigger}`, depth + 1, state);
      if (issue) return issue;
    }
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > MAX_FORM_ENUM_VALUES
      || value.enum.some((item) => !isJsonValue(item))) return `${path}.enum must contain 1-${MAX_FORM_ENUM_VALUES} JSON values.`;
  }
  return undefined;
}

function validateDependentRequired(
  value: unknown,
  properties: Record<string, unknown> | undefined,
  path: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) return `${path}.dependentRequired must be an object.`;
  const entries = Object.entries(value);
  if (entries.length > MAX_FORM_DEPENDENCIES) return `${path}.dependentRequired may contain at most ${MAX_FORM_DEPENDENCIES} dependencies.`;
  for (const [trigger, dependencies] of entries) {
    if (!trigger.trim()) return `${path}.dependentRequired cannot contain an empty property name.`;
    if (!properties || !(trigger in properties)) return `${path}.dependentRequired.${trigger} must reference a declared property.`;
    if (!Array.isArray(dependencies) || dependencies.length === 0 || dependencies.length > MAX_FORM_PROPERTIES
      || dependencies.some((dependency) => typeof dependency !== "string" || !dependency.trim())
      || new Set(dependencies).size !== dependencies.length) {
      return `${path}.dependentRequired.${trigger} must contain 1-${MAX_FORM_PROPERTIES} unique non-empty declared property names.`;
    }
    if (dependencies.some((dependency) => !(dependency in properties))) {
      return `${path}.dependentRequired.${trigger} must only reference declared properties.`;
    }
  }
  return undefined;
}

function validateCountBounds(value: Record<string, unknown>, path: string): string | undefined {
  for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"] as const) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || (value[key] as number) < 0)) return `${path}.${key} must be a non-negative integer.`;
  }
  for (const [minimum, maximum] of [["minLength", "maxLength"], ["minItems", "maxItems"], ["minProperties", "maxProperties"]] as const) {
    if (typeof value[minimum] === "number" && typeof value[maximum] === "number" && value[minimum] > value[maximum]) {
      return `${path}.${minimum} must not exceed ${path}.${maximum}.`;
    }
  }
  return value.uniqueItems !== undefined && typeof value.uniqueItems !== "boolean" ? `${path}.uniqueItems must be a boolean.` : undefined;
}

function validateSchemaPattern(pattern: string, path: string): string | undefined {
  if (pattern.length === 0) return `${path} cannot contain an empty pattern.`;
  if (pattern.length > MAX_FORM_PATTERN_LENGTH) return `${path} patterns must not exceed ${MAX_FORM_PATTERN_LENGTH} characters.`;
  try {
    new RegExp(pattern);
  } catch {
    return `${path}.${pattern} must be a valid JavaScript regular expression.`;
  }
  return undefined;
}

function validateNumericBounds(value: Record<string, unknown>, path: string): string | undefined {
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) return `${path}.${key} must be a finite number.`;
  }
  if (typeof value.multipleOf === "number" && value.multipleOf <= 0) return `${path}.multipleOf must be greater than zero.`;
  if (typeof value.minimum === "number" && typeof value.maximum === "number" && value.minimum > value.maximum) return `${path}.minimum must not exceed ${path}.maximum.`;
  if (typeof value.exclusiveMinimum === "number" && typeof value.exclusiveMaximum === "number" && value.exclusiveMinimum >= value.exclusiveMaximum) {
    return `${path}.exclusiveMinimum must be less than ${path}.exclusiveMaximum.`;
  }
  return undefined;
}

function validateContainsBounds(value: Record<string, unknown>, path: string): string | undefined {
  for (const key of ["minContains", "maxContains"] as const) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || (value[key] as number) < 0)) {
      return `${path}.${key} must be a non-negative integer.`;
    }
  }
  if ((value.minContains !== undefined || value.maxContains !== undefined) && value.contains === undefined) {
    return `${path}.minContains and ${path}.maxContains require ${path}.contains.`;
  }
  if (typeof value.minContains === "number" && typeof value.maxContains === "number" && value.minContains > value.maxContains) {
    return `${path}.minContains must not exceed ${path}.maxContains.`;
  }
  return undefined;
}

type LocalDefinitionReference = { name: string; path: string };

function validateLocalReference(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !localDefinitionName(value)) {
    return `${path}.$ref must be a local #/$defs/<name> reference.`;
  }
  return undefined;
}

function validateLocalDefinitionReferences(root: Record<string, unknown>): string | undefined {
  const definitions = isPlainRecord(root.$defs) ? root.$defs : {};
  const definitionNames = new Set(Object.keys(definitions));
  const rootReferences = collectLocalDefinitionReferences(root, "$", []);
  for (const reference of rootReferences) {
    if (!definitionNames.has(reference.name)) return `${reference.path}.$ref references unknown root definition ${reference.name}.`;
  }

  const graph = new Map<string, string[]>();
  for (const [name, definition] of Object.entries(definitions)) {
    const references = collectLocalDefinitionReferences(definition, `$.$defs.${name}`, []);
    for (const reference of references) {
      if (!definitionNames.has(reference.name)) return `${reference.path}.$ref references unknown root definition ${reference.name}.`;
    }
    graph.set(name, references.map((reference) => reference.name));
  }

  const completed = new Set<string>();
  const active: string[] = [];
  const visit = (name: string): string | undefined => {
    const cycleStart = active.indexOf(name);
    if (cycleStart >= 0) return `$defs contains a circular reference: ${[...active.slice(cycleStart), name].join(" -> ")}.`;
    if (completed.has(name)) return undefined;
    active.push(name);
    for (const target of graph.get(name) ?? []) {
      const issue = visit(target);
      if (issue) return issue;
    }
    active.pop();
    completed.add(name);
    return undefined;
  };
  for (const name of definitionNames) {
    const issue = visit(name);
    if (issue) return issue;
  }
  return undefined;
}

function collectLocalDefinitionReferences(
  schema: unknown,
  path: string,
  references: LocalDefinitionReference[],
): LocalDefinitionReference[] {
  if (!isPlainRecord(schema)) return references;
  const name = typeof schema.$ref === "string" ? localDefinitionName(schema.$ref) : undefined;
  if (name) references.push({ name, path });

  if (isPlainRecord(schema.properties)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      collectLocalDefinitionReferences(child, `${path}.properties.${key}`, references);
    }
  }
  if (isPlainRecord(schema.patternProperties)) {
    for (const [pattern, child] of Object.entries(schema.patternProperties)) {
      collectLocalDefinitionReferences(child, `${path}.patternProperties.${pattern}`, references);
    }
  }
  if (isPlainRecord(schema.additionalProperties)) {
    collectLocalDefinitionReferences(schema.additionalProperties, `${path}.additionalProperties`, references);
  }
  if (schema.items !== undefined) collectLocalDefinitionReferences(schema.items, `${path}.items`, references);
  if (Array.isArray(schema.prefixItems)) {
    for (let index = 0; index < schema.prefixItems.length; index += 1) {
      collectLocalDefinitionReferences(schema.prefixItems[index], `${path}.prefixItems[${index}]`, references);
    }
  }
  if (schema.contains !== undefined) collectLocalDefinitionReferences(schema.contains, `${path}.contains`, references);
  if (schema.propertyNames !== undefined) collectLocalDefinitionReferences(schema.propertyNames, `${path}.propertyNames`, references);
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (!Array.isArray(schema[key])) continue;
    for (let index = 0; index < schema[key].length; index += 1) {
      collectLocalDefinitionReferences(schema[key][index], `${path}.${key}[${index}]`, references);
    }
  }
  for (const key of ["not", "if", "then", "else"] as const) {
    if (schema[key] !== undefined) collectLocalDefinitionReferences(schema[key], `${path}.${key}`, references);
  }
  if (isPlainRecord(schema.dependentSchemas)) {
    for (const [key, child] of Object.entries(schema.dependentSchemas)) {
      collectLocalDefinitionReferences(child, `${path}.dependentSchemas.${key}`, references);
    }
  }
  return references;
}

function localDefinitionName(reference: string): string | undefined {
  const prefix = "#/$defs/";
  if (!reference.startsWith(prefix)) return undefined;
  const name = reference.slice(prefix.length);
  return isLocalDefinitionName(name) ? name : undefined;
}

function isLocalDefinitionName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value);
}

function validateAnswerValue(
  value: unknown,
  schema: FormDialogFieldSchema,
  definitions: Record<string, FormDialogFieldSchema>,
): boolean {
  if (schema.$ref !== undefined) {
    const name = localDefinitionName(schema.$ref);
    const referencedSchema = name ? definitions[name] : undefined;
    if (!referencedSchema || !validateAnswerValue(value, referencedSchema, definitions)) return false;
  }
  if (schema.type !== undefined && !matchesType(value, schema.type)) return false;
  if (schema.const !== undefined && !jsonEqual(value, schema.const)) return false;
  if (schema.enum && !schema.enum.some((candidate) => jsonEqual(value, candidate))) return false;
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format !== undefined && !matchesStringFormat(value, schema.format)) return false;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return false;
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return false;
    if (schema.multipleOf !== undefined && !isMultipleOf(value, schema.multipleOf)) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.uniqueItems === true && value.some((item, index) => value.slice(0, index).some((prior) => jsonEqual(prior, item)))) return false;
    if (schema.prefixItems && value.some((item, index) => index < schema.prefixItems!.length && !validateAnswerValue(item, schema.prefixItems![index]!, definitions))) return false;
    if (schema.items && !value.slice(schema.prefixItems?.length ?? 0).every((item) => validateAnswerValue(item, schema.items!, definitions))) return false;
    if (schema.contains) {
      const matches = value.filter((item) => validateAnswerValue(item, schema.contains!, definitions)).length;
      if (matches < (schema.minContains ?? 1)) return false;
      if (schema.maxContains !== undefined && matches > schema.maxContains) return false;
    }
  }
  if (isPlainRecord(value)) {
    const properties = schema.properties ?? {};
    const patternProperties = schema.patternProperties ?? {};
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) return false;
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) return false;
    if ((schema.required ?? []).some((key) => !(key in value))) return false;
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (propertySchema) {
        if (!validateAnswerValue(item, propertySchema, definitions)) return false;
      } else if (schema.additionalProperties === false || (isPlainRecord(schema.additionalProperties) && !validateAnswerValue(item, schema.additionalProperties, definitions))) {
        return false;
      }
      for (const [pattern, patternSchema] of Object.entries(patternProperties)) {
        if (new RegExp(pattern).test(key) && !validateAnswerValue(item, patternSchema, definitions)) return false;
      }
    }
    if (schema.dependentRequired) {
      for (const [trigger, dependencies] of Object.entries(schema.dependentRequired)) {
        if (trigger in value && dependencies.some((dependency) => !(dependency in value))) return false;
      }
    }
    if (schema.dependentSchemas) {
      for (const [trigger, dependencySchema] of Object.entries(schema.dependentSchemas)) {
        if (trigger in value && !validateAnswerValue(value, dependencySchema, definitions)) return false;
      }
    }
    if (schema.propertyNames && !keys.every((key) => validateAnswerValue(key, schema.propertyNames!, definitions))) return false;
  }
  if (schema.allOf && !schema.allOf.every((branch) => validateAnswerValue(value, branch, definitions))) return false;
  if (schema.anyOf && !schema.anyOf.some((branch) => validateAnswerValue(value, branch, definitions))) return false;
  if (schema.oneOf && schema.oneOf.filter((branch) => validateAnswerValue(value, branch, definitions)).length !== 1) return false;
  if (schema.not && validateAnswerValue(value, schema.not, definitions)) return false;
  if (schema.if) {
    const branch = validateAnswerValue(value, schema.if, definitions) ? schema.then : schema.else;
    if (branch && !validateAnswerValue(value, branch, definitions)) return false;
  }
  return true;
}

function matchesStringFormat(value: string, format: FormDialogStringFormat): boolean {
  switch (format) {
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
    case "uri": {
      if (/\s/u.test(value)) return false;
      try {
        return new URL(value).protocol.length > 1;
      } catch {
        return false;
      }
    }
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
    case "date":
      return isIsoDate(value);
    case "time":
      return isRfc3339Time(value, false);
    case "date-time": {
      const match = /^(\d{4}-\d{2}-\d{2})T(.+)$/u.exec(value);
      return match !== null && isIsoDate(match[1]!) && isRfc3339Time(match[2]!, true);
    }
  }
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isRfc3339Time(value: string, requireTimezone: boolean): boolean {
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/u.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  const timezone = match[4];
  if (hour > 23 || minute > 59 || second > 59 || (requireTimezone && !timezone)) return false;
  if (!timezone || timezone === "Z") return true;
  const timezoneMatch = /^[+-](\d{2}):(\d{2})$/u.exec(timezone);
  return timezoneMatch !== null && Number(timezoneMatch[1]) <= 23 && Number(timezoneMatch[2]) <= 59;
}

function isSupportedType(value: unknown): boolean {
  return typeof value === "string"
    ? SUPPORTED_TYPES.has(value)
    : Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && SUPPORTED_TYPES.has(item));
}

function matchesType(value: unknown, type: string | string[]): boolean {
  return (Array.isArray(type) ? type : [type]).some((candidate) => {
    switch (candidate) {
      case "null": return value === null;
      case "object": return isPlainRecord(value);
      case "array": return Array.isArray(value);
      case "string": return typeof value === "string";
      case "number": return typeof value === "number" && Number.isFinite(value);
      case "integer": return Number.isInteger(value);
      case "boolean": return typeof value === "boolean";
      default: return false;
    }
  });
}

function isMultipleOf(value: number, divisor: number): boolean {
  const quotient = value / divisor;
  return Math.abs(quotient - Math.round(quotient)) < 1e-10;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainRecord(value) && Object.values(value).every(isJsonValue);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && jsonEqual(left[key], right[key]));
  }
  return false;
}

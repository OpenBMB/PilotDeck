import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { ValidateFunction } from "ajv/dist/2020.js";

import type {
  OnUserDialog,
  PilotDeckUserDialogFormFieldSchema,
  PilotDeckUserDialogFormSchema,
  PilotDeckUserDialogRequest,
  PilotDeckUserDialogResult,
} from "./types.js";

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
const addFormats = require("ajv-formats").default as (validator: Draft202012Validator) => unknown;

/** Injectable terminal I/O for applications that do not use process stdin/stdout. */
export type PilotDeckTerminalDialogIO = {
  ask(prompt: string, options: { signal?: AbortSignal }): Promise<string | undefined>;
  write(line: string): void;
};

/** Options for the SDK-provided interactive terminal dialog renderer. */
export type PilotDeckTerminalDialogOptions = {
  /** Defaults to a fresh Node readline interface for each prompt. */
  io?: PilotDeckTerminalDialogIO;
  /** Maximum invalid answers per field before cancelling the dialog. Defaults to 3. */
  maxAttempts?: number;
  /** Optional cancellation signal for a manually rendered pending dialog. */
  signal?: AbortSignal;
};

type PromptResult =
  | { kind: "value"; value: unknown }
  | { kind: "omitted" }
  | { kind: "cancelled"; reason: string };

const formValidators = new WeakMap<object, ValidateFunction | null>();

/**
 * Creates an `onUserDialog` callback for command-line applications.
 *
 * The renderer handles the Gateway's opt-in `input`, `select`, `confirm`,
 * and `form` dialogs. Form fields with a simple scalar/object shape receive
 * focused prompts; composition-heavy or unknown schema fragments use a JSON
 * editor fallback. Gateway remains the authoritative schema validator and
 * owner of the pending dialog/run lifecycle.
 */
export function createTerminalUserDialogHandler(
  options: PilotDeckTerminalDialogOptions = {},
): OnUserDialog {
  const normalized = normalizeTerminalOptions(options);
  return (request, context) => renderTerminalUserDialog(request, {
    io: normalized.io,
    maxAttempts: normalized.maxAttempts,
    signal: context.signal,
  });
}

/**
 * Renders one pending dialog in a terminal and returns an answer suitable for
 * `Query.respondUserDialog()` or `client.dialogs.respond()`. This is useful
 * with `userDialogMode: "manual"` after a live renderer reconnects.
 */
export async function renderTerminalUserDialog(
  request: PilotDeckUserDialogRequest,
  options: PilotDeckTerminalDialogOptions = {},
): Promise<PilotDeckUserDialogResult> {
  const { io, maxAttempts, signal } = normalizeTerminalOptions(options);
  if (signal.aborted) return cancelled("terminal dialog was aborted");
  try {
    switch (request.dialogKind) {
      case "input":
        return renderInput(request, io, signal, maxAttempts);
      case "select":
        return renderSelect(request, io, signal, maxAttempts);
      case "confirm":
        return renderConfirm(request, io, signal, maxAttempts);
      case "form":
        return renderForm(request, io, signal, maxAttempts);
      case "elicitation":
        return cancelled("terminal dialog renderer does not handle native elicitation");
    }
  } catch (error) {
    if (signal.aborted || isAbortError(error)) return cancelled("terminal dialog was aborted");
    const message = error instanceof Error ? error.message : String(error);
    io.write(`PilotDeck dialog cancelled: ${message}`);
    return cancelled("terminal dialog renderer failed");
  }
}

/** Default Node TTY adapter. Keep it lazy so SDK import never touches stdin. */
export function createNodeTerminalDialogIO(): PilotDeckTerminalDialogIO {
  return {
    async ask(prompt, options) {
      const terminal = createInterface({ input: stdin, output: stdout });
      try {
        return await terminal.question(prompt, { signal: options.signal });
      } catch (error) {
        if (isAbortError(error)) return undefined;
        throw error;
      } finally {
        terminal.close();
      }
    },
    write(line) {
      stdout.write(`${line}\n`);
    },
  };
}

function normalizeTerminalOptions(options: PilotDeckTerminalDialogOptions): {
  io: PilotDeckTerminalDialogIO;
  maxAttempts: number;
  signal: AbortSignal;
} {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new RangeError("maxAttempts must be an integer between 1 and 20.");
  }
  return {
    io: options.io ?? createNodeTerminalDialogIO(),
    maxAttempts,
    signal: options.signal ?? new AbortController().signal,
  };
}

async function renderInput(
  request: Extract<PilotDeckUserDialogRequest, { dialogKind: "input" }>,
  io: PilotDeckTerminalDialogIO,
  signal: AbortSignal,
  maxAttempts: number,
): Promise<PilotDeckUserDialogResult> {
  const { prompt, placeholder, allowEmpty } = request.payload;
  const suffix = placeholder ? ` (${placeholder})` : "";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const value = await io.ask(`${prompt}${suffix}: `, { signal });
    if (value === undefined) return cancelled("terminal input was cancelled");
    if (value.length > 0 || allowEmpty) return answered(value);
    io.write("A value is required.");
  }
  return cancelled("too many invalid terminal answers");
}

async function renderSelect(
  request: Extract<PilotDeckUserDialogRequest, { dialogKind: "select" }>,
  io: PilotDeckTerminalDialogIO,
  signal: AbortSignal,
  maxAttempts: number,
): Promise<PilotDeckUserDialogResult> {
  const { prompt, choices, defaultValue } = request.payload;
  io.write(prompt);
  choices.forEach((choice, index) => {
    const label = choice.label ?? choice.value;
    io.write(`  ${index + 1}. ${label}${choice.description ? ` - ${choice.description}` : ""}`);
  });
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const value = await io.ask(`Select a value${defaultValue !== undefined ? ` [${defaultValue}]` : ""}: `, { signal });
    if (value === undefined) return cancelled("terminal selection was cancelled");
    const selected = value.trim() === "" && defaultValue !== undefined
      ? defaultValue
      : choiceValue(choices, value);
    if (selected !== undefined) return answered(selected);
    io.write("Choose one of the displayed values or numbers.");
  }
  return cancelled("too many invalid terminal answers");
}

async function renderConfirm(
  request: Extract<PilotDeckUserDialogRequest, { dialogKind: "confirm" }>,
  io: PilotDeckTerminalDialogIO,
  signal: AbortSignal,
  maxAttempts: number,
): Promise<PilotDeckUserDialogResult> {
  const { prompt, confirmLabel, cancelLabel, defaultValue } = request.payload;
  const positive = confirmLabel ?? "yes";
  const negative = cancelLabel ?? "no";
  const defaultHint = defaultValue === undefined ? "" : defaultValue ? ` [${positive}]` : ` [${negative}]`;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const value = await io.ask(`${prompt} (${positive}/${negative})${defaultHint}: `, { signal });
    if (value === undefined) return cancelled("terminal confirmation was cancelled");
    const normalized = value.trim().toLowerCase();
    if (normalized === "" && defaultValue !== undefined) return answered(defaultValue);
    if (["y", "yes", "true", "1", positive.toLowerCase()].includes(normalized)) return answered(true);
    if (["n", "no", "false", "0", negative.toLowerCase()].includes(normalized)) return answered(false);
    io.write(`Answer ${positive} or ${negative}.`);
  }
  return cancelled("too many invalid terminal answers");
}

async function renderForm(
  request: Extract<PilotDeckUserDialogRequest, { dialogKind: "form" }>,
  io: PilotDeckTerminalDialogIO,
  signal: AbortSignal,
  maxAttempts: number,
): Promise<PilotDeckUserDialogResult> {
  const { prompt, schema } = request.payload;
  io.write(prompt);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const rendered = await renderObject(schema, schema, io, signal, maxAttempts, 0);
    if (rendered.kind === "cancelled") return cancelled(rendered.reason);
    if (rendered.kind !== "value") return cancelled("terminal form did not produce an answer");
    const issue = validateTerminalFormAnswer(schema, rendered.value);
    if (!issue) return answered(rendered.value);
    io.write(`The form does not match its schema: ${issue}`);
  }
  return cancelled("too many invalid terminal form answers");
}

function validateTerminalFormAnswer(
  schema: PilotDeckUserDialogFormSchema,
  value: unknown,
): string | undefined {
  const validator = getTerminalFormValidator(schema);
  if (!validator || validator(value)) return undefined;
  const error = validator.errors?.[0];
  if (!error) return "invalid form value";
  const location = error.instancePath || "form";
  return `${location} ${error.message ?? "is invalid"}`;
}

function getTerminalFormValidator(schema: PilotDeckUserDialogFormSchema): ValidateFunction | undefined {
  const cached = formValidators.get(schema);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: false,
      strictTuples: false,
      // Gateway remains authoritative for custom or provider-specific format
      // behavior. The renderer validates structural constraints only.
      validateFormats: false,
      unevaluated: true,
    });
    addFormats(ajv);
    const validator = ajv.compile(schema);
    formValidators.set(schema, validator);
    return validator;
  } catch {
    // A valid Gateway form can still use a local extension unknown to this
    // package. Do not reject it client-side: Gateway will validate it.
    formValidators.set(schema, null);
    return undefined;
  }
}

async function renderObject(
  schema: PilotDeckUserDialogFormFieldSchema,
  root: PilotDeckUserDialogFormSchema,
  io: PilotDeckTerminalDialogIO,
  signal: AbortSignal,
  maxAttempts: number,
  depth: number,
): Promise<PromptResult> {
  const resolved = resolveSchema(schema, root);
  if (!resolved || depth > 8 || !isPlainRecord(resolved.properties)) {
    return promptJsonObject(schemaLabel(resolved, "form value"), resolved?.default, io, signal, maxAttempts, false);
  }
  const result: Record<string, unknown> = {};
  const required = new Set(Array.isArray(resolved.required) ? resolved.required.filter((value): value is string => typeof value === "string") : []);
  for (const [name, field] of Object.entries(resolved.properties)) {
    const answer = await renderField(field, root, io, signal, maxAttempts, depth + 1, required.has(name), name);
    if (answer.kind === "cancelled") return answer;
    if (answer.kind === "value") result[name] = answer.value;
  }
  return { kind: "value", value: result };
}

async function renderField(
  schema: PilotDeckUserDialogFormFieldSchema,
  root: PilotDeckUserDialogFormSchema,
  io: PilotDeckTerminalDialogIO,
  signal: AbortSignal,
  maxAttempts: number,
  depth: number,
  required: boolean,
  fallbackLabel: string,
): Promise<PromptResult> {
  const resolved = resolveSchema(schema, root);
  if (!resolved) return promptJson(fallbackLabel, undefined, io, signal, maxAttempts, !required);
  if (resolved.const !== undefined) {
    io.write(`${schemaLabel(resolved, fallbackLabel)}: ${formatValue(resolved.const)} (fixed)`);
    return { kind: "value", value: resolved.const };
  }
  if (Array.isArray(resolved.enum)) {
    return promptEnum(schemaLabel(resolved, fallbackLabel), resolved.enum, resolved.default, io, signal, maxAttempts, !required);
  }
  if (hasComposition(resolved)) {
    return promptJson(schemaLabel(resolved, fallbackLabel), resolved.default, io, signal, maxAttempts, !required);
  }
  const type = singleType(resolved.type);
  if (type === "object") return renderObjectField(resolved, root, io, signal, maxAttempts, depth, required, fallbackLabel);
  if (type === "array" || type === undefined || type === "null") {
    return promptJson(schemaLabel(resolved, fallbackLabel), resolved.default, io, signal, maxAttempts, !required);
  }
  if (type === "boolean") return promptBoolean(schemaLabel(resolved, fallbackLabel), resolved.default, io, signal, maxAttempts, !required);
  if (type === "number" || type === "integer") {
    return promptNumber(schemaLabel(resolved, fallbackLabel), resolved, io, signal, maxAttempts, !required, type === "integer");
  }
  return promptString(schemaLabel(resolved, fallbackLabel), resolved, io, signal, maxAttempts, !required);
}

async function renderObjectField(
  schema: PilotDeckUserDialogFormFieldSchema,
  root: PilotDeckUserDialogFormSchema,
  io: PilotDeckTerminalDialogIO,
  signal: AbortSignal,
  maxAttempts: number,
  depth: number,
  required: boolean,
  fallbackLabel: string,
): Promise<PromptResult> {
  if (!isPlainRecord(schema.properties)) {
    return promptJsonObject(schemaLabel(schema, fallbackLabel), schema.default, io, signal, maxAttempts, !required);
  }
  io.write(`${schemaLabel(schema, fallbackLabel)}:`);
  return renderObject(schema, root, io, signal, maxAttempts, depth + 1);
}

async function promptString(
  label: string,
  schema: PilotDeckUserDialogFormFieldSchema,
  io: PilotDeckTerminalDialogIO,
  signal: AbortSignal,
  maxAttempts: number,
  optional: boolean,
): Promise<PromptResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const raw = await askWithDefault(io, `${label}: `, schema.default, signal);
    if (raw === undefined) return { kind: "cancelled", reason: "terminal form was cancelled" };
    if (raw === "" && optional && schema.default === undefined) return { kind: "omitted" };
    const issue = validateString(raw, schema);
    if (!issue) return { kind: "value", value: raw };
    io.write(issue);
  }
  return { kind: "cancelled", reason: "too many invalid terminal answers" };
}

async function promptNumber(
  label: string,
  schema: PilotDeckUserDialogFormFieldSchema,
  io: PilotDeckTerminalDialogIO,
  signal: AbortSignal,
  maxAttempts: number,
  optional: boolean,
  integer: boolean,
): Promise<PromptResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const raw = await askWithDefault(io, `${label}: `, schema.default, signal);
    if (raw === undefined) return { kind: "cancelled", reason: "terminal form was cancelled" };
    if (raw === "" && optional && schema.default === undefined) return { kind: "omitted" };
    const value = Number(raw);
    const issue = !Number.isFinite(value) || (integer && !Number.isInteger(value))
      ? `Enter a ${integer ? "whole number" : "number"}.`
      : validateNumber(value, schema);
    if (!issue) return { kind: "value", value };
    io.write(issue);
  }
  return { kind: "cancelled", reason: "too many invalid terminal answers" };
}

async function promptBoolean(
  label: string,
  defaultValue: unknown,
  io: PilotDeckTerminalDialogIO,
  signal: AbortSignal,
  maxAttempts: number,
  optional: boolean,
): Promise<PromptResult> {
  const defaultBoolean = typeof defaultValue === "boolean" ? defaultValue : undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const raw = await io.ask(`${label} (yes/no)${defaultBoolean === undefined ? "" : defaultBoolean ? " [yes]" : " [no]"}: `, { signal });
    if (raw === undefined) return { kind: "cancelled", reason: "terminal form was cancelled" };
    const normalized = raw.trim().toLowerCase();
    if (normalized === "" && defaultBoolean !== undefined) return { kind: "value", value: defaultBoolean };
    if (normalized === "" && optional) return { kind: "omitted" };
    if (["y", "yes", "true", "1"].includes(normalized)) return { kind: "value", value: true };
    if (["n", "no", "false", "0"].includes(normalized)) return { kind: "value", value: false };
    io.write("Answer yes or no.");
  }
  return { kind: "cancelled", reason: "too many invalid terminal answers" };
}

async function promptEnum(
  label: string,
  values: unknown[],
  defaultValue: unknown,
  io: PilotDeckTerminalDialogIO,
  signal: AbortSignal,
  maxAttempts: number,
  optional: boolean,
): Promise<PromptResult> {
  io.write(label);
  values.forEach((value, index) => io.write(`  ${index + 1}. ${formatValue(value)}`));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const raw = await io.ask("Select a value: ", { signal });
    if (raw === undefined) return { kind: "cancelled", reason: "terminal form was cancelled" };
    if (raw.trim() === "" && defaultValue !== undefined) return { kind: "value", value: defaultValue };
    if (raw.trim() === "" && optional) return { kind: "omitted" };
    const byIndex = Number(raw);
    const candidate = Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= values.length
      ? values[byIndex - 1]
      : parseJson(raw);
    if (candidate !== undefined && values.some((value) => jsonEqual(value, candidate))) return { kind: "value", value: candidate };
    io.write("Choose one of the displayed values or enter its JSON value.");
  }
  return { kind: "cancelled", reason: "too many invalid terminal answers" };
}

async function promptJson(
  label: string,
  defaultValue: unknown,
  io: PilotDeckTerminalDialogIO,
  signal: AbortSignal,
  maxAttempts: number,
  optional: boolean,
): Promise<PromptResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const raw = await askWithDefault(io, `${label} (JSON): `, defaultValue, signal);
    if (raw === undefined) return { kind: "cancelled", reason: "terminal form was cancelled" };
    if (raw.trim() === "" && optional && defaultValue === undefined) return { kind: "omitted" };
    const parsed = parseJson(raw);
    if (parsed !== undefined) return { kind: "value", value: parsed };
    io.write("Enter valid JSON.");
  }
  return { kind: "cancelled", reason: "too many invalid terminal answers" };
}

async function promptJsonObject(
  label: string,
  defaultValue: unknown,
  io: PilotDeckTerminalDialogIO,
  signal: AbortSignal,
  maxAttempts: number,
  optional: boolean,
): Promise<PromptResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const raw = await askWithDefault(io, `${label} (JSON object): `, defaultValue, signal);
    if (raw === undefined) return { kind: "cancelled", reason: "terminal form was cancelled" };
    if (raw.trim() === "" && optional && defaultValue === undefined) return { kind: "omitted" };
    const parsed = parseJson(raw);
    if (isPlainRecord(parsed)) return { kind: "value", value: parsed };
    io.write("Enter a JSON object.");
  }
  return { kind: "cancelled", reason: "too many invalid terminal answers" };
}

async function askWithDefault(
  io: PilotDeckTerminalDialogIO,
  prompt: string,
  defaultValue: unknown,
  signal: AbortSignal,
): Promise<string | undefined> {
  const hint = defaultValue === undefined ? "" : ` [${formatValue(defaultValue)}]`;
  const raw = await io.ask(`${prompt.trimEnd()}${hint}: `, { signal });
  if (raw === "" && defaultValue !== undefined) return typeof defaultValue === "string" ? defaultValue : JSON.stringify(defaultValue);
  return raw;
}

function resolveSchema(
  schema: PilotDeckUserDialogFormFieldSchema,
  root: PilotDeckUserDialogFormSchema,
): PilotDeckUserDialogFormFieldSchema | undefined {
  if (!schema.$ref) return schema;
  const target = localJsonPointer(root, schema.$ref);
  if (!isPlainRecord(target)) return undefined;
  const { $ref: _reference, ...rest } = schema;
  return { ...target, ...rest } as PilotDeckUserDialogFormFieldSchema;
}

function localJsonPointer(root: unknown, reference: string): unknown {
  if (!reference.startsWith("#/")) return undefined;
  let value = root;
  for (const rawPart of reference.slice(2).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(value) && /^\d+$/u.test(part)) value = value[Number(part)];
    else if (isPlainRecord(value)) value = value[part];
    else return undefined;
  }
  return value;
}

function hasComposition(schema: PilotDeckUserDialogFormFieldSchema): boolean {
  return schema.allOf !== undefined || schema.anyOf !== undefined || schema.oneOf !== undefined
    || schema.not !== undefined || schema.if !== undefined || schema.then !== undefined || schema.else !== undefined
    || schema.dependentSchemas !== undefined || schema.dependentRequired !== undefined;
}

function singleType(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") return value[0];
  return undefined;
}

function schemaLabel(schema: PilotDeckUserDialogFormFieldSchema | undefined, fallback: string): string {
  const title = typeof schema?.title === "string" && schema.title.trim() ? schema.title.trim() : fallback;
  return typeof schema?.description === "string" && schema.description.trim()
    ? `${title} - ${schema.description.trim()}`
    : title;
}

function validateString(value: string, schema: PilotDeckUserDialogFormFieldSchema): string | undefined {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) return `Enter at least ${schema.minLength} characters.`;
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `Enter at most ${schema.maxLength} characters.`;
  if (typeof schema.pattern === "string") {
    try {
      if (!(new RegExp(schema.pattern)).test(value)) return "The value does not match the required pattern.";
    } catch {
      // Gateway performs the authoritative schema validation. A malformed
      // local regex should not make the renderer manufacture a different rule.
    }
  }
  return undefined;
}

function validateNumber(value: number, schema: PilotDeckUserDialogFormFieldSchema): string | undefined {
  if (typeof schema.minimum === "number" && value < schema.minimum) return `Enter a value greater than or equal to ${schema.minimum}.`;
  if (typeof schema.maximum === "number" && value > schema.maximum) return `Enter a value less than or equal to ${schema.maximum}.`;
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return `Enter a value greater than ${schema.exclusiveMinimum}.`;
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return `Enter a value less than ${schema.exclusiveMaximum}.`;
  if (typeof schema.multipleOf === "number" && schema.multipleOf > 0 && !Number.isInteger(value / schema.multipleOf)) {
    return `Enter a multiple of ${schema.multipleOf}.`;
  }
  return undefined;
}

function choiceValue(choices: Array<{ value: string }>, raw: string): string | undefined {
  const trimmed = raw.trim();
  const index = Number(trimmed);
  if (Number.isInteger(index) && index >= 1 && index <= choices.length) return choices[index - 1]?.value;
  return choices.find((choice) => choice.value === trimmed)?.value;
}

function answered(value: unknown): PilotDeckUserDialogResult {
  return { behavior: "answered", value };
}

function cancelled(reason: string): PilotDeckUserDialogResult {
  return { behavior: "cancelled", reason };
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "ABORT_ERR");
}

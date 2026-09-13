/**
 * Deterministic L1 checks over a subagent delivery report.
 *
 * Principles (fixed by product decision):
 * - Only *meaningful* supplied fields are checked. Absent / null / whitespace
 *   strings / recursively empty objects / empty arrays are skipped entirely;
 *   `0` and `false` are real content. An all-empty report is `skipped`, never
 *   `passed`.
 * - A declared file is a `{file: string}` object anywhere in the report, or a
 *   string sitting at a parent-schema position marked `x-file: true`.
 *   Arbitrary path-looking strings are never guessed.
 * - File / line checks prove existence and locatability only. Deleted paths
 *   belong in descriptive fields, not in existing-file declarations.
 * - The workspace permission boundary holds: roots and files are realpath'd;
 *   reads through symlinks that escape the workspace produce an explicit
 *   issue, never expanded access.
 * - Bounded recursion, bounded reads (1 MiB), no network, no model calls.
 */

import path from "node:path";
import { open, realpath, stat } from "node:fs/promises";

import type { DeliveryChecks, DeliveryContract, DeliveryIssue } from "./types.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Hard cap for a delivery JSON payload (parseDelivery). */
export const MAX_DELIVERY_JSON_BYTES = 1024 * 1024;
/** Hard cap for a single file read during locator checks. */
export const MAX_FILE_READ_BYTES = 1024 * 1024;
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 24;
const MAX_SCHEMA_NODES = 512;
const MAX_WALK_DEPTH = 32;
const MAX_WALK_NODES = 10_000;
/** Cap on entries per `locations` array; keeps pathological reports cheap. */
const MAX_LOCATIONS_ENTRIES = 64;

const SCHEMA_KEYWORDS = new Set(["type", "properties", "items", "title", "description", "x-file"]);
const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "boolean"]);

// ---------------------------------------------------------------------------
// Contract validation (throws before any model call)
// ---------------------------------------------------------------------------

/** Thrown for malformed delivery contracts; message is developer-facing. */
export class DeliveryContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryContractError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type SchemaWalkState = { nodes: number };

function assertSchemaNode(node: unknown, at: string, state: SchemaWalkState, depth: number): void {
  if (!isPlainObject(node)) {
    throw new DeliveryContractError(`Schema node at ${at} must be an object.`);
  }
  if (++state.nodes > MAX_SCHEMA_NODES) {
    throw new DeliveryContractError(`Schema exceeds the ${MAX_SCHEMA_NODES}-node complexity limit at ${at}.`);
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new DeliveryContractError(`Schema exceeds the ${MAX_SCHEMA_DEPTH}-level depth limit at ${at}.`);
  }
  for (const key of Object.keys(node)) {
    if (!SCHEMA_KEYWORDS.has(key)) {
      throw new DeliveryContractError(
        `Unsupported schema keyword "${key}" at ${at}. Supported: type, properties, items, title, description, x-file.`,
      );
    }
  }

  const type = node.type;
  if (type !== undefined) {
    if (typeof type !== "string" || !SCHEMA_TYPES.has(type)) {
      throw new DeliveryContractError(
        `Schema "type" at ${at} must be one of ${[...SCHEMA_TYPES].join(", ")} when present.`,
      );
    }
  }
  if (node.properties !== undefined) {
    if (type !== "object") {
      throw new DeliveryContractError(`Schema node at ${at} constrains properties, so it must declare type "object".`);
    }
    const properties = node.properties;
    if (!isPlainObject(properties)) {
      throw new DeliveryContractError(`Schema "properties" at ${at} must be an object.`);
    }
    for (const [key, child] of Object.entries(properties)) {
      assertSchemaNode(child, `${at}.properties.${key}`, state, depth + 1);
    }
  }
  if (node.items !== undefined) {
    if (type !== "array") {
      throw new DeliveryContractError(`Schema node at ${at} constrains items, so it must declare type "array".`);
    }
    assertSchemaNode(node.items, `${at}.items`, state, depth + 1);
  }
  if (node.title !== undefined && typeof node.title !== "string") {
    throw new DeliveryContractError(`Schema "title" at ${at} must be a string.`);
  }
  if (node.description !== undefined && typeof node.description !== "string") {
    throw new DeliveryContractError(`Schema "description" at ${at} must be a string.`);
  }
  if (node["x-file"] !== undefined && typeof node["x-file"] !== "boolean") {
    throw new DeliveryContractError(`Schema "x-file" at ${at} must be a boolean.`);
  }
}

/**
 * Validates a delivery contract eagerly (call before any model spends tokens).
 * Empty/undefined contracts normalize to `{}`. Throws descriptive
 * {@link DeliveryContractError}s for invalid shapes, unknown options, and
 * unsupported schema keywords.
 */
export function validateDeliveryContract(contract: unknown): DeliveryContract {
  if (contract === undefined || contract === null) return {};
  if (!isPlainObject(contract)) {
    throw new DeliveryContractError("DeliveryContract must be an object (or undefined).");
  }
  for (const key of Object.keys(contract)) {
    if (key !== "schema" && key !== "review") {
      throw new DeliveryContractError(`Unknown DeliveryContract option "${key}". Supported: schema, review.`);
    }
  }
  const result: DeliveryContract = {};
  const review = contract.review;
  if (review !== undefined) {
    if (typeof review !== "boolean") {
      throw new DeliveryContractError('DeliveryContract "review" must be a boolean.');
    }
    result.review = review;
  }
  const schema = contract.schema;
  if (schema !== undefined) {
    if (!isPlainObject(schema)) {
      throw new DeliveryContractError('DeliveryContract "schema" must be an object (or undefined).');
    }
    assertSchemaNode(schema, "schema", { nodes: 0 }, 0);
    if (Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_SCHEMA_BYTES) {
      throw new DeliveryContractError(`Schema exceeds the ${MAX_SCHEMA_BYTES}-byte size limit.`);
    }
    result.schema = structuredClone(schema);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Bounded recursive emptiness
// ---------------------------------------------------------------------------

const CONTENT_MAX_DEPTH = 32;
const CONTENT_MAX_NODES = 10_000;

/**
 * Bounded recursive emptiness test. `0`, `false`, non-whitespace strings are
 * content; absent, null, whitespace strings, recursively empty objects and
 * empty arrays are not.
 */
export function hasDeliveryContent(value: unknown): boolean {
  const seen = new Set<unknown>();
  let nodes = 0;
  const visit = (node: unknown, depth: number): boolean => {
    if (node === null || node === undefined) return false;
    if (depth > CONTENT_MAX_DEPTH) return true; // Unknown coverage is content; the checker reports its bound.
    if (++nodes > CONTENT_MAX_NODES) return true;
    switch (typeof node) {
      case "string":
        return node.trim().length > 0;
      case "number":
      case "boolean":
      case "bigint":
        return true; // 0 and false are real, present values
      case "object": {
        if (seen.has(node)) return false; // cycle guard
        seen.add(node);
        if (Array.isArray(node)) {
          return node.some((element) => visit(element, depth + 1));
        }
        for (const child of Object.values(node)) {
          if (visit(child, depth + 1)) return true;
        }
        return false;
      }
      default:
        return false; // functions, symbols, undefined
    }
  };
  return visit(value, 0);
}

// ---------------------------------------------------------------------------
// parseDelivery
// ---------------------------------------------------------------------------

export type ParsedDelivery = { value?: unknown; rawText?: string; issue?: DeliveryIssue };

const FENCE_RE = /^\uFEFF?```[ \t]*[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```[ \t]*$/;
/** Opening fence line with no closing fence required; captures info string + body. */
const OPEN_FENCE_RE = /^\uFEFF?```[ \t]*([A-Za-z0-9_-]*)[ \t]*(?:\r?\n)?([\s\S]*)$/;

function looksLikeJson(text: string): boolean {
  return text.startsWith("{") || text.startsWith("[") || text.startsWith('"');
}

function parseJsonObject(text: string): { value?: Record<string, unknown>; issue?: DeliveryIssue } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isPlainObject(parsed)) return { value: parsed };
    return {
      issue: {
        path: "$",
        code: "not_object",
        message: "Delivery must be a single JSON object; got another JSON value.",
      },
    };
  } catch {
    return {
      issue: {
        path: "$",
        code: "malformed_json",
        message: "Delivery looks like JSON but does not parse; it was not silently repaired.",
      },
    };
  }
}

/**
 * Parses a child's final message into a delivery value.
 * - empty / whitespace → empty object
 * - one JSON object, plain, inside a single enclosing fence, or behind one
 *   unclosed opening fence whose full remaining body parses to one object →
 *   value (formatting tolerance)
 * - ordinary prose → rawText (no parsing attempted)
 * - JSON-looking but malformed (or non-object JSON) → explicit issue, never
 *   silently treated as prose
 */
export function parseDelivery(text: string): ParsedDelivery {
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > MAX_DELIVERY_JSON_BYTES) {
    return {
      issue: {
        path: "$",
        code: "delivery_too_large",
        message: `Delivery exceeds the ${MAX_DELIVERY_JSON_BYTES}-byte limit (${byteLength} bytes); the archive keeps only a bounded failure receipt.`,
      },
    };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return { value: {} };

  const fenced = FENCE_RE.exec(trimmed);
  if (fenced) {
    const inner = (fenced[1] ?? "").trim();
    if (inner.length === 0) return { value: {} };
    return parseJsonObject(inner);
  }
  // Formatting tolerance for one opening fence that was never closed: the
  // full remaining body must parse to one JSON object. A declared (```json)
  // or JSON-looking fence that fails to parse is an explicit issue, never
  // prose/skipped; an untyped fence holding ordinary prose stays prose.
  const unclosed = OPEN_FENCE_RE.exec(trimmed);
  if (unclosed) {
    const info = (unclosed[1] ?? "").toLowerCase();
    const body = (unclosed[2] ?? "").trim();
    if (info === "json" || looksLikeJson(body)) {
      if (body.length === 0) return { value: {} };
      return parseJsonObject(body);
    }
  }
  if (looksLikeJson(trimmed)) {
    return parseJsonObject(trimmed);
  }
  return { rawText: text };
}

// ---------------------------------------------------------------------------
// File resolution (shared with the review packet builder)
// ---------------------------------------------------------------------------

export type DeclaredFileResolution =
  | { ok: true; absolutePath: string; realPath: string; sizeBytes: number }
  | { ok: false; code: "file_missing" | "file_not_regular" | "outside_workspace" | "invalid_path"; message: string };

export function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("operation aborted");
  }
}

/**
 * Resolves a declared file against `cwd` under the workspace permission
 * boundary: both the file and the root are realpath'd, so reads through
 * symlinks escaping the workspace are rejected (`outside_workspace`) instead
 * of silently expanding access.
 */
export async function resolveDeclaredFile(
  rawPath: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<DeclaredFileResolution> {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0 || rawPath.includes("\0")) {
    return { ok: false, code: "invalid_path", message: "Declared file path must be a non-empty string." };
  }
  const absolutePath = path.resolve(cwd, rawPath);
  const realRoot = await realpath(cwd);
  throwIfAborted(signal);
  let realPath: string;
  try {
    realPath = await realpath(absolutePath);
  } catch {
    return {
      ok: false,
      code: "file_missing",
      message: `Declared file does not exist: ${rawPath}`,
    };
  }
  if (!isPathWithinRoot(realPath, realRoot)) {
    return {
      ok: false,
      code: "outside_workspace",
      message: `Declared file resolves outside the workspace via a symlink: ${rawPath} -> ${realPath}`,
    };
  }
  const info = await stat(realPath).catch(() => undefined);
  if (!info) {
    return { ok: false, code: "file_missing", message: `Declared file does not exist: ${rawPath}` };
  }
  if (!info.isFile()) {
    return { ok: false, code: "file_not_regular", message: `Declared file is not a regular file: ${rawPath}` };
  }
  return { ok: true, absolutePath, realPath, sizeBytes: info.size };
}

/** Reads at most `limit` bytes; reports whether the file continues beyond. */
async function readBounded(
  absolutePath: string,
  limit: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const handle = await open(absolutePath, "r");
  try {
    const bytes = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(bytes, 0, limit, 0);
    const stats = await handle.stat().catch(() => undefined);
    const truncated = stats ? stats.size > bytesRead : bytesRead === limit;
    return { bytes: bytes.subarray(0, bytesRead), truncated };
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// checkDelivery
// ---------------------------------------------------------------------------

export type CheckDeliveryOptions = {
  cwd: string;
  schema?: Record<string, unknown>;
  signal?: AbortSignal;
};

type CheckState = {
  cwd: string;
  signal?: AbortSignal;
  issues: DeliveryIssue[];
  checked: number;
  nodes: number;
  overBudget: boolean;
  /** One resolution per declared-file field path (schema `x-file` + generic `{file}` walks share it). */
  fileResolutions: Map<string, DeclaredFileResolution>;
};

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

function pushIssue(state: CheckState, path: string, code: string, message: string): void {
  // Root-level issues are addressed as "$"; everything else is a relative
  // dot path like "steps.0.output.file".
  state.issues.push({ path: path === "" ? "$" : path, code, message });
}

/** Dot-path join with an empty root, e.g. ("", "steps") → "steps". */
function joinPath(at: string, key: string | number): string {
  return at === "" ? String(key) : `${at}.${key}`;
}

/**
 * Resolves one declared-file field at most once per report path. The schema
 * pass (`x-file` leaves) and the generic `{file}` walk visit the same field
 * under the same dot path; the second visitor reuses the first resolution so
 * the file is checked once and resolution issues are not duplicated. Location
 * validation is never deduped: only the generic walker supplies `locations`.
 */
async function resolveFieldFile(state: CheckState, rawPath: string, at: string): Promise<DeclaredFileResolution> {
  const cached = state.fileResolutions.get(at);
  if (cached) return cached;
  state.checked += 1;
  const resolved = await resolveDeclaredFile(rawPath, state.cwd, state.signal);
  state.fileResolutions.set(at, resolved);
  if (!resolved.ok) {
    pushIssue(state, at, resolved.code, resolved.message);
  }
  return resolved;
}

async function checkFileDeclaration(state: CheckState, rawPath: string, at: string, locations: unknown): Promise<void> {
  const resolved = await resolveFieldFile(state, rawPath, at);
  if (!resolved.ok) {
    return;
  }
  if (!Array.isArray(locations)) {
    if (hasDeliveryContent(locations)) {
      pushIssue(state, `${at}.locations`, "invalid_locations", "locations must be an array of {startLine,endLine}.");
      state.checked += 1;
    }
    return; // stats-only check: no read, safe for large binaries
  }
  await checkLocations(state, resolved.realPath, at, locations);
}

async function checkLocations(
  state: CheckState,
  absolutePath: string,
  at: string,
  locations: unknown[],
): Promise<void> {
  throwIfAborted(state.signal);
  let text: string;
  let truncated: boolean;
  try {
    const read = await readBounded(absolutePath, MAX_FILE_READ_BYTES);
    text = read.bytes.toString("utf8").replace(/^\uFEFF/, "");
    truncated = read.truncated;
  } catch (error) {
    pushIssue(
      state,
      `${at}.locations`,
      "read_error",
      `Could not read declared file for locator checks: ${error instanceof Error ? error.message : String(error)}`,
    );
    state.checked += 1;
    return;
  }
  if (text.includes("\u0000")) {
    pushIssue(
      state,
      `${at}.locations`,
      "binary_file",
      "Declared file is binary; line locators cannot be verified.",
    );
    state.checked += 1;
    return;
  }
  const lines = text.length === 0 ? [] : text.split("\n");

  const entries = locations.slice(0, MAX_LOCATIONS_ENTRIES);
  for (const [index, entry] of entries.entries()) {
    if (!hasDeliveryContent(entry)) continue;
    state.checked += 1;
    const atEntry = `${at}.locations.${index}`;
    if (!isPlainObject(entry)) {
      pushIssue(state, atEntry, "invalid_locator", "Each location must be an object with optional startLine/endLine.");
      continue;
    }
    const start = entry.startLine;
    const end = entry.endLine;
    let startNumber: number | undefined;
    let endNumber: number | undefined;
    let entryInvalid = false;
    if (start !== undefined && start !== null) {
      if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 1) {
        pushIssue(state, `${atEntry}.startLine`, "invalid_locator", "startLine must be a positive integer when supplied.");
        entryInvalid = true;
      } else {
        startNumber = start;
      }
    }
    if (end !== undefined && end !== null) {
      if (typeof end !== "number" || !Number.isSafeInteger(end) || end < 1) {
        pushIssue(state, `${atEntry}.endLine`, "invalid_locator", "endLine must be a positive integer when supplied.");
        entryInvalid = true;
      } else {
        endNumber = end;
      }
    }
    if (entryInvalid) continue;
    if (startNumber !== undefined && endNumber !== undefined && endNumber < startNumber) {
      pushIssue(state, atEntry, "line_order", `endLine (${endNumber}) precedes startLine (${startNumber}).`);
      continue;
    }
    for (const [label, line] of [["startLine", startNumber], ["endLine", endNumber]] as const) {
      if (line === undefined) continue;
      if (line <= lines.length) continue;
      if (truncated) {
        pushIssue(state, `${atEntry}.${label}`, "locator_unverified", "The location exceeds the bounded text read; it was not verified.");
        continue;
      }
      pushIssue(
        state,
        `${atEntry}.${label}`,
        "line_out_of_range",
        `${label} ${line} is beyond the current text of the file (${lines.length} lines).`,
      );
    }
  }
  if (locations.length > MAX_LOCATIONS_ENTRIES) {
    pushIssue(
      state,
      `${at}.locations`,
      "locations_capped",
      `Only the first ${MAX_LOCATIONS_ENTRIES} location entries were verified.`,
    );
  }
}

async function walkFiles(state: CheckState, node: unknown, at: string, depth: number): Promise<void> {
  if (depth > MAX_WALK_DEPTH) {
    if (!state.overBudget) {
      state.overBudget = true;
      pushIssue(state, at, "bounds_exceeded", `Delivery nesting exceeds ${MAX_WALK_DEPTH} levels; deeper file declarations were not checked.`);
    }
    return;
  }
  if (++state.nodes > MAX_WALK_NODES) {
    if (!state.overBudget) {
      state.overBudget = true;
      pushIssue(state, at, "bounds_exceeded", `Delivery exceeds ${MAX_WALK_NODES} nodes; remaining file declarations were not checked.`);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const [index, element] of node.entries()) {
      await walkFiles(state, element, joinPath(at, index), depth + 1);
    }
    return;
  }
  if (!isPlainObject(node)) return; // strings are never guessed to be paths

  const fileValue = node.file;
  if (Object.prototype.hasOwnProperty.call(node, "file")) {
    if (typeof fileValue === "string") {
      if (hasDeliveryContent(fileValue)) {
        await checkFileDeclaration(state, fileValue, joinPath(at, "file"), node.locations);
      }
    } else if (hasDeliveryContent(fileValue)) {
      state.checked += 1;
      pushIssue(
        state,
        joinPath(at, "file"),
        "invalid_file_field",
        '"file" must be a non-empty string path relative to the workspace.',
      );
    }
  }
  for (const [key, child] of Object.entries(node)) {
    if (child !== null && typeof child === "object") {
      await walkFiles(state, child, joinPath(at, key), depth + 1);
    }
  }
}

async function walkSchema(
  state: CheckState,
  value: unknown,
  schema: Record<string, unknown>,
  at: string,
  depth: number,
): Promise<void> {
  if (depth > MAX_WALK_DEPTH || ++state.nodes > MAX_WALK_NODES) {
    if (!state.overBudget) {
      state.overBudget = true;
      pushIssue(state, at, "bounds_exceeded", "Delivery exceeds structural bounds; remaining schema leaves were not checked.");
    }
    return;
  }
  const populated = hasDeliveryContent(value);
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type !== undefined && populated) {
    state.checked += 1;
    if (!typeMatches(type, value)) {
      pushIssue(
        state,
        at,
        "type_mismatch",
        `Expected ${type} at ${at}, got ${Array.isArray(value) ? "array" : typeof value}.`,
      );
    }
  }
  if (schema["x-file"] === true) {
    if (!populated) return; // empty file reference is skipped like any empty field
    if (typeof value !== "string") {
      state.checked += 1;
      pushIssue(state, at, "invalid_file_field", '"x-file" fields must hold a non-empty string path.');
      return;
    }
    if (hasDeliveryContent(value)) {
      await checkFileDeclaration(state, value, at, undefined);
    }
    return; // an x-file leaf holds a scalar; no recursion
  }
  if ((type === "object" || schema.properties !== undefined) && isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      const child = value[key];
      if (hasDeliveryContent(child)) {
        await walkSchema(state, child, childSchema as Record<string, unknown>, joinPath(at, key), depth + 1);
      }
    }
    return;
  }
  if ((type === "array" || schema.items !== undefined) && Array.isArray(value)) {
    const items = isPlainObject(schema.items) ? schema.items : {};
    for (const [index, element] of value.entries()) {
      if (hasDeliveryContent(element)) {
        await walkSchema(state, element, items, joinPath(at, index), depth + 1);
      }
    }
  }
}

/**
 * Runs the deterministic L1 checks. Empty reports are `skipped`; any issue
 * fails the attempt; internal faults and aborts surface as `error` with a
 * reason. Never reads files outside the workspace, never reads large
 * binaries (stats only), performs no network or model calls.
 */
export async function checkDelivery(value: unknown, options: CheckDeliveryOptions): Promise<DeliveryChecks> {
  const state: CheckState = {
    cwd: options.cwd,
    signal: options.signal,
    issues: [],
    checked: 0,
    nodes: 0,
    overBudget: false,
    fileResolutions: new Map(),
  };
  try {
    throwIfAborted(options.signal);
    if (!hasDeliveryContent(value)) {
      return { status: "skipped", checked: 0, issues: [], reason: "delivery has no meaningful content" };
    }
    // Defensive re-validation keeps checkDelivery safe against raw schemas.
    const contract = validateDeliveryContract({ schema: options.schema });
    if (contract.schema) {
      await walkSchema(state, value, contract.schema, "", 0);
    }
    await walkFiles(state, value, "", 0);
    return {
      status: state.issues.length > 0 ? "failed" : state.checked > 0 ? "passed" : "skipped",
      ...(state.checked === 0 && !state.issues.length ? { reason: "No supplied fields had applicable checks." } : {}),
      checked: state.checked,
      issues: state.issues,
    };
  } catch (error) {
    return {
      status: "error",
      checked: state.checked,
      issues: state.issues,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

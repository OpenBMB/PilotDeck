import * as Ajv2020Module from "ajv/dist/2020.js";
import * as AjvFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv/dist/2020.js";
import type { PilotDeckBrowserDialogDriver } from "./browser-dialog.js";
import type {
  PilotDeckUserDialogFormFieldSchema,
  PilotDeckUserDialogFormSchema,
  PilotDeckUserDialogRequest,
  PilotDeckUserDialogResult,
} from "./types.js";

/**
 * Options for the SDK-provided browser DOM dialog renderer. The application
 * supplies the document/mount when it owns an iframe, shadow-root host, or a
 * test DOM. No Gateway connection or dialog state is created by this module.
 */
export type PilotDeckDomBrowserDialogOptions = {
  document?: Document;
  mount?: HTMLElement;
  className?: string;
  submitLabel?: string;
  cancelLabel?: string;
};

type DomRenderOptions = PilotDeckDomBrowserDialogOptions & { signal: AbortSignal };
type FormValue = unknown | typeof OMITTED;
type FormFieldReader = { name: string; read(): FormValue };

const OMITTED = Symbol("pilotdeck-dom-dialog-omitted");
const formValidators = new WeakMap<object, ValidateFunction | null>();

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

// Keep browser import evaluation free of Node's createRequire while handling
// Ajv's CommonJS-shaped declaration files under NodeNext module resolution.
const Ajv2020 = Ajv2020Module.default as unknown as Draft202012Constructor;
const addFormats = AjvFormatsModule.default as unknown as (validator: Draft202012Validator) => unknown;

/**
 * Creates a framework-free browser dialog driver. It renders native DOM form
 * controls for Gateway's supported dialog schemas and can be passed directly
 * to `createBrowserUserDialogHandler({ driver })`.
 */
export function createDomBrowserDialogDriver(
  options: PilotDeckDomBrowserDialogOptions = {},
): PilotDeckBrowserDialogDriver {
  const document = resolveDocument(options.document);
  const mount = options.mount ?? document.body;
  if (!mount || typeof mount.append !== "function") {
    throw new Error("A DOM dialog renderer requires a mount element.");
  }
  return {
    render: (request, context) => renderDomBrowserUserDialog(request, {
      ...options,
      document,
      mount,
      signal: context.signal,
    }),
  };
}

/**
 * Renders one Gateway-owned pending dialog as a DOM modal. Applications using
 * `userDialogMode: "manual"` can call this and submit the returned result via
 * `Query.respondUserDialog()` or `client.dialogs.respond()`.
 */
export function renderDomBrowserUserDialog(
  request: PilotDeckUserDialogRequest,
  options: DomRenderOptions,
): Promise<PilotDeckUserDialogResult> {
  const document = resolveDocument(options.document);
  const mount = options.mount ?? document.body;
  if (!mount || typeof mount.append !== "function") {
    return Promise.resolve(cancelled("browser DOM dialog mount is unavailable"));
  }
  if (options.signal.aborted) return Promise.resolve(cancelled("browser dialog was aborted"));
  if (request.dialogKind === "elicitation") {
    return Promise.resolve(cancelled("browser DOM dialog renderer does not handle native elicitation"));
  }

  return new Promise((resolve) => {
    const root = document.createElement("section");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("data-pilotdeck-dialog", "true");
    root.setAttribute("data-pilotdeck-dialog-request-id", request.requestId);
    if (options.className) root.className = options.className;

    const form = document.createElement("form");
    form.noValidate = true;
    root.append(form);

    const title = document.createElement("h2");
    title.textContent = dialogTitle(request);
    form.append(title);

    const prompt = document.createElement("p");
    prompt.textContent = request.payload.prompt;
    form.append(prompt);

    const error = document.createElement("p");
    error.setAttribute("role", "alert");
    error.hidden = true;
    form.append(error);

    let readAnswer: () => unknown;
    switch (request.dialogKind) {
      case "input":
        readAnswer = appendInputControl(document, form, request.payload);
        break;
      case "select":
        readAnswer = appendSelectControl(document, form, request.payload);
        break;
      case "confirm":
        readAnswer = appendConfirmControl(document, form, request.payload);
        break;
      case "form":
        readAnswer = appendFormControls(document, form, request.payload.schema, request.requestId);
        break;
      default:
        readAnswer = () => undefined;
    }

    const actions = document.createElement("div");
    actions.setAttribute("data-pilotdeck-dialog-actions", "true");
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = options.submitLabel ?? submitLabel(request);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = options.cancelLabel ?? (request.dialogKind === "confirm"
      ? (request.payload.cancelLabel ?? "Cancel")
      : "Cancel");
    actions.append(submit, cancel);
    form.append(actions);

    let settled = false;
    const finish = (result: PilotDeckUserDialogResult) => {
      if (settled) return;
      settled = true;
      form.removeEventListener("submit", onSubmit);
      cancel.removeEventListener("click", onCancel);
      options.signal.removeEventListener("abort", onAbort);
      root.remove();
      resolve(result);
    };
    const showError = (message: string) => {
      error.textContent = message;
      error.hidden = false;
    };
    const onSubmit = (event: SubmitEvent) => {
      event.preventDefault();
      if (typeof form.checkValidity === "function" && !form.checkValidity()) {
        form.reportValidity?.();
        return;
      }
      try {
        const value = readAnswer();
        if (request.dialogKind === "form") {
          const issue = validateDomFormAnswer(request.payload.schema, value);
          if (issue) {
            showError(`The form does not match its schema: ${issue}`);
            return;
          }
        }
        finish(answered(value));
      } catch (cause) {
        showError(cause instanceof Error ? cause.message : "The dialog answer is invalid.");
      }
    };
    const onCancel = () => finish(cancelled("browser dialog was cancelled"));
    const onAbort = () => finish(cancelled("browser dialog was aborted"));
    form.addEventListener("submit", onSubmit);
    cancel.addEventListener("click", onCancel);
    options.signal.addEventListener("abort", onAbort, { once: true });
    mount.append(root);
  });
}

/**
 * Browser validation is advisory only. It avoids dismissing a live dialog for
 * a structurally invalid answer while Gateway remains the authoritative
 * compiler for its restricted form-schema contract and lifecycle.
 */
function validateDomFormAnswer(schema: PilotDeckUserDialogFormSchema, value: unknown): string | undefined {
  const validator = getDomFormValidator(schema);
  if (!validator || validator(value)) return undefined;
  const error = validator.errors?.[0];
  const location = error?.instancePath || "form";
  return `${location} ${error?.message ?? "is invalid"}`;
}

function getDomFormValidator(schema: PilotDeckUserDialogFormSchema): ValidateFunction | undefined {
  const cached = formValidators.get(schema);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: false,
      strictTuples: false,
      validateFormats: false,
      unevaluated: true,
    });
    addFormats(ajv);
    const validator = ajv.compile(schema);
    formValidators.set(schema, validator);
    return validator;
  } catch {
    // Gateway can legitimately support a form extension the package does not
    // compile. Skipping local validation preserves the server's authority.
    formValidators.set(schema, null);
    return undefined;
  }
}

function appendInputControl(
  document: Document,
  form: HTMLFormElement,
  payload: Extract<PilotDeckUserDialogRequest, { dialogKind: "input" }> ["payload"],
): () => string {
  const input = document.createElement("input");
  input.type = "text";
  input.name = "value";
  input.placeholder = payload.placeholder ?? "";
  input.required = payload.allowEmpty !== true;
  appendLabeledControl(document, form, input, "Value");
  return () => input.value;
}

function appendSelectControl(
  document: Document,
  form: HTMLFormElement,
  payload: Extract<PilotDeckUserDialogRequest, { dialogKind: "select" }> ["payload"],
): () => string {
  const select = document.createElement("select");
  select.name = "value";
  for (const choice of payload.choices) {
    const option = document.createElement("option");
    option.value = choice.value;
    option.textContent = choice.description
      ? `${choice.label ?? choice.value} - ${choice.description}`
      : (choice.label ?? choice.value);
    option.selected = choice.value === payload.defaultValue;
    select.append(option);
  }
  appendLabeledControl(document, form, select, "Select an option");
  return () => select.value;
}

function appendConfirmControl(
  document: Document,
  form: HTMLFormElement,
  payload: Extract<PilotDeckUserDialogRequest, { dialogKind: "confirm" }> ["payload"],
): () => boolean {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = "value";
  input.checked = payload.defaultValue === true;
  appendLabeledControl(document, form, input, payload.confirmLabel ?? "Confirm");
  return () => input.checked;
}

function appendFormControls(
  document: Document,
  form: HTMLFormElement,
  schema: PilotDeckUserDialogFormSchema,
  requestId: string,
): () => Record<string, unknown> {
  // A root-level allOf is common in generated schemas. We can render the
  // non-conflicting object branches as one form while Gateway still validates
  // every original constraint on submission.
  const effectiveSchema = (mergeAllOfSchema(schema, schema) ?? schema) as PilotDeckUserDialogFormSchema;
  const rootUnion = appendRootUnionFormControls(document, form, effectiveSchema, requestId);
  if (rootUnion) return rootUnion;
  const fieldset = document.createElement("fieldset");
  fieldset.setAttribute("data-pilotdeck-dialog-form", "true");
  const rootDefault = isRecord(effectiveSchema.default) ? effectiveSchema.default : {};
  const required = new Set(effectiveSchema.required ?? []);
  const readers: FormFieldReader[] = [];
  let ordinal = 0;
  for (const [name, field] of Object.entries(effectiveSchema.properties ?? {})) {
    readers.push({
      name,
      read: appendSchemaField(document, fieldset, field, effectiveSchema, {
        id: `${requestId}-${ordinal++}`,
        name,
        required: required.has(name),
        initialValue: rootDefault[name],
      }),
    });
  }
  const extraReader = appendAdditionalObjectFields(
    document,
    fieldset,
    effectiveSchema,
    rootDefault,
    "Form",
    { id: `${requestId}-additional`, name: "$additional" },
  );
  form.append(fieldset);
  return () => {
    const answer: Record<string, unknown> = {};
    for (const reader of readers) {
      const value = reader.read();
      if (value !== OMITTED) answer[reader.name] = value;
    }
    mergeAdditionalObjectFields("Form", answer, extraReader);
    return answer;
  };
}

/**
 * Root unions have no parent property on which to attach a normal field
 * reader. Render the chosen object branch as the entire form instead. A root
 * schema with additional outer properties is left to the JSON fallback so no
 * declared field is silently dropped by the convenience renderer.
 */
function appendRootUnionFormControls(
  document: Document,
  form: HTMLFormElement,
  schema: PilotDeckUserDialogFormSchema,
  requestId: string,
): (() => Record<string, unknown>) | undefined {
  const branches = schema.oneOf ?? schema.anyOf;
  if (!branches?.length || !canRenderUnion(schema) || Object.keys(schema.properties ?? {}).length > 0) return undefined;
  if (branches.some((branch) => singleType((resolveLocalSchema(branch, schema) ?? branch).type) !== "object")) return undefined;

  const fieldset = document.createElement("fieldset");
  fieldset.setAttribute("data-pilotdeck-dialog-root-composition", schema.oneOf ? "oneOf" : "anyOf");
  const legend = document.createElement("legend");
  legend.textContent = schema.title ?? "Choose an option";
  fieldset.append(legend);
  const select = document.createElement("select");
  select.name = "$root.$variant";
  select.setAttribute("data-pilotdeck-dialog-root-union-selector", "true");
  const initialValue = schema.default;
  const initialBranch = initialValue === undefined
    ? 0
    : Math.max(0, branches.findIndex((branch) => schemaCouldMatchValue(branch, schema, initialValue)));
  branches.forEach((branch, index) => {
    const resolved = resolveLocalSchema(branch, schema) ?? branch;
    appendOption(document, select, String(index), resolved.title?.trim() || `Option ${index + 1}`, index === initialBranch);
  });
  appendLabeledControl(document, fieldset, select, "Choose an option");
  const branchContainer = document.createElement("div");
  branchContainer.setAttribute("data-pilotdeck-dialog-root-union-branch", "true");
  fieldset.append(branchContainer);
  let readBranch: (() => FormValue) | undefined;
  const renderBranch = () => {
    while (branchContainer.children.length > 0) branchContainer.children[0]?.remove();
    const selected = Number(select.value);
    if (!Number.isInteger(selected) || selected < 0 || selected >= branches.length) {
      readBranch = undefined;
      return;
    }
    readBranch = appendSchemaField(document, branchContainer, branches[selected]!, schema, {
      id: `${requestId}-root-option-${selected}`,
      name: "$root",
      required: true,
      initialValue,
    });
  };
  select.addEventListener("change", renderBranch);
  renderBranch();
  form.append(fieldset);
  return () => {
    const value = readBranch?.();
    if (!isRecord(value)) throw new Error("Choose a valid form option.");
    return value;
  };
}

function appendSchemaField(
  document: Document,
  container: HTMLElement,
  schema: PilotDeckUserDialogFormFieldSchema,
  root: PilotDeckUserDialogFormSchema,
  context: { id: string; name: string; required: boolean; initialValue: unknown },
): () => FormValue {
  const resolved = resolveLocalSchema(schema, root) ?? schema;
  const label = resolved.title ?? context.name;
  const initialValue = context.initialValue === undefined ? resolved.default : context.initialValue;
  if (resolved.const !== undefined) {
    const fixed = document.createElement("output");
    fixed.textContent = `${label}: ${formatValue(resolved.const)}`;
    container.append(fixed);
    return () => resolved.const;
  }
  if (Array.isArray(resolved.enum)) {
    return appendEnumField(document, container, resolved, label, initialValue, context);
  }
  const compositionReader = appendCompositionField(document, container, resolved, root, label, initialValue, context);
  if (compositionReader) return compositionReader;
  if (hasComposition(resolved)) return appendJsonField(document, container, label, initialValue, context);
  const type = singleType(resolved.type);
  if (type === "object" && resolved.properties) {
    return appendObjectField(document, container, resolved, root, label, initialValue, context);
  }
  if (type === "array") return appendArrayField(document, container, resolved, root, label, initialValue, context);
  if (type === "string") return appendStringField(document, container, resolved, label, initialValue, context);
  if (type === "number" || type === "integer") {
    return appendNumberField(document, container, resolved, label, initialValue, context, type === "integer");
  }
  if (type === "boolean") return appendBooleanField(document, container, label, initialValue, context);
  return appendJsonField(document, container, label, initialValue, context);
}

/**
 * Render the subset of composition that can have an unambiguous typed UI.
 * `allOf` is flattened only when its branches do not conflict. A union gets a
 * branch selector; any remaining constraints stay Gateway-authoritative.
 */
function appendCompositionField(
  document: Document,
  container: HTMLElement,
  schema: PilotDeckUserDialogFormFieldSchema,
  root: PilotDeckUserDialogFormSchema,
  label: string,
  initialValue: unknown,
  context: { id: string; name: string; required: boolean },
): (() => FormValue) | undefined {
  const merged = mergeAllOfSchema(schema, root);
  if (merged) return appendSchemaField(document, container, merged, root, { ...context, initialValue });

  const branches = schema.oneOf ?? schema.anyOf;
  if (!branches?.length || !canRenderUnion(schema)) return undefined;

  const fieldset = document.createElement("fieldset");
  fieldset.setAttribute("data-pilotdeck-dialog-composition", schema.oneOf ? "oneOf" : "anyOf");
  const legend = document.createElement("legend");
  legend.textContent = label;
  fieldset.append(legend);
  if (schema.description) {
    const description = document.createElement("small");
    description.textContent = schema.description;
    fieldset.append(description);
  }

  const select = document.createElement("select");
  select.id = `${context.id}-variant`;
  select.name = `${context.name}.$variant`;
  select.setAttribute("data-pilotdeck-dialog-union-selector", context.name);
  if (!context.required) appendOption(document, select, "", "Not set", initialValue === undefined);
  const initialBranch = initialValue === undefined
    ? 0
    : Math.max(0, branches.findIndex((branch) => schemaCouldMatchValue(branch, root, initialValue)));
  branches.forEach((branch, index) => {
    const resolved = resolveLocalSchema(branch, root) ?? branch;
    appendOption(
      document,
      select,
      String(index),
      resolved.title?.trim() || `Option ${index + 1}`,
      initialValue !== undefined && index === initialBranch,
    );
  });
  appendLabeledControl(document, fieldset, select, "Choose an option");

  const branchContainer = document.createElement("div");
  branchContainer.setAttribute("data-pilotdeck-dialog-union-branch", context.name);
  fieldset.append(branchContainer);
  let readBranch: (() => FormValue) | undefined;
  const renderBranch = () => {
    while (branchContainer.children.length > 0) branchContainer.children[0]?.remove();
    const selected = Number(select.value);
    if (!Number.isInteger(selected) || selected < 0 || selected >= branches.length) {
      readBranch = undefined;
      return;
    }
    readBranch = appendSchemaField(document, branchContainer, branches[selected]!, root, {
      id: `${context.id}-option-${selected}`,
      name: context.name,
      required: context.required,
      initialValue,
    });
  };
  select.addEventListener("change", renderBranch);
  renderBranch();
  container.append(fieldset);
  return () => {
    if (!readBranch) return OMITTED;
    return readBranch();
  };
}

/**
 * Return a renderer-friendly allOf flattening only for schemas whose fields
 * can be combined without inventing precedence. Constraints not represented
 * by a native control are deliberately kept in the merged schema for the
 * Gateway validator, even when the browser cannot enforce every one locally.
 */
function mergeAllOfSchema(
  schema: PilotDeckUserDialogFormFieldSchema,
  root: PilotDeckUserDialogFormSchema,
): PilotDeckUserDialogFormFieldSchema | undefined {
  if (!schema.allOf?.length || hasNonAllOfComposition(schema)) return undefined;
  const { allOf: _allOf, properties: baseProperties, required: baseRequired, patternProperties: basePatterns, ...base } = schema;
  const mergedProperties: Record<string, PilotDeckUserDialogFormFieldSchema> = { ...(baseProperties ?? {}) };
  const mergedPatterns: Record<string, PilotDeckUserDialogFormFieldSchema> = { ...(basePatterns ?? {}) };
  const mergedRequired = new Set(baseRequired ?? []);
  let mergedType = singleType(base.type);

  for (const branch of schema.allOf) {
    const resolved = resolveLocalSchema(branch, root) ?? branch;
    if (hasComposition(resolved)) return undefined;
    const branchType = singleType(resolved.type);
    if (mergedType && branchType && mergedType !== branchType) return undefined;
    mergedType ??= branchType;
    for (const [name, field] of Object.entries(resolved.properties ?? {})) {
      const existing = mergedProperties[name];
      if (existing && !jsonEqual(existing, field)) return undefined;
      mergedProperties[name] = field;
    }
    for (const [pattern, field] of Object.entries(resolved.patternProperties ?? {})) {
      const existing = mergedPatterns[pattern];
      if (existing && !jsonEqual(existing, field)) return undefined;
      mergedPatterns[pattern] = field;
    }
    for (const name of resolved.required ?? []) mergedRequired.add(name);
    for (const [key, value] of Object.entries(resolved)) {
      if (key === "properties" || key === "patternProperties" || key === "required" || key === "type") continue;
      if (key in base && !jsonEqual(base[key], value)) return undefined;
      base[key] = value;
    }
  }

  if ((Object.keys(mergedProperties).length > 0 || Object.keys(mergedPatterns).length > 0)
    && mergedType && mergedType !== "object") return undefined;
  if (Object.keys(mergedProperties).length > 0 || Object.keys(mergedPatterns).length > 0) mergedType = "object";
  return {
    ...base,
    ...(mergedType ? { type: mergedType } : {}),
    ...(Object.keys(mergedProperties).length > 0 ? { properties: mergedProperties } : {}),
    ...(Object.keys(mergedPatterns).length > 0 ? { patternProperties: mergedPatterns } : {}),
    ...(mergedRequired.size > 0 ? { required: [...mergedRequired] } : {}),
  };
}

function canRenderUnion(schema: PilotDeckUserDialogFormFieldSchema): boolean {
  return !schema.allOf && schema.not === undefined && schema.if === undefined
    && schema.then === undefined && schema.else === undefined
    && schema.dependentRequired === undefined && schema.dependentSchemas === undefined;
}

function hasNonAllOfComposition(schema: PilotDeckUserDialogFormFieldSchema): boolean {
  return schema.anyOf !== undefined || schema.oneOf !== undefined || schema.not !== undefined
    || schema.if !== undefined || schema.then !== undefined || schema.else !== undefined
    || schema.dependentRequired !== undefined || schema.dependentSchemas !== undefined;
}

/** A conservative branch guess used only for the initial selector value. */
function schemaCouldMatchValue(
  schema: PilotDeckUserDialogFormFieldSchema,
  root: PilotDeckUserDialogFormSchema,
  value: unknown,
): boolean {
  const resolved = resolveLocalSchema(schema, root) ?? schema;
  if (resolved.const !== undefined) return jsonEqual(resolved.const, value);
  if (Array.isArray(resolved.enum)) return resolved.enum.some((candidate) => jsonEqual(candidate, value));
  const type = singleType(resolved.type);
  if (type === "object") return isRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "number" || type === "integer") return typeof value === "number";
  if (type === "boolean") return typeof value === "boolean";
  return false;
}

function appendObjectField(
  document: Document,
  container: HTMLElement,
  schema: PilotDeckUserDialogFormFieldSchema,
  root: PilotDeckUserDialogFormSchema,
  label: string,
  initialValue: unknown,
  context: { id: string; name: string; required: boolean },
): () => FormValue {
  const fieldset = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = label;
  fieldset.append(legend);
  if (schema.description) {
    const description = document.createElement("small");
    description.textContent = schema.description;
    fieldset.append(description);
  }
  const defaults = isRecord(initialValue) ? initialValue : {};
  const required = new Set(schema.required ?? []);
  const readers: FormFieldReader[] = [];
  let ordinal = 0;
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    readers.push({
      name,
      read: appendSchemaField(document, fieldset, field, root, {
        id: `${context.id}-${ordinal++}`,
        name: `${context.name}.${name}`,
        required: required.has(name),
        initialValue: defaults[name],
      }),
    });
  }
  const extraReader = appendAdditionalObjectFields(
    document,
    fieldset,
    schema,
    defaults,
    label,
    { id: `${context.id}-additional`, name: `${context.name}.$additional` },
  );
  container.append(fieldset);
  return () => {
    const value: Record<string, unknown> = {};
    for (const reader of readers) {
      const field = reader.read();
      if (field !== OMITTED) value[reader.name] = field;
    }
    mergeAdditionalObjectFields(label, value, extraReader);
    if (!context.required && Object.keys(value).length === 0 && initialValue === undefined) return OMITTED;
    return value;
  };
}

function appendAdditionalObjectFields(
  document: Document,
  container: HTMLElement,
  schema: PilotDeckUserDialogFormFieldSchema,
  defaults: Record<string, unknown>,
  label: string,
  context: { id: string; name: string },
): (() => FormValue) | undefined {
  const declaredProperties = new Set(Object.keys(schema.properties ?? {}));
  const extraDefaults = Object.fromEntries(
    Object.entries(defaults).filter(([name]) => !declaredProperties.has(name)),
  );
  const allowsExtraFields = Object.keys(extraDefaults).length > 0
    || Object.keys(schema.patternProperties ?? {}).length > 0
    || schema.additionalProperties === true
    || typeof schema.additionalProperties === "object";
  if (!allowsExtraFields) return undefined;
  return appendJsonField(
    document,
    container,
    "Additional fields (JSON object)",
    Object.keys(extraDefaults).length > 0 ? extraDefaults : undefined,
    { id: context.id, name: context.name, required: false },
  );
}

function mergeAdditionalObjectFields(
  label: string,
  target: Record<string, unknown>,
  reader: (() => FormValue) | undefined,
): void {
  const extra = reader?.();
  if (extra === OMITTED || extra === undefined) return;
  if (!isRecord(extra)) throw new Error(`${label} additional fields must be a JSON object.`);
  for (const [name, field] of Object.entries(extra)) {
    if (Object.hasOwn(target, name)) throw new Error(`${label} additional field duplicates ${name}.`);
    target[name] = field;
  }
}

function appendArrayField(
  document: Document,
  container: HTMLElement,
  schema: PilotDeckUserDialogFormFieldSchema,
  root: PilotDeckUserDialogFormSchema,
  label: string,
  initialValue: unknown,
  context: { id: string; name: string; required: boolean },
): () => FormValue {
  const fieldset = document.createElement("fieldset");
  fieldset.setAttribute("data-pilotdeck-dialog-array", "true");
  const legend = document.createElement("legend");
  legend.textContent = label;
  fieldset.append(legend);
  if (schema.description) {
    const description = document.createElement("small");
    description.textContent = schema.description;
    fieldset.append(description);
  }

  const values = Array.isArray(initialValue)
    ? initialValue
    : Array.isArray(schema.default)
      ? schema.default
      : [];
  const prefixItems = schema.prefixItems ?? [];
  const minItems = schema.minItems ?? 0;
  // In JSON Schema, omitting `items` does not close a prefixItems tuple:
  // remaining entries accept arbitrary JSON. Keep that standard behavior
  // available through the JSON editor rather than silently treating it as a
  // fixed-length tuple. The renderer still bounds an unbounded UI at 64 rows.
  const maxItems = schema.maxItems ?? Math.max(64, values.length, minItems, prefixItems.length);
  const readers: Array<{ read: () => FormValue; active: boolean }> = [];
  let nextItemIndex = 0;
  let addButton: HTMLButtonElement | undefined;
  let addButtonVisible = false;
  let showAddButton = () => {};
  const activeItemCount = () => readers.filter((reader) => reader.active).length;

  const appendItem = (initial: unknown): boolean => {
    if (activeItemCount() >= maxItems) return false;
    const index = nextItemIndex;
    nextItemIndex += 1;
    const itemSchema = prefixItems[index] ?? schema.items ?? {};
    const item = document.createElement("div");
    item.setAttribute("data-pilotdeck-dialog-array-item", String(index));
    const itemLabel = `${context.name}[${index}]`;
    const reader = {
      read: appendSchemaField(document, item, itemSchema, root, {
        id: `${context.id}-${index}`,
        name: itemLabel,
        required: index < minItems,
        initialValue: initial,
      }),
      active: true,
    };
    readers.push(reader);
    // Tuple prefix positions carry schema meaning. Only homogeneous items and
    // an explicitly permitted tail may be removed without changing it.
    if (index >= prefixItems.length) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove item";
      remove.setAttribute("data-pilotdeck-dialog-array-remove", String(index));
      remove.addEventListener("click", () => {
        if (!reader.active || activeItemCount() <= minItems) return;
        reader.active = false;
        item.remove();
        if (activeItemCount() < maxItems) showAddButton();
      });
      item.append(remove);
    }
    fieldset.append(item);
    return true;
  };

  // Initial values and minItems have precedence. Prefix items remain opt-in
  // unless the schema requires them, so an optional tuple does not invent an
  // answer that Gateway would later treat as user-provided data.
  const initialCount = Math.max(values.length, minItems);
  for (let index = 0; index < initialCount; index += 1) appendItem(values[index]);

  if (maxItems > 0) {
    addButton = document.createElement("button");
    addButton.type = "button";
    addButton.textContent = "Add item";
    addButton.setAttribute("data-pilotdeck-dialog-array-add", "true");
    addButton.addEventListener("click", () => {
      appendItem(undefined);
      if (activeItemCount() >= maxItems) {
        addButton?.remove();
        addButtonVisible = false;
      }
    });
    showAddButton = () => {
      if (!addButton || addButtonVisible || activeItemCount() >= maxItems) return;
      fieldset.append(addButton);
      addButtonVisible = true;
    };
    showAddButton();
  }

  container.append(fieldset);
  return () => {
    const answer: unknown[] = [];
    for (const reader of readers) {
      if (!reader.active) continue;
      const value = reader.read();
      if (value !== OMITTED) answer.push(value);
    }
    if (answer.length < minItems) throw new Error(`${label} requires at least ${minItems} item(s).`);
    if (answer.length > maxItems) throw new Error(`${label} allows at most ${maxItems} item(s).`);
    if (!context.required && answer.length === 0 && initialValue === undefined && schema.default === undefined) {
      return OMITTED;
    }
    return answer;
  };
}

function appendStringField(
  document: Document,
  container: HTMLElement,
  schema: PilotDeckUserDialogFormFieldSchema,
  label: string,
  initialValue: unknown,
  context: { id: string; name: string; required: boolean },
): () => FormValue {
  const input = document.createElement("input");
  input.type = "text";
  input.id = context.id;
  input.name = context.name;
  input.required = context.required;
  input.value = typeof initialValue === "string" ? initialValue : "";
  if (schema.description) input.setAttribute("aria-description", schema.description);
  if (schema.format === "email" || schema.format === "uri") input.type = schema.format;
  if (schema.minLength !== undefined) input.minLength = schema.minLength;
  if (schema.maxLength !== undefined) input.maxLength = schema.maxLength;
  if (schema.pattern) input.pattern = schema.pattern;
  appendLabeledControl(document, container, input, label, schema.description);
  return () => input.value === "" && !context.required && initialValue === undefined ? OMITTED : input.value;
}

function appendNumberField(
  document: Document,
  container: HTMLElement,
  schema: PilotDeckUserDialogFormFieldSchema,
  label: string,
  initialValue: unknown,
  context: { id: string; name: string; required: boolean },
  integer: boolean,
): () => FormValue {
  const input = document.createElement("input");
  input.type = "number";
  input.id = context.id;
  input.name = context.name;
  input.required = context.required;
  input.step = integer ? "1" : (schema.multipleOf?.toString() ?? "any");
  if (schema.minimum !== undefined) input.min = String(schema.minimum);
  if (schema.maximum !== undefined) input.max = String(schema.maximum);
  if (typeof initialValue === "number") input.value = String(initialValue);
  appendLabeledControl(document, container, input, label, schema.description);
  return () => {
    if (input.value === "" && !context.required && initialValue === undefined) return OMITTED;
    const value = Number(input.value);
    if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
      throw new Error(`${label} must be a ${integer ? "whole number" : "number"}.`);
    }
    return value;
  };
}

function appendBooleanField(
  document: Document,
  container: HTMLElement,
  label: string,
  initialValue: unknown,
  context: { id: string; name: string; required: boolean },
): () => FormValue {
  if (context.required) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = context.id;
    input.name = context.name;
    input.checked = initialValue === true;
    appendLabeledControl(document, container, input, label);
    return () => input.checked;
  }
  const select = document.createElement("select");
  select.id = context.id;
  select.name = context.name;
  appendOption(document, select, "", "Not set", initialValue === undefined);
  appendOption(document, select, "true", "True", initialValue === true);
  appendOption(document, select, "false", "False", initialValue === false);
  appendLabeledControl(document, container, select, label);
  return () => select.value === "" ? OMITTED : select.value === "true";
}

function appendEnumField(
  document: Document,
  container: HTMLElement,
  schema: PilotDeckUserDialogFormFieldSchema,
  label: string,
  initialValue: unknown,
  context: { id: string; name: string; required: boolean },
): () => FormValue {
  const values = schema.enum ?? [];
  const select = document.createElement("select");
  select.id = context.id;
  select.name = context.name;
  select.required = context.required;
  if (!context.required) appendOption(document, select, "", "Not set", initialValue === undefined);
  values.forEach((value, index) => {
    appendOption(document, select, String(index), formatValue(value), jsonEqual(initialValue, value));
  });
  appendLabeledControl(document, container, select, label, schema.description);
  return () => {
    if (select.value === "" && !context.required) return OMITTED;
    const index = Number(select.value);
    const value = values[index];
    if (!Number.isInteger(index) || value === undefined) throw new Error(`${label} has no selected value.`);
    return value;
  };
}

function appendJsonField(
  document: Document,
  container: HTMLElement,
  label: string,
  initialValue: unknown,
  context: { id: string; name: string; required: boolean },
): () => FormValue {
  const input = document.createElement("textarea");
  input.id = context.id;
  input.name = context.name;
  input.required = context.required;
  input.value = initialValue === undefined ? "" : JSON.stringify(initialValue, null, 2);
  appendLabeledControl(document, container, input, `${label} (JSON)`);
  return () => {
    if (input.value.trim() === "" && !context.required && initialValue === undefined) return OMITTED;
    try {
      return JSON.parse(input.value) as unknown;
    } catch {
      throw new Error(`${label} must contain valid JSON.`);
    }
  };
}

function appendLabeledControl(
  document: Document,
  container: HTMLElement,
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  labelText: string,
  description?: string,
): void {
  const wrapper = document.createElement("label");
  wrapper.textContent = labelText;
  if (description) {
    const detail = document.createElement("small");
    detail.textContent = description;
    wrapper.append(detail);
  }
  wrapper.append(control);
  container.append(wrapper);
}

function appendOption(
  document: Document,
  select: HTMLSelectElement,
  value: string,
  text: string,
  selected: boolean,
): void {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  option.selected = selected;
  select.append(option);
  if (selected) select.value = value;
}

function resolveLocalSchema(
  schema: PilotDeckUserDialogFormFieldSchema,
  root: PilotDeckUserDialogFormSchema,
): PilotDeckUserDialogFormFieldSchema | undefined {
  let current = schema;
  const seen = new Set<string>();
  while (current.$ref) {
    const match = /^#\/\$defs\/([^/]+)$/.exec(current.$ref);
    const name = match?.[1];
    if (!name || seen.has(name)) return undefined;
    const target = root.$defs?.[name];
    if (!target) return undefined;
    seen.add(name);
    current = target;
  }
  return current;
}

function singleType(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return Array.isArray(value) && value.length === 1 && typeof value[0] === "string"
    ? value[0]
    : undefined;
}

function hasComposition(schema: PilotDeckUserDialogFormFieldSchema): boolean {
  return schema.allOf !== undefined
    || schema.anyOf !== undefined
    || schema.oneOf !== undefined
    || schema.not !== undefined
    || schema.if !== undefined
    || schema.then !== undefined
    || schema.else !== undefined;
}

function dialogTitle(request: PilotDeckUserDialogRequest): string {
  if (request.dialogKind === "form") return request.payload.schema.title ?? "Complete form";
  if (request.dialogKind === "confirm") return "Confirmation required";
  if (request.dialogKind === "select") return "Select an option";
  if (request.dialogKind === "input") return "Input required";
  return "User input required";
}

function submitLabel(request: PilotDeckUserDialogRequest): string {
  return request.dialogKind === "confirm" ? (request.payload.confirmLabel ?? "Confirm") : "Submit";
}

function resolveDocument(value: Document | undefined): Document {
  const document = value ?? globalThis.document;
  if (!document || typeof document.createElement !== "function") {
    throw new Error("Browser DOM APIs are unavailable; provide a document or another browser dialog driver.");
  }
  return document;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function answered(value: unknown): PilotDeckUserDialogResult {
  return { behavior: "answered", value };
}

function cancelled(reason: string): PilotDeckUserDialogResult {
  return { behavior: "cancelled", reason };
}

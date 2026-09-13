import type {
  OnUserDialog,
  PilotDeckUserDialogRequest,
  PilotDeckUserDialogResult,
} from "./types.js";

/**
 * Minimal browser presentation boundary. Applications can provide a custom
 * driver backed by their own modal system; the default driver uses native
 * browser prompt/confirm dialogs and never accesses a Gateway directly.
 */
export type PilotDeckBrowserDialogDriver = {
  /** Fallback control for input, select, and JSON form dialogs. */
  prompt?(message: string, defaultValue?: string): string | null | Promise<string | null>;
  /** Fallback control for confirm dialogs. */
  confirm?(message: string): boolean | Promise<boolean>;
  alert?(message: string): void | Promise<void>;
  /**
   * Optional application-owned renderer for a complete dialog. It receives
   * the original typed payload, including a form schema, so a browser host
   * can use its own modal/component system instead of native prompt boxes.
   * Return `undefined` to use the SDK's prompt/confirm fallback.
   */
  render?(
    request: PilotDeckUserDialogRequest,
    context: { signal: AbortSignal },
  ): PilotDeckUserDialogResult | undefined | Promise<PilotDeckUserDialogResult | undefined>;
};

export type PilotDeckBrowserDialogOptions = {
  /** Uses the browser global prompt/confirm functions when omitted. */
  driver?: PilotDeckBrowserDialogDriver;
  /** Maximum invalid input or JSON attempts before cancellation. Defaults to 3. */
  maxAttempts?: number;
  /** Optional cancellation signal for a manually rendered pending dialog. */
  signal?: AbortSignal;
};

type BrowserGlobals = {
  prompt?: (message: string, defaultValue?: string) => string | null;
  confirm?: (message: string) => boolean;
  alert?: (message: string) => void;
};

/**
 * Creates an `onUserDialog` callback for browser applications. It keeps UI
 * ownership in the application process, while the Gateway remains the final
 * answer validator and owner of dialog/run state.
 */
export function createBrowserUserDialogHandler(
  options: PilotDeckBrowserDialogOptions = {},
): OnUserDialog {
  const normalized = normalizeOptions(options);
  return (request, context) => renderBrowserUserDialog(request, {
    driver: normalized.driver,
    maxAttempts: normalized.maxAttempts,
    signal: context.signal,
  });
}

/**
 * Renders one live pending dialog with browser-native controls. This can be
 * used with `userDialogMode: "manual"` before calling respondUserDialog().
 */
export async function renderBrowserUserDialog(
  request: PilotDeckUserDialogRequest,
  options: PilotDeckBrowserDialogOptions = {},
): Promise<PilotDeckUserDialogResult> {
  const { driver, maxAttempts, signal } = normalizeOptions(options);
  if (signal.aborted) return cancelled("browser dialog was aborted");

  try {
    const customResult = await driver.render?.(request, { signal });
    if (signal.aborted) return cancelled("browser dialog was aborted");
    if (customResult !== undefined) {
      if (isDialogResult(customResult)) return customResult;
      await driver.alert?.("The browser dialog renderer returned an invalid result.");
      return cancelled("browser dialog renderer returned an invalid result");
    }
    switch (request.dialogKind) {
      case "input":
        return renderInput(request, driver, signal, maxAttempts);
      case "select":
        return renderSelect(request, driver, signal, maxAttempts);
      case "confirm":
        return renderConfirm(request, driver, signal);
      case "form":
        return renderForm(request, driver, signal, maxAttempts);
      case "elicitation":
        return cancelled("browser dialog renderer does not handle native elicitation");
    }
  } catch (error) {
    if (signal.aborted) return cancelled("browser dialog was aborted");
    const message = error instanceof Error ? error.message : String(error);
    await driver.alert?.(`PilotDeck dialog cancelled: ${message}`);
    return cancelled("browser dialog renderer failed");
  }
}

/**
 * Builds the default native-browser driver lazily. SDK import therefore stays
 * safe in Node, SSR and test environments without browser globals.
 */
export function createWindowBrowserDialogDriver(
  browser: BrowserGlobals | undefined = globalThis as unknown as BrowserGlobals,
): PilotDeckBrowserDialogDriver {
  const prompt = browser?.prompt;
  const confirm = browser?.confirm;
  if (typeof prompt !== "function" || typeof confirm !== "function") {
    throw new Error("Browser prompt and confirm APIs are unavailable; provide a browser dialog driver.");
  }
  return {
    prompt: (message, defaultValue) => prompt(message, defaultValue),
    confirm: (message) => confirm(message),
    ...(typeof browser.alert === "function" ? { alert: (message: string) => browser.alert!(message) } : {}),
  };
}

function normalizeOptions(options: PilotDeckBrowserDialogOptions): {
  driver: PilotDeckBrowserDialogDriver;
  maxAttempts: number;
  signal: AbortSignal;
} {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new RangeError("maxAttempts must be an integer between 1 and 20.");
  }
  return {
    driver: options.driver ?? createWindowBrowserDialogDriver(),
    maxAttempts,
    signal: options.signal ?? new AbortController().signal,
  };
}

async function renderInput(
  request: Extract<PilotDeckUserDialogRequest, { dialogKind: "input" }>,
  driver: PilotDeckBrowserDialogDriver,
  signal: AbortSignal,
  maxAttempts: number,
): Promise<PilotDeckUserDialogResult> {
  const { prompt, placeholder, allowEmpty } = request.payload;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal.aborted) return cancelled("browser dialog was aborted");
    const value = await requirePrompt(driver)(prompt, placeholder ?? "");
    if (value === null) return cancelled("browser input was cancelled");
    if (value.length > 0 || allowEmpty) return answered(value);
    await driver.alert?.("A value is required.");
  }
  return cancelled("too many invalid browser answers");
}

async function renderSelect(
  request: Extract<PilotDeckUserDialogRequest, { dialogKind: "select" }>,
  driver: PilotDeckBrowserDialogDriver,
  signal: AbortSignal,
  maxAttempts: number,
): Promise<PilotDeckUserDialogResult> {
  const { prompt, choices, defaultValue } = request.payload;
  const choicesText = choices.map((choice, index) => {
    const label = choice.label ?? choice.value;
    return `${index + 1}. ${label}${choice.description ? ` - ${choice.description}` : ""}`;
  }).join("\n");
  const message = `${prompt}\n\n${choicesText}\n\nEnter a number or value:`;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal.aborted) return cancelled("browser dialog was aborted");
    const raw = await requirePrompt(driver)(message, defaultValue ?? "");
    if (raw === null) return cancelled("browser selection was cancelled");
    const value = raw.trim();
    const byNumber = Number(value);
    const selected = value === "" && defaultValue !== undefined
      ? defaultValue
      : Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= choices.length
        ? choices[byNumber - 1]?.value
        : choices.find((choice) => choice.value === value)?.value;
    if (selected !== undefined) return answered(selected);
    await driver.alert?.("Choose one of the displayed values or numbers.");
  }
  return cancelled("too many invalid browser answers");
}

async function renderConfirm(
  request: Extract<PilotDeckUserDialogRequest, { dialogKind: "confirm" }>,
  driver: PilotDeckBrowserDialogDriver,
  signal: AbortSignal,
): Promise<PilotDeckUserDialogResult> {
  if (signal.aborted) return cancelled("browser dialog was aborted");
  const { prompt, confirmLabel, cancelLabel } = request.payload;
  const positive = confirmLabel ?? "OK";
  const negative = cancelLabel ?? "Cancel";
  return answered(await requireConfirm(driver)(`${prompt}\n\n${positive} = true; ${negative} = false.`));
}

async function renderForm(
  request: Extract<PilotDeckUserDialogRequest, { dialogKind: "form" }>,
  driver: PilotDeckBrowserDialogDriver,
  signal: AbortSignal,
  maxAttempts: number,
): Promise<PilotDeckUserDialogResult> {
  const defaultValue = JSON.stringify(defaultFormValue(request.payload.schema), null, 2);
  const message = `${request.payload.prompt}\n\nEnter a JSON object:`;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal.aborted) return cancelled("browser dialog was aborted");
    const raw = await requirePrompt(driver)(message, defaultValue);
    if (raw === null) return cancelled("browser form was cancelled");
    const value = parseObject(raw);
    if (value !== undefined) return answered(value);
    await driver.alert?.("Enter a valid JSON object.");
  }
  return cancelled("too many invalid browser answers");
}

function defaultFormValue(schema: Extract<PilotDeckUserDialogRequest, { dialogKind: "form" }> ["payload"]["schema"]): Record<string, unknown> {
  if (isRecord(schema.default)) return schema.default;
  const value: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    if (field.default !== undefined) value[name] = field.default;
  }
  return value;
}

function parseObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function answered(value: unknown): PilotDeckUserDialogResult {
  return { behavior: "answered", value };
}

function cancelled(reason: string): PilotDeckUserDialogResult {
  return { behavior: "cancelled", reason };
}

function requirePrompt(driver: PilotDeckBrowserDialogDriver): NonNullable<PilotDeckBrowserDialogDriver["prompt"]> {
  if (!driver.prompt) {
    throw new Error("Browser prompt fallback is unavailable; provide driver.prompt or driver.render().");
  }
  return driver.prompt;
}

function requireConfirm(driver: PilotDeckBrowserDialogDriver): NonNullable<PilotDeckBrowserDialogDriver["confirm"]> {
  if (!driver.confirm) {
    throw new Error("Browser confirm fallback is unavailable; provide driver.confirm or driver.render().");
  }
  return driver.confirm;
}

function isDialogResult(value: unknown): value is PilotDeckUserDialogResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (result.behavior === "answered") return Object.hasOwn(result, "value");
  return result.behavior === "cancelled"
    && (result.reason === undefined || typeof result.reason === "string");
}

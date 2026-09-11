import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  AbortError,
  createDomBrowserDialogDriver,
  createBrowserUserDialogHandler,
  createEmbeddedPilotDeckHost,
  PilotDeckEmbeddedTransport,
  createEmbeddedPilotDeckClient,
  createEmbeddedToolRegistry,
  createPilotDeckClient,
  createSdkMcpServer,
  createWindowBrowserDialogDriver,
  createTerminalUserDialogHandler,
  exportSessionTranscript,
  filterEscalatingDefaultMode,
  HOOK_EVENTS,
  query,
  prepareLastTurnReplacement,
  resolveSettings,
  restoreSessionTranscript,
  renderTerminalUserDialog,
  renderBrowserUserDialog,
  tool,
  toEmbeddedTool,
} from "../src/index.js";
import { HostedHookServer } from "../src/hook-server.js";
import { InMemorySessionStore } from "../src/index.js";
import { GatewayTransport } from "../src/transport.js";

test("Claude compatibility exports keep settings helpers pure", () => {
  assert.equal(HOOK_EVENTS.includes("PreToolUse"), true);
  const config = { permissions: { defaultMode: "bypassPermissions" }, nested: { value: 1 } };
  const resolved = { config, sources: [], diagnostics: [], schemaVersion: 1, version: 1, loadedAt: "now", contentHash: "test" } as any;
  const filtered = filterEscalatingDefaultMode(resolved);
  assert.deepEqual(filtered, config);
  assert.notEqual(filtered, config);
  (filtered.nested as any).value = 2;
  assert.equal((config.nested as any).value, 1);
});

function scriptedTerminalDialogIO(values: Array<string | undefined>) {
  const prompts: string[] = [];
  const output: string[] = [];
  return {
    prompts,
    output,
    io: {
      async ask(prompt: string): Promise<string | undefined> {
        prompts.push(prompt);
        return values.shift();
      },
      write(line: string): void {
        output.push(line);
      },
    },
  };
}

function scriptedBrowserDialogDriver(values: Array<string | null>, confirms: boolean[] = []) {
  const prompts: Array<{ message: string; defaultValue?: string }> = [];
  const alerts: string[] = [];
  return {
    prompts,
    alerts,
    driver: {
      prompt(message: string, defaultValue?: string): string | null {
        prompts.push({ message, defaultValue });
        return values.shift() ?? null;
      },
      confirm(): boolean {
        return confirms.shift() ?? false;
      },
      alert(message: string): void {
        alerts.push(message);
      },
    },
  };
}

class FakeDomElement {
  readonly children: FakeDomElement[] = [];
  readonly listeners = new Map<string, Array<(event: any) => void>>();
  parent: FakeDomElement | undefined;
  textContent = "";
  className = "";
  id = "";
  name = "";
  type = "";
  value = "";
  checked = false;
  selected = false;
  required = false;
  hidden = false;
  noValidate = false;
  placeholder = "";
  step = "";
  min = "";
  max = "";
  minLength = -1;
  maxLength = -1;
  pattern = "";
  readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) {}

  append(...nodes: FakeDomElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  }

  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ preventDefault() {} });
    }
  }

  checkValidity(): boolean { return true; }
  reportValidity(): boolean { return true; }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = undefined;
  }
}

class FakeDomDocument {
  readonly body = new FakeDomElement("body");

  createElement(tagName: string): FakeDomElement {
    return new FakeDomElement(tagName);
  }
}

function findFakeDomElements(root: FakeDomElement, predicate: (element: FakeDomElement) => boolean): FakeDomElement[] {
  const result: FakeDomElement[] = [];
  const visit = (element: FakeDomElement) => {
    if (predicate(element)) result.push(element);
    for (const child of element.children) visit(child);
  };
  visit(root);
  return result;
}

test("browser dialog renderer answers input, select, confirm, and JSON form dialogs", async () => {
  const browser = scriptedBrowserDialogDriver(["release-42", "2", '{"name":"Ada","retries":2}'], [true]);
  const handler = createBrowserUserDialogHandler({ driver: browser.driver });
  const controller = new AbortController();

  assert.deepEqual(await handler({
    requestId: "browser-input",
    dialogKind: "input",
    payload: { sessionId: "s", toolCallId: "t1", toolName: "request_user_input", prompt: "Release name" },
  }, { signal: controller.signal }), { behavior: "answered", value: "release-42" });

  assert.deepEqual(await handler({
    requestId: "browser-select",
    dialogKind: "select",
    payload: {
      sessionId: "s",
      toolCallId: "t2",
      toolName: "request_user_choice",
      prompt: "Deploy to",
      choices: [{ value: "staging" }, { value: "production" }],
    },
  }, { signal: controller.signal }), { behavior: "answered", value: "production" });

  assert.deepEqual(await handler({
    requestId: "browser-confirm",
    dialogKind: "confirm",
    payload: { sessionId: "s", toolCallId: "t3", toolName: "request_user_confirmation", prompt: "Continue?" },
  }, { signal: controller.signal }), { behavior: "answered", value: true });

  assert.deepEqual(await handler({
    requestId: "browser-form",
    dialogKind: "form",
    payload: {
      sessionId: "s",
      toolCallId: "t4",
      toolName: "request_user_form",
      prompt: "Configure release",
      schema: {
        type: "object",
        properties: { name: { type: "string", default: "untitled" }, retries: { type: "integer", default: 1 } },
      },
    },
  }, { signal: controller.signal }), { behavior: "answered", value: { name: "Ada", retries: 2 } });
  assert.deepEqual(JSON.parse(browser.prompts[2]!.defaultValue!), { name: "untitled", retries: 1 });
});

test("browser dialog renderer retries invalid JSON and returns cancellation without browser globals", async () => {
  const browser = scriptedBrowserDialogDriver(["not-json", '{"ok":true}', null]);
  const form = await renderBrowserUserDialog({
    requestId: "browser-form-retry",
    dialogKind: "form",
    payload: { sessionId: "s", toolCallId: "t1", toolName: "request_user_form", prompt: "Settings", schema: { type: "object" } },
  }, { driver: browser.driver });
  assert.deepEqual(form, { behavior: "answered", value: { ok: true } });
  assert.deepEqual(browser.alerts, ["Enter a valid JSON object."]);

  const cancelled = await renderBrowserUserDialog({
    requestId: "browser-cancel",
    dialogKind: "input",
    payload: { sessionId: "s", toolCallId: "t2", toolName: "request_user_input", prompt: "Value" },
  }, { driver: browser.driver });
  assert.deepEqual(cancelled, { behavior: "cancelled", reason: "browser input was cancelled" });

  const calls: string[] = [];
  const driver = createWindowBrowserDialogDriver({
    prompt(message: string) {
      calls.push(message);
      return "value";
    },
    confirm(message: string) {
      calls.push(message);
      return true;
    },
  });
  assert.equal(typeof driver.prompt, "function");
  assert.equal(typeof driver.confirm, "function");
  assert.equal(await driver.prompt!("Prompt"), "value");
  assert.equal(await driver.confirm!("Confirm"), true);
  assert.deepEqual(calls, ["Prompt", "Confirm"]);
});

test("browser dialog renderer delegates complete schema dialogs to an asynchronous host UI", async () => {
  const received: any[] = [];
  const result = await renderBrowserUserDialog({
    requestId: "browser-custom-form",
    dialogKind: "form",
    payload: {
      sessionId: "s",
      toolCallId: "t1",
      toolName: "request_user_form",
      prompt: "Configure deployment",
      schema: {
        type: "object",
        properties: { region: { type: "string" }, replicas: { type: "integer", default: 2 } },
        required: ["region"],
      },
    },
  }, {
    driver: {
      async render(request, context) {
        received.push({ request, aborted: context.signal.aborted });
        return { behavior: "answered", value: { region: "eu-west", replicas: 3 } };
      },
    },
  });

  assert.deepEqual(result, { behavior: "answered", value: { region: "eu-west", replicas: 3 } });
  assert.equal(received.length, 1);
  assert.equal(received[0]?.request.dialogKind, "form");
  assert.deepEqual(received[0]?.request.payload.schema.required, ["region"]);
  assert.equal(received[0]?.aborted, false);
});

test("browser dialog renderer fails closed for an invalid custom renderer result", async () => {
  const alerts: string[] = [];
  const result = await renderBrowserUserDialog({
    requestId: "browser-invalid-renderer",
    dialogKind: "input",
    payload: { sessionId: "s", toolCallId: "t1", toolName: "request_user_input", prompt: "Value" },
  }, {
    driver: {
      render: () => ({ behavior: "not-a-dialog-result" } as any),
      alert: async (message) => { alerts.push(message); },
    },
  });

  assert.deepEqual(result, { behavior: "cancelled", reason: "browser dialog renderer returned an invalid result" });
  assert.deepEqual(alerts, ["The browser dialog renderer returned an invalid result."]);
});

test("browser dialog renderer discards a late asynchronous host answer after abort", async () => {
  const controller = new AbortController();
  const result = await renderBrowserUserDialog({
    requestId: "browser-late-renderer",
    dialogKind: "confirm",
    payload: { sessionId: "s", toolCallId: "t1", toolName: "request_user_confirmation", prompt: "Continue?" },
  }, {
    signal: controller.signal,
    driver: {
      async render(_request, context) {
        assert.equal(context.signal, controller.signal);
        controller.abort();
        return { behavior: "answered", value: true };
      },
    },
  });

  assert.deepEqual(result, { behavior: "cancelled", reason: "browser dialog was aborted" });
});

test("DOM browser dialog driver renders typed schema controls without owning Gateway dialog state", async () => {
  const document = new FakeDomDocument();
  const driver = createDomBrowserDialogDriver({ document: document as unknown as Document });
  const controller = new AbortController();
  const pending = driver.render!({
    requestId: "dom-form",
    dialogKind: "form",
    payload: {
      sessionId: "s",
      toolCallId: "t",
      toolName: "request_user_form",
      prompt: "Configure deployment",
      schema: {
        type: "object",
        properties: {
          region: { type: "string" },
          replicas: { type: "integer", default: 2 },
          mode: { enum: ["safe", "fast"] },
          approved: { type: "boolean" },
          metadata: {
            type: "object",
            properties: { owner: { type: "string", default: "sdk" } },
            required: ["owner"],
          },
          reviewer: { $ref: "#/$defs/reviewer" },
          nestedRegion: { $ref: "#/$defs/regionAlias" },
        },
        required: ["region", "replicas", "mode", "approved", "metadata", "reviewer", "nestedRegion"],
        patternProperties: { "^x-": { type: "string" } },
        default: { "x-root": "root-value" },
        $defs: {
          reviewer: {
            type: "object",
            properties: { name: { type: "string", default: "Ari" } },
            required: ["name"],
          },
          regionAlias: { $ref: "#/$defs/region" },
          region: { type: "string", default: "eu-central" },
        },
      },
    },
  }, { signal: controller.signal });
  assert.ok(pending);

  const inputs = findFakeDomElements(document.body, (element) => element.name === "region" || element.name === "replicas");
  inputs.find((element) => element.name === "region")!.value = "eu-west";
  inputs.find((element) => element.name === "replicas")!.value = "3";
  const mode = findFakeDomElements(document.body, (element) => element.name === "mode")[0]!;
  mode.value = "1";
  const approved = findFakeDomElements(document.body, (element) => element.name === "approved")[0]!;
  approved.checked = true;
  const rootExtra = findFakeDomElements(document.body, (element) => element.name === "$additional")[0]!;
  assert.equal(rootExtra.value, "{\n  \"x-root\": \"root-value\"\n}");
  const form = findFakeDomElements(document.body, (element) => element.tagName === "form")[0]!;
  form.emit("submit");

  assert.deepEqual(await pending, {
    behavior: "answered",
    value: {
      region: "eu-west",
      replicas: 3,
      mode: "fast",
      approved: true,
      metadata: { owner: "sdk" },
      reviewer: { name: "Ari" },
      nestedRegion: "eu-central",
      "x-root": "root-value",
    },
  });
  assert.equal(document.body.children.length, 0);

  const cancelled = driver.render!({
    requestId: "dom-cancel",
    dialogKind: "input",
    payload: { sessionId: "s", toolCallId: "t", toolName: "request_user_input", prompt: "Name" },
  }, { signal: controller.signal });
  const cancel = findFakeDomElements(document.body, (element) => element.tagName === "button" && element.type === "button")[0]!;
  cancel.emit("click");
  assert.deepEqual(await cancelled, { behavior: "cancelled", reason: "browser dialog was cancelled" });
  assert.equal(document.body.children.length, 0);

  const abortController = new AbortController();
  const aborted = driver.render!({
    requestId: "dom-abort",
    dialogKind: "confirm",
    payload: { sessionId: "s", toolCallId: "t", toolName: "request_user_confirmation", prompt: "Continue?" },
  }, { signal: abortController.signal });
  abortController.abort();
  assert.deepEqual(await aborted, { behavior: "cancelled", reason: "browser dialog was aborted" });
  assert.equal(document.body.children.length, 0);
});

test("DOM browser dialog driver renders typed array items, tuples, and unconstrained tails", async () => {
  const document = new FakeDomDocument();
  const driver = createDomBrowserDialogDriver({ document: document as unknown as Document });
  const controller = new AbortController();
  const pending = driver.render!({
    requestId: "dom-arrays",
    dialogKind: "form",
    payload: {
      sessionId: "s",
      toolCallId: "t",
      toolName: "request_user_form",
      prompt: "Configure targets",
      schema: {
        type: "object",
        properties: {
          tags: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 2,
            default: ["edge"],
          },
          coordinates: {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "integer" }],
            minItems: 2,
            maxItems: 2,
          },
          arbitraryTail: {
            type: "array",
            prefixItems: [{ type: "string", default: "head" }],
            minItems: 2,
          },
          labels: {
            type: "object",
            properties: { fixed: { type: "string", default: "fixed" } },
            patternProperties: { "^x-": { type: "string" } },
            additionalProperties: false,
            default: { fixed: "fixed", "x-trace": "enabled" },
          },
        },
        required: ["tags", "coordinates", "arbitraryTail", "labels"],
      },
    },
  }, { signal: controller.signal });

  const add = findFakeDomElements(document.body, (element) =>
    element.attributes.get("data-pilotdeck-dialog-array-add") === "true",
  )[0]!;
  add.emit("click");
  const tagInputs = findFakeDomElements(document.body, (element) =>
    element.name === "tags[0]" || element.name === "tags[1]",
  );
  assert.equal(tagInputs.length, 2);
  tagInputs.find((element) => element.name === "tags[1]")!.value = "stable";
  const coordinates = findFakeDomElements(document.body, (element) =>
    element.name === "coordinates[0]" || element.name === "coordinates[1]",
  );
  coordinates.find((element) => element.name === "coordinates[0]")!.value = "eu-west";
  coordinates.find((element) => element.name === "coordinates[1]")!.value = "3";
  findFakeDomElements(document.body, (element) => element.name === "arbitraryTail[1]")[0]!.value = "{\"enabled\":true}";
  const labelsExtra = findFakeDomElements(document.body, (element) => element.name === "labels.$additional")[0]!;
  assert.equal(labelsExtra.value, "{\n  \"x-trace\": \"enabled\"\n}");
  findFakeDomElements(document.body, (element) => element.tagName === "form")[0]!.emit("submit");

  assert.deepEqual(await pending, {
    behavior: "answered",
    value: {
      tags: ["edge", "stable"],
      coordinates: ["eu-west", 3],
      arbitraryTail: ["head", { enabled: true }],
      labels: { fixed: "fixed", "x-trace": "enabled" },
    },
  });
  assert.equal(document.body.children.length, 0);
});

test("DOM browser dialog driver removes optional homogeneous array items without changing tuple prefixes", async () => {
  const document = new FakeDomDocument();
  const driver = createDomBrowserDialogDriver({ document: document as unknown as Document });
  const controller = new AbortController();
  const pending = driver.render!({
    requestId: "dom-array-remove",
    dialogKind: "form",
    payload: {
      sessionId: "s",
      toolCallId: "t",
      toolName: "request_user_form",
      prompt: "Choose values",
      schema: {
        type: "object",
        properties: {
          values: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 2,
            default: ["first", "second"],
          },
        },
        required: ["values"],
      },
    },
  }, { signal: controller.signal });
  findFakeDomElements(document.body, (element) =>
    element.attributes.get("data-pilotdeck-dialog-array-remove") === "0",
  )[0]!.emit("click");
  findFakeDomElements(document.body, (element) =>
    element.attributes.get("data-pilotdeck-dialog-array-add") === "true",
  )[0]!.emit("click");
  findFakeDomElements(document.body, (element) => element.name === "values[2]")[0]!.value = "third";
  findFakeDomElements(document.body, (element) => element.tagName === "form")[0]!.emit("submit");

  assert.deepEqual(await pending, { behavior: "answered", value: { values: ["second", "third"] } });
  assert.equal(document.body.children.length, 0);
});

test("DOM browser dialog driver renders non-conflicting allOf fields and selectable union branches", async () => {
  const document = new FakeDomDocument();
  const driver = createDomBrowserDialogDriver({ document: document as unknown as Document });
  const controller = new AbortController();
  const pending = driver.render!({
    requestId: "dom-composition",
    dialogKind: "form",
    payload: {
      sessionId: "s",
      toolCallId: "t",
      toolName: "request_user_form",
      prompt: "Configure a release",
      schema: {
        type: "object",
        allOf: [
          {
            type: "object",
            properties: { service: { type: "string" } },
            required: ["service"],
          },
          {
            type: "object",
            properties: { retries: { type: "integer", default: 2 } },
            required: ["retries"],
          },
        ],
        properties: {
          target: {
            title: "Target",
            oneOf: [
              {
                title: "Single region",
                type: "object",
                properties: { region: { type: "string" } },
                required: ["region"],
              },
              {
                title: "Region list",
                type: "array",
                items: { type: "string" },
                minItems: 1,
              },
            ],
          },
        },
        required: ["target"],
      },
    },
  }, { signal: controller.signal });

  findFakeDomElements(document.body, (element) => element.name === "service")[0]!.value = "api";
  const selector = findFakeDomElements(document.body, (element) =>
    element.attributes.get("data-pilotdeck-dialog-union-selector") === "target",
  )[0]!;
  selector.value = "1";
  selector.emit("change");
  const add = findFakeDomElements(document.body, (element) =>
    element.attributes.get("data-pilotdeck-dialog-array-add") === "true",
  )[0]!;
  add.emit("click");
  findFakeDomElements(document.body, (element) => element.name === "target[0]")[0]!.value = "eu-west";
  findFakeDomElements(document.body, (element) => element.tagName === "form")[0]!.emit("submit");

  assert.deepEqual(await pending, {
    behavior: "answered",
    value: { service: "api", retries: 2, target: ["eu-west"] },
  });
  assert.equal(document.body.children.length, 0);
});

test("DOM browser dialog driver keeps a form open when local composition validation fails", async () => {
  const document = new FakeDomDocument();
  const driver = createDomBrowserDialogDriver({ document: document as unknown as Document });
  const controller = new AbortController();
  const pending = driver.render!({
    requestId: "dom-composition-validation",
    dialogKind: "form",
    payload: {
      sessionId: "s",
      toolCallId: "t",
      toolName: "request_user_form",
      prompt: "Choose deployment target",
      schema: {
        type: "object",
        properties: {
          target: {
            oneOf: [
              { type: "string", minLength: 3 },
              {
                type: "object",
                properties: { region: { type: "string", minLength: 3 } },
                required: ["region"],
              },
            ],
          },
        },
        required: ["target"],
      },
    },
  }, { signal: controller.signal });

  const selector = findFakeDomElements(document.body, (element) =>
    element.attributes.get("data-pilotdeck-dialog-union-selector") === "target",
  )[0]!;
  selector.value = "1";
  selector.emit("change");
  const form = findFakeDomElements(document.body, (element) => element.tagName === "form")[0]!;
  form.emit("submit");
  const error = findFakeDomElements(document.body, (element) => element.attributes.get("role") === "alert")[0]!;
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /does not match its schema/);
  assert.equal(document.body.children.length, 1, "invalid local answer must not dismiss the pending dialog");

  findFakeDomElements(document.body, (element) => element.name === "target.region")[0]!.value = "eu-west";
  form.emit("submit");
  assert.deepEqual(await pending, { behavior: "answered", value: { target: { region: "eu-west" } } });
  assert.equal(document.body.children.length, 0);
});

test("DOM browser dialog driver renders a pure root oneOf as a typed branch form", async () => {
  const document = new FakeDomDocument();
  const driver = createDomBrowserDialogDriver({ document: document as unknown as Document });
  const controller = new AbortController();
  const pending = driver.render!({
    requestId: "dom-root-union",
    dialogKind: "form",
    payload: {
      sessionId: "s",
      toolCallId: "t",
      toolName: "request_user_form",
      prompt: "Select deployment mode",
      schema: {
        type: "object",
        oneOf: [
          {
            title: "Single region",
            type: "object",
            properties: {
              mode: { const: "single" },
              region: { type: "string" },
            },
            required: ["mode", "region"],
          },
          {
            title: "Multi region",
            type: "object",
            properties: {
              mode: { const: "multi" },
              primary: { type: "string" },
            },
            required: ["mode", "primary"],
          },
        ],
      },
    },
  }, { signal: controller.signal });

  const selector = findFakeDomElements(document.body, (element) =>
    element.attributes.get("data-pilotdeck-dialog-root-union-selector") === "true",
  )[0]!;
  selector.value = "1";
  selector.emit("change");
  findFakeDomElements(document.body, (element) => element.name === "$root.primary")[0]!.value = "us-east";
  findFakeDomElements(document.body, (element) => element.tagName === "form")[0]!.emit("submit");

  assert.deepEqual(await pending, { behavior: "answered", value: { mode: "multi", primary: "us-east" } });
  assert.equal(document.body.children.length, 0);
});

test("terminal dialog renderer answers select, confirm, and schema form requests", async () => {
  const terminal = scriptedTerminalDialogIO(["2", "yes", "Ada", "3", "yes", "{\"mode\":\"fast\"}"]);
  const handler = createTerminalUserDialogHandler({ io: terminal.io });
  const controller = new AbortController();

  const select = await handler({
    requestId: "select-1",
    dialogKind: "select",
    payload: {
      sessionId: "s1",
      toolCallId: "tool-1",
      toolName: "request_user_choice",
      prompt: "Choose a deployment target",
      choices: [{ value: "staging" }, { value: "production" }],
    },
  }, { signal: controller.signal });
  assert.deepEqual(select, { behavior: "answered", value: "production" });

  const confirm = await handler({
    requestId: "confirm-1",
    dialogKind: "confirm",
    payload: {
      sessionId: "s1",
      toolCallId: "tool-2",
      toolName: "request_user_confirmation",
      prompt: "Continue?",
    },
  }, { signal: controller.signal });
  assert.deepEqual(confirm, { behavior: "answered", value: true });

  const form = await handler({
    requestId: "form-1",
    dialogKind: "form",
    payload: {
      sessionId: "s1",
      toolCallId: "tool-3",
      toolName: "request_user_form",
      prompt: "Configure the release",
      schema: {
        type: "object",
        required: ["name", "retries", "approved", "strategy"],
        properties: {
          name: { type: "string", minLength: 2 },
          retries: { type: "integer", minimum: 1 },
          approved: { type: "boolean" },
          strategy: {
            oneOf: [
              { type: "object", properties: { mode: { const: "fast" } }, required: ["mode"] },
              { type: "object", properties: { mode: { const: "safe" } }, required: ["mode"] },
            ],
          },
        },
      },
    },
  }, { signal: controller.signal });
  assert.deepEqual(form, {
    behavior: "answered",
    value: { name: "Ada", retries: 3, approved: true, strategy: { mode: "fast" } },
  });
  assert.equal(terminal.prompts.length, 6);
});

test("terminal dialog renderer follows local refs and cancels on exhausted input", async () => {
  const terminal = scriptedTerminalDialogIO(["", "", "", "Mina"]);
  const handler = createTerminalUserDialogHandler({ io: terminal.io, maxAttempts: 3 });
  const controller = new AbortController();
  const cancelled = await handler({
    requestId: "input-1",
    dialogKind: "input",
    payload: {
      sessionId: "s1",
      toolCallId: "tool-1",
      toolName: "request_user_input",
      prompt: "Required value",
    },
  }, { signal: controller.signal });
  assert.deepEqual(cancelled, { behavior: "cancelled", reason: "too many invalid terminal answers" });

  const form = await handler({
    requestId: "form-ref-1",
    dialogKind: "form",
    payload: {
      sessionId: "s1",
      toolCallId: "tool-2",
      toolName: "request_user_form",
      prompt: "Enter a reviewer",
      schema: {
        type: "object",
        required: ["reviewer"],
        $defs: {
          person: { type: "string", minLength: 2 },
        },
        properties: {
          reviewer: { $ref: "#/$defs/person", title: "Reviewer" },
        },
      },
    },
  }, { signal: controller.signal });
  assert.deepEqual(form, { behavior: "answered", value: { reviewer: "Mina" } });
  assert.ok(terminal.output.filter((line) => line === "A value is required.").length >= 1);
});

test("terminal dialog renderer can render a manual live dialog response", async () => {
  const terminal = scriptedTerminalDialogIO(["release-42"]);
  const result = await renderTerminalUserDialog({
    requestId: "manual-input-1",
    dialogKind: "input",
    payload: {
      sessionId: "s1",
      toolCallId: "tool-1",
      toolName: "request_user_input",
      prompt: "Release name",
    },
  }, { io: terminal.io });
  assert.deepEqual(result, { behavior: "answered", value: "release-42" });
});

test("terminal dialog renderer retries a form rejected by a composition constraint", async () => {
  const terminal = scriptedTerminalDialogIO(["lowercase", "RELEASE"]);
  const result = await renderTerminalUserDialog({
    requestId: "form-composition-1",
    dialogKind: "form",
    payload: {
      sessionId: "s1",
      toolCallId: "tool-1",
      toolName: "request_user_form",
      prompt: "Enter a release code",
      schema: {
        type: "object",
        required: ["code"],
        properties: {
          code: { type: "string" },
        },
        allOf: [{
          properties: {
            code: { pattern: "^[A-Z]+$" },
          },
        }],
      },
    },
  }, { io: terminal.io });
  assert.deepEqual(result, { behavior: "answered", value: { code: "RELEASE" } });
  assert.equal(terminal.prompts.length, 2);
  assert.ok(terminal.output.some((line) => line.startsWith("The form does not match its schema:")));
});

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  private listeners = new Map<string, ((event: any) => void)[]>();
  constructor(public readonly url: string) {
    queueMicrotask(() => { this.readyState = 1; this.emit("open", {}); });
  }
  addEventListener(name: string, handler: (event: any) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]);
  }
  send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.type === "hello") {
      this.emit("message", { data: JSON.stringify({ type: "hello_ok", protocolVersion: "1.1", serverVersion: "test", serverInfo: { mode: "remote", capabilities: [] } }) });
    } else if (frame.method === "new_session") {
      this.emit("message", { data: JSON.stringify({ type: "response", id: frame.id, ok: true, result: { sessionKey: "s1" } }) });
    } else if (frame.method === "submit_turn") {
      const events = [
        { type: "turn_started", runId: "r1" },
        { type: "assistant_text_delta", text: "hello" },
        { type: "turn_completed", usage: { inputTokens: 1 }, finishReason: "stop" },
      ];
      events.forEach((event, seq) => this.emit("message", { data: JSON.stringify({ type: "event", id: frame.id, seq, final: false, event }) }));
      this.emit("message", { data: JSON.stringify({ type: "event", id: frame.id, seq: events.length, final: true, event: events[2] }) });
    }
  }
  close(): void { this.readyState = 3; this.emit("close", {}); }
  private emit(name: string, event: any): void { for (const handler of this.listeners.get(name) ?? []) handler(event); }
}

class CapturePermissionModeWebSocket extends FakeWebSocket {
  static submits: any[] = [];
  static modeChanges: any[] = [];

  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "submit_turn") {
      CapturePermissionModeWebSocket.submits.push(frame.params);
      super.send(raw);
      return;
    }
    if (frame.method === "set_permission_mode") {
      CapturePermissionModeWebSocket.modeChanges.push(frame.params);
      (this as any).emit("message", {
        data: JSON.stringify({ type: "response", id: frame.id, ok: true, result: { applied: true } }),
      });
      return;
    }
    super.send(raw);
  }
}

class ForwardSubagentTextWebSocket extends FakeWebSocket {
  static submittedConfig: unknown;

  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method !== "submit_turn") {
      super.send(raw);
      return;
    }
    ForwardSubagentTextWebSocket.submittedConfig = frame.params.sdkSessionConfig;
    const events = [
      { type: "turn_started", runId: "r1" },
      {
        type: "subagent_text_delta",
        subagentId: "child-1",
        subagentType: "researcher",
        text: "Child result",
        runId: "r1",
      },
      { type: "assistant_text_delta", text: "Parent result", runId: "r1" },
      { type: "turn_completed", usage: { inputTokens: 1 }, finishReason: "stop", runId: "r1" },
    ];
    events.forEach((event, seq) => {
      (this as any).emit("message", { data: JSON.stringify({ type: "event", id: frame.id, seq, final: false, event }) });
    });
    (this as any).emit("message", {
      data: JSON.stringify({ type: "event", id: frame.id, seq: events.length, final: true, event: events.at(-1) }),
    });
  }
}

test("query serializes the restrictive managed canPrompt policy", async () => {
  CapturePermissionModeWebSocket.submits = [];
  (globalThis as any).WebSocket = CapturePermissionModeWebSocket;
  const run = query({
    prompt: "run without interactive approval",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      managedSettings: { permissions: { canPrompt: false } },
    },
  });
  for await (const _event of run) { /* consume */ }

  assert.deepEqual(CapturePermissionModeWebSocket.submits[0]?.sdkSessionConfig, {
    managedPermissions: { deny: [], ask: [], canPrompt: false },
  });
});

test("query forwards opt-in child text without changing the parent result", async () => {
  ForwardSubagentTextWebSocket.submittedConfig = undefined;
  (globalThis as any).WebSocket = ForwardSubagentTextWebSocket;
  const run = query({
    prompt: "delegate a focused task",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      forwardSubagentText: true,
    },
  });
  const events: any[] = [];
  for await (const event of run) events.push(event);

  assert.deepEqual(ForwardSubagentTextWebSocket.submittedConfig, { forwardSubagentText: true });
  assert.deepEqual(events.filter((event) => event.type === "subagent.message"), [{
    type: "subagent.message",
    subagentId: "child-1",
    subagentType: "researcher",
    text: "Child result",
    runId: "r1",
    sessionId: "s1",
    sequence: 1,
  }]);
  assert.equal(events.some((event) => event.type === "assistant.message"), false);
  assert.deepEqual(await run.result(), {
    status: "completed",
    output: "Parent result",
    usage: { inputTokens: 1 },
    finishReason: "stop",
  });
});

test("query serializes restrictive managed tool selectors", async () => {
  CapturePermissionModeWebSocket.submits = [];
  (globalThis as any).WebSocket = CapturePermissionModeWebSocket;
  const run = query({
    prompt: "run with a minimal tool surface",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      managedSettings: {
        tools: { allow: ["read_file", "grep*"], deny: ["grep"] },
      },
    },
  });
  for await (const _event of run) { /* consume */ }

  assert.deepEqual(CapturePermissionModeWebSocket.submits[0]?.sdkSessionConfig, {
    managedTools: { allow: ["read_file", "grep*"], deny: ["grep"] },
  });
});

test("query serializes restrictive managed model selectors", async () => {
  CapturePermissionModeWebSocket.submits = [];
  (globalThis as any).WebSocket = CapturePermissionModeWebSocket;
  const run = query({
    prompt: "run with an approved model family",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      managedSettings: {
        models: { allow: ["test/*"], deny: ["test/blocked"] },
      },
    },
  });
  for await (const _event of run) { /* consume */ }

  assert.deepEqual(CapturePermissionModeWebSocket.submits[0]?.sdkSessionConfig, {
    managedModels: { allow: ["test/*"], deny: ["test/blocked"] },
  });
});

test("query serializes a session deferred-tool catalog and rejects invalid catalogs before connecting", async () => {
  CapturePermissionModeWebSocket.submits = [];
  (globalThis as any).WebSocket = CapturePermissionModeWebSocket;
  const run = query({
    prompt: "search the specialized tools only when needed",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      deferredTools: [
        { name: " get_current_time ", searchHint: " current timezone and timestamp " },
        { name: "mcp__catalog__lookup" },
      ],
    },
  });
  for await (const _event of run) { /* consume */ }

  assert.deepEqual(CapturePermissionModeWebSocket.submits[0]?.sdkSessionConfig, {
    deferredTools: [
      { name: "get_current_time", searchHint: "current timezone and timestamp" },
      { name: "mcp__catalog__lookup" },
    ],
  });

  for (const deferredTools of [
    [],
    [{ name: "lookup" }, { name: " lookup " }],
    [{ name: "search_tools" }],
  ]) {
    const invalid = query({
      prompt: "invalid deferred catalog",
      options: { gatewayUrl: "ws://fake", authToken: "token", deferredTools },
    });
    await assert.rejects(
      () => invalid.next(),
      (error: unknown) => (error as { code?: string }).code === "validation_error",
    );
  }
  assert.equal(CapturePermissionModeWebSocket.submits.length, 1);
});

test("query serializes session-scoped subagent settings without a global model override", async () => {
  CapturePermissionModeWebSocket.submits = [];
  (globalThis as any).WebSocket = CapturePermissionModeWebSocket;
  const run = query({
    prompt: "run the bounded subagent task",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      settings: { agent: { model: "test/reviewer", fallbackModel: "test/reviewer", subagents: { default: "test/reviewer", timeoutMs: 12_000, maxDepth: 2 } } },
    },
  });
  for await (const _event of run) { /* consume */ }

  assert.deepEqual(CapturePermissionModeWebSocket.submits[0]?.sdkSessionConfig, {
    settings: { agent: { model: "test/reviewer", fallbackModel: "test/reviewer", subagents: { default: "test/reviewer", timeoutMs: 12_000, maxDepth: 2 } } },
  });
});

test("query normalizes an inherited subagent setting to the Gateway null sentinel", async () => {
  CapturePermissionModeWebSocket.submits = [];
  (globalThis as any).WebSocket = CapturePermissionModeWebSocket;
  const run = query({
    prompt: "use the parent model for forks",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      settings: { agent: { subagents: { default: "inherit" } } },
    },
  });
  for await (const _event of run) { /* consume */ }

  assert.deepEqual(CapturePermissionModeWebSocket.submits[0]?.sdkSessionConfig, {
    settings: { agent: { subagents: { default: null } } },
  });
});

class FakeEmbeddedEndpoint {
  private readonly messageListeners = new Set<(message: string) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  helloCount = 0;
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];

  sendToGateway(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.type === "hello") {
      this.helloCount += 1;
      this.emit({ type: "hello_ok", protocolVersion: "1.1", serverVersion: "embedded-test", serverInfo: { mode: "default", capabilities: [] } });
      return;
    }
    this.requests.push({ method: frame.method, params: frame.params });
    if (frame.method === "describe_server") {
      this.emit({ type: "response", id: frame.id, ok: true, result: { mode: "default", protocolVersion: "1.1", serverVersion: "embedded-test", capabilities: [] } });
      return;
    }
    if (frame.method === "new_session") {
      this.emit({ type: "response", id: frame.id, ok: true, result: { sessionKey: "embedded-session" } });
      return;
    }
    if (frame.method === "list_sessions") {
      this.emit({ type: "response", id: frame.id, ok: true, result: { sessions: [{ sessionKey: "embedded-session", sessionId: "embedded-session" }] } });
      return;
    }
    if (frame.method === "submit_turn") {
      this.emit({ type: "event", id: frame.id, seq: 0, final: true, event: { type: "turn_completed", result: "embedded" } });
    }
  }

  onGatewayMessage(listener: (message: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onGatewayClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }

  private emit(frame: unknown): void {
    queueMicrotask(() => {
      for (const listener of this.messageListeners) listener(JSON.stringify(frame));
    });
  }
}

test("query returns a terminal result without partial deltas by default", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token" } });
  const events = [];
  for await (const event of run) events.push(event.type);
  assert.deepEqual(events, ["turn.started", "result"]);
  assert.deepEqual(await run.result(), { status: "completed", output: "hello", usage: { inputTokens: 1 }, finishReason: "stop" });
});

test("query emits streamed assistant deltas when includePartialMessages is enabled", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  const run = query({
    prompt: "hello",
    options: { gatewayUrl: "ws://fake", authToken: "token", includePartialMessages: true },
  });
  const events = [];
  for await (const event of run) events.push(event.type);
  assert.deepEqual(events, ["turn.started", "assistant.message", "result"]);
  assert.deepEqual(await run.result(), { status: "completed", output: "hello", usage: { inputTokens: 1 }, finishReason: "stop" });
});

test("permissionMode auto uses the conservative Gateway default path", async () => {
  CapturePermissionModeWebSocket.submits = [];
  CapturePermissionModeWebSocket.modeChanges = [];
  (globalThis as any).WebSocket = CapturePermissionModeWebSocket;

  const auto = query({
    prompt: "check this safely",
    options: { gatewayUrl: "ws://fake", authToken: "token", permissionMode: "auto" },
  });
  for await (const _event of auto) { /* consume */ }
  assert.deepEqual(CapturePermissionModeWebSocket.submits[0], {
    sessionKey: "s1",
    channelKey: "api_server",
    message: "check this safely",
    canPrompt: false,
    canElicit: false,
    mode: "default",
    basePermissionMode: "default",
  });
  await auto.setPermissionMode("auto");
  assert.deepEqual(CapturePermissionModeWebSocket.modeChanges, [{ sessionKey: "s1", mode: "default" }]);
  auto.close();

  const plan = query({
    prompt: "draft a plan",
    options: { gatewayUrl: "ws://fake", authToken: "token", permissionMode: "plan" },
  });
  for await (const _event of plan) { /* consume */ }
  assert.equal(CapturePermissionModeWebSocket.submits[1]?.mode, "plan");
  assert.equal(CapturePermissionModeWebSocket.submits[1]?.basePermissionMode, "default");
  plan.close();
});

class SessionArchiveWebSocket extends FakeWebSocket {
  static requests: Array<{ method: string; params: unknown }> = [];

  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.type === "hello") {
      super.send(raw);
      return;
    }
    SessionArchiveWebSocket.requests.push({ method: frame.method, params: frame.params });
    if (frame.method === "export_session_transcript") {
      this.emitForTest({
        type: "response",
        id: frame.id,
        ok: true,
        result: {
          schemaVersion: 1,
          format: "portable_text_messages",
          title: "Restored title",
          messages: [
            { role: "user", text: "Earlier question" },
            { role: "assistant", text: "Earlier answer" },
          ],
        },
      });
      return;
    }
    if (frame.method === "new_session") {
      this.emitForTest({ type: "response", id: frame.id, ok: true, result: { sessionKey: "restored-session" } });
      return;
    }
    if (frame.method === "restore_session_transcript") {
      this.emitForTest({
        type: "response",
        id: frame.id,
        ok: true,
        result: { sessionKey: "restored-session", importedMessages: 2 },
      });
      return;
    }
    super.send(raw);
  }

  emitForTest(frame: unknown): void {
    (this as any).emit("message", { data: JSON.stringify(frame) });
  }
}

test("SDK exports and restores Gateway-owned portable session archives", async () => {
  (globalThis as any).WebSocket = SessionArchiveWebSocket;
  SessionArchiveWebSocket.requests = [];
  const options = { gatewayUrl: "ws://fake", authToken: "token", projectKey: "project" };
  const archive = await exportSessionTranscript("source-session", options);
  assert.deepEqual(archive.messages, [
    { role: "user", text: "Earlier question" },
    { role: "assistant", text: "Earlier answer" },
  ]);
  const restored = await restoreSessionTranscript(archive, options);
  assert.equal(restored.sessionId, "restored-session");
  assert.deepEqual(SessionArchiveWebSocket.requests, [
    { method: "export_session_transcript", params: { sessionKey: "source-session", projectKey: "project" } },
    { method: "new_session", params: { projectKey: "project", channelKey: "api_server" } },
    {
      method: "restore_session_transcript",
      params: { sessionKey: "restored-session", projectKey: "project", archive },
    },
  ]);

  const client = createPilotDeckClient(options);
  const viaClient = await client.sessions.restoreTranscript(archive);
  assert.equal(viaClient.sessionId, "restored-session");
  await client.close();
});

class ToolProgressWebSocket extends FakeWebSocket {
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "submit_turn") {
      const events = [
        { type: "turn_started", runId: "r-progress" },
        {
          type: "tool_progress",
          toolCallId: "call-progress",
          toolName: "bash",
          message: "stdout: 7 bytes",
          metadata: { stream: "stdout", chunk: "working", byteCount: 7 },
          createdAt: "2026-09-09T00:00:00.000Z",
          runId: "r-progress",
        },
        { type: "turn_completed", usage: {}, finishReason: "stop" },
      ];
      events.forEach((event, seq) => (this as any).emit("message", {
        data: JSON.stringify({ type: "event", id: frame.id, seq, final: seq === events.length - 1, event }),
      }));
      return;
    }
    super.send(raw);
  }
}

test("query maps Gateway tool progress to the public opt-in event type", async () => {
  (globalThis as any).WebSocket = ToolProgressWebSocket;
  const run = query({
    prompt: "run a command",
    options: { gatewayUrl: "ws://fake", authToken: "token", agentProgressSummaries: true },
  });
  const events: any[] = [];
  for await (const event of run) events.push(event);

  assert.deepEqual(events.map((event) => event.type), ["turn.started", "tool.progress", "result"]);
  assert.deepEqual(events[1], {
    type: "tool.progress",
    toolCallId: "call-progress",
    toolName: "bash",
    message: "stdout: 7 bytes",
    metadata: { stream: "stdout", chunk: "working", byteCount: 7 },
    createdAt: "2026-09-09T00:00:00.000Z",
    runId: "r-progress",
    sequence: 1,
    sessionId: "s1",
  });
});

class PromptSuggestionWebSocket extends FakeWebSocket {
  static sdkSessionConfig: unknown;

  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "submit_turn") {
      PromptSuggestionWebSocket.sdkSessionConfig = frame.params.sdkSessionConfig;
      const events = [
        { type: "turn_started", runId: "r-suggestion" },
        { type: "prompt_suggestion", suggestion: "Run the focused tests and report the outcome." },
        { type: "turn_completed", usage: {}, finishReason: "stop" },
      ];
      events.forEach((event, seq) => (this as any).emit("message", {
        data: JSON.stringify({ type: "event", id: frame.id, seq, final: seq === events.length - 1, event }),
      }));
      return;
    }
    super.send(raw);
  }
}

test("query serializes promptSuggestions and maps the post-turn suggestion event", async () => {
  PromptSuggestionWebSocket.sdkSessionConfig = undefined;
  (globalThis as any).WebSocket = PromptSuggestionWebSocket;
  const run = query({
    prompt: "implement the change",
    options: { gatewayUrl: "ws://fake", authToken: "token", promptSuggestions: true },
  });
  const events: any[] = [];
  for await (const event of run) events.push(event);

  assert.deepEqual(PromptSuggestionWebSocket.sdkSessionConfig, { promptSuggestions: true });
  assert.deepEqual(events.map((event) => event.type), ["turn.started", "prompt_suggestion", "result"]);
  assert.deepEqual(events[1], {
    type: "prompt_suggestion",
    suggestion: "Run the focused tests and report the outcome.",
    runId: undefined,
    sequence: 1,
    sessionId: "s1",
  });
});

class CapturePromptWebSocket extends FakeWebSocket {
  static prompt?: string;
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "submit_turn") CapturePromptWebSocket.prompt = frame.params.message;
    super.send(raw);
  }
}

test("query accepts Claude-shaped async user messages and normalizes text content", async () => {
  CapturePromptWebSocket.prompt = undefined;
  (globalThis as any).WebSocket = CapturePromptWebSocket;
  async function* input() {
    yield { type: "user" as const, message: { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] } };
    yield { type: "text" as const, text: "world" };
  }
  const run = query({ prompt: input(), options: { gatewayUrl: "ws://fake", authToken: "token" } });
  for await (const _event of run) { /* consume */ }
  assert.equal(CapturePromptWebSocket.prompt, "hello\nworld");
});

test("query validates session-scoped agent definitions before opening the Gateway stream", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token", agents: { reviewer: {} as any } } });
  await assert.rejects(() => run.next(), { code: "validation_error" });
});

test("query validates AgentDefinition observer types and references before opening the Gateway stream", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  for (const definition of [
    { observer: true },
    { observerMessage: "Only report progress." },
  ]) {
    const run = query({
      prompt: "hello",
      options: {
        gatewayUrl: "ws://fake",
        authToken: "token",
        agents: { reviewer: { description: "review", prompt: "review", ...definition } as any },
      },
    });
    await assert.rejects(() => run.next(), { code: "validation_error" });
  }
  const missingTarget = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      agents: { reviewer: { description: "review", prompt: "review", observer: "auditor" } },
    },
  });
  await assert.rejects(() => missingTarget.next(), { code: "validation_error" });
});

class CaptureBackgroundAgentWebSocket extends FakeWebSocket {
  static sessionConfig: any;
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "submit_turn") {
      CaptureBackgroundAgentWebSocket.sessionConfig = frame.params.sdkSessionConfig;
    }
    super.send(raw);
  }
}

test("query serializes AgentDefinition.background through the Gateway session contract", async () => {
  CaptureBackgroundAgentWebSocket.sessionConfig = undefined;
  (globalThis as any).WebSocket = CaptureBackgroundAgentWebSocket;
  const run = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      agents: {
        reviewer: { description: "review", prompt: "review", background: true },
      },
    },
  });
  for await (const _event of run) { /* consume */ }
  assert.deepEqual(CaptureBackgroundAgentWebSocket.sessionConfig?.agents, {
    reviewer: { description: "review", prompt: "review", background: true },
  });
});

test("query serializes Claude-shaped AgentDefinition MCP references and inline specs", async () => {
  CaptureBackgroundAgentWebSocket.sessionConfig = undefined;
  (globalThis as any).WebSocket = CaptureBackgroundAgentWebSocket;
  const run = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      agents: {
        reviewer: {
          description: "review",
          prompt: "review",
          mcpServers: [
            "tickets",
            { docs: { type: "http", url: "https://docs.example/mcp" } },
          ],
        },
      },
    },
  });
  for await (const _event of run) { /* consume */ }
  assert.deepEqual(CaptureBackgroundAgentWebSocket.sessionConfig?.agents, {
    reviewer: {
      description: "review",
      prompt: "review",
      mcpServers: [
        "tickets",
        { docs: { type: "streamable_http", url: "https://docs.example/mcp" } },
      ],
    },
  });

  const duplicate = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      agents: {
        reviewer: {
          description: "review",
          prompt: "review",
          mcpServers: ["tickets", "tickets"],
        },
      },
    },
  });
  await assert.rejects(() => duplicate.next(), { code: "validation_error" });
});

test("query serializes a named AgentDefinition observer and digest postamble", async () => {
  CaptureBackgroundAgentWebSocket.sessionConfig = undefined;
  (globalThis as any).WebSocket = CaptureBackgroundAgentWebSocket;
  const run = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      agents: {
        reviewer: {
          description: "review",
          prompt: "review",
          observer: "auditor",
          observerMessage: "Only report verified issues.",
        },
        auditor: { description: "audit", prompt: "audit" },
      },
    },
  });
  for await (const _event of run) { /* consume */ }
  assert.deepEqual(CaptureBackgroundAgentWebSocket.sessionConfig?.agents, {
    reviewer: {
      description: "review",
      prompt: "review",
      observer: "auditor",
      observerMessage: "Only report verified issues.",
    },
    auditor: { description: "audit", prompt: "audit" },
  });
});

test("query validates AgentDefinition initial prompt and critical reminder before opening the Gateway stream", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  for (const [field, value] of [
    ["initialPrompt", ""],
    ["criticalSystemReminder_EXPERIMENTAL", "   "],
  ]) {
    const run = query({
      prompt: "hello",
      options: {
        gatewayUrl: "ws://fake",
        authToken: "token",
        agents: { reviewer: { description: "review", prompt: "review", [field]: value } },
      } as any,
    });
    await assert.rejects(() => run.next(), { code: "validation_error" });
  }
});

test("query rejects unsupported Claude option fields instead of silently ignoring them", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  // `settings` is a supported Gateway-owned session overlay; keep this list
  // to Claude-only fields that still have no PilotDeck lifecycle.
  for (const key of ["agent", "pathToClaudeCodeExecutable"]) {
    const run = query({
      prompt: "hello",
      options: { gatewayUrl: "ws://fake", authToken: "token", [key]: key === "maxBudgetUsd" ? 1 : true } as any,
    });
    await assert.rejects(() => run.next(), (error: unknown) => (error as any)?.code === "unsupported_capability");
  }
});

class SandboxConfigWebSocket extends FakeWebSocket {
  static sandbox: unknown;

  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "submit_turn") SandboxConfigWebSocket.sandbox = frame.params.sdkSessionConfig?.sandbox;
    super.send(raw);
  }
}

test("query serializes Gateway-owned tool_policy and named host sandbox settings", async () => {
  SandboxConfigWebSocket.sandbox = undefined;
  (globalThis as any).WebSocket = SandboxConfigWebSocket;
  const run = query({
    prompt: "inspect safely",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      sandbox: { type: "tool_policy", filesystem: "read_only", network: "deny", process: "deny" },
    },
  });
  for await (const _event of run) { /* consume */ }
  assert.deepEqual(SandboxConfigWebSocket.sandbox, {
    filesystem: "read_only",
    network: "deny",
    process: "deny",
  });

  SandboxConfigWebSocket.sandbox = undefined;
  const noFilesystem = query({
    prompt: "inspect without filesystem access",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      sandbox: { type: "tool_policy", filesystem: "deny" },
    },
  });
  for await (const _event of noFilesystem) { /* consume */ }
  assert.deepEqual(SandboxConfigWebSocket.sandbox, { filesystem: "deny" });

  SandboxConfigWebSocket.sandbox = undefined;
  const hostProfile = query({
    prompt: "run inside the Gateway host boundary",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      sandbox: {
        type: "host",
        profile: "bubblewrap",
        toolIsolation: "strict",
        filesystem: "read_only",
        network: "deny",
      },
    },
  });
  for await (const _event of hostProfile) { /* consume */ }
  assert.deepEqual(SandboxConfigWebSocket.sandbox, {
    type: "host",
    profile: "bubblewrap",
    toolIsolation: "strict",
    filesystem: "read_only",
    network: "deny",
  });

  const invalid = query({
    prompt: "hello",
    options: { gatewayUrl: "ws://fake", authToken: "token", sandbox: { enabled: true } as any },
  });
  await assert.rejects(() => invalid.next(), { code: "unsupported_capability" });
});

class PluginConfigWebSocket extends FakeWebSocket {
  static plugins: unknown;

  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "submit_turn") PluginConfigWebSocket.plugins = frame.params.sdkSessionConfig?.plugins;
    super.send(raw);
  }
}

test("query forwards Gateway-local session plugin descriptors through sdkSessionConfig", async () => {
  PluginConfigWebSocket.plugins = undefined;
  (globalThis as any).WebSocket = PluginConfigWebSocket;
  const run = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      plugins: [{ type: "local", path: "/srv/pilotdeck/plugins/review" }],
    },
  });
  for await (const _event of run) { /* consume */ }
  assert.deepEqual(PluginConfigWebSocket.plugins, [{ type: "local", path: "/srv/pilotdeck/plugins/review" }]);
});

test("query rejects non-Gateway-local plugin descriptors before opening the stream", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  for (const plugins of [[], [{ type: "local", path: "relative-plugin" }], [{ type: "remote", path: "/srv/plugin" }]]) {
    const run = query({
      prompt: "hello",
      options: { gatewayUrl: "ws://fake", authToken: "token", plugins } as any,
    });
    await assert.rejects(() => run.next(), { code: "validation_error" });
  }
});

test("query rejects malformed session-scoped skills before opening the Gateway stream", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  for (const skills of [[], [""], ["review", "review"]]) {
    const run = query({
      prompt: "hello",
      options: { gatewayUrl: "ws://fake", authToken: "token", skills },
    });
    await assert.rejects(() => run.next(), { code: "validation_error" });
  }
});

class BudgetWebSocket extends FakeWebSocket {
  static maxBudgetUsd: unknown;
  static taskBudget: unknown;

  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "submit_turn") {
      BudgetWebSocket.maxBudgetUsd = frame.params.maxBudgetUsd;
      BudgetWebSocket.taskBudget = frame.params.sdkSessionConfig?.taskBudget;
    }
    super.send(raw);
  }
}

test("query forwards maxBudgetUsd to the Gateway-owned turn envelope", async () => {
  BudgetWebSocket.maxBudgetUsd = undefined;
  (globalThis as any).WebSocket = BudgetWebSocket;
  const run = query({
    prompt: "hello",
    options: { gatewayUrl: "ws://fake", authToken: "token", maxBudgetUsd: 0.125 },
  });
  for await (const _event of run) { /* consume */ }
  assert.equal(BudgetWebSocket.maxBudgetUsd, 0.125);
});

test("query rejects an invalid maxBudgetUsd before connecting", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  const run = query({
    prompt: "hello",
    options: { gatewayUrl: "ws://fake", authToken: "token", maxBudgetUsd: 0 },
  });
  await assert.rejects(() => run.next(), { code: "validation_error" });
});

test("query forwards taskBudget through Gateway-owned session config", async () => {
  BudgetWebSocket.taskBudget = undefined;
  (globalThis as any).WebSocket = BudgetWebSocket;
  const run = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      taskBudget: { total: 0.5, scope: "project", projectRetentionMs: 60_000 },
    },
  });
  for await (const _event of run) { /* consume */ }
  assert.deepEqual(BudgetWebSocket.taskBudget, {
    total: 0.5,
    scope: "project",
    projectRetentionMs: 60_000,
  });
});

test("query rejects an invalid taskBudget before connecting", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  const run = query({
    prompt: "hello",
    options: { gatewayUrl: "ws://fake", authToken: "token", taskBudget: { total: 0 } },
  });
  await assert.rejects(() => run.next(), { code: "validation_error" });
});

test("query rejects an unknown taskBudget scope before connecting", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  const run = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      taskBudget: { total: 0.5, scope: "workspace" as any },
    },
  });
  await assert.rejects(() => run.next(), { code: "validation_error" });
});

test("query rejects taskBudget retention outside a project scope before connecting", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  const run = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      taskBudget: { total: 0.5, projectRetentionMs: 60_000 },
    },
  });
  await assert.rejects(() => run.next(), { code: "validation_error" });
});

class ContextUsageWebSocket extends FakeWebSocket {
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "active_turn_snapshot") {
      (this as any).emit("message", {
        data: JSON.stringify({
          type: "response",
          id: frame.id,
          ok: true,
          result: {
            active: true,
            sessionKey: "s1",
            runId: "r1",
            events: [{
              type: "context_budget",
              used: 120,
              displayUsed: 118,
              total: 1000,
              maxContextTokens: 900,
              effectiveTotal: 900,
              reservedOutputTokens: 100,
              ratio: 120 / 900,
              state: "ok",
              source: "provider",
              exact: true,
              breakdown: {
                source: "local_estimate",
                total: 120,
                system: 30,
                tools: 40,
                messages: 40,
                mcp: 5,
                memory: 5,
              },
            }],
          },
        }),
      });
      return;
    }
    super.send(raw);
  }
}

test("getContextUsage accepts Claude-like detail options and preserves native diagnostics", async () => {
  (globalThis as any).WebSocket = ContextUsageWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token" } });
  assert.deepEqual(await run.getContextUsage({ detail: "summary" }), {
    type: "context_budget",
    used: 120,
    displayUsed: 118,
    total: 1000,
    maxContextTokens: 900,
    effectiveTotal: 900,
    reservedOutputTokens: 100,
    ratio: 120 / 900,
    state: "ok",
    source: "provider",
    exact: true,
    detail: "summary",
    breakdownAvailable: false,
  });
  run.close();
});

test("getContextUsage exposes Gateway-owned category estimates only in full mode", async () => {
  (globalThis as any).WebSocket = ContextUsageWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token" } });
  const usage = await run.getContextUsage({ detail: "full" });
  assert.equal(usage.breakdownAvailable, true);
  assert.deepEqual(usage.breakdown, {
    source: "local_estimate",
    total: 120,
    system: 30,
    tools: 40,
    messages: 40,
    mcp: 5,
    memory: 5,
  });
  assert.equal(usage.source, "provider");
  assert.equal(usage.exact, true);
  run.close();
});

test("usage does not mistake a context-budget event for turn usage", async () => {
  (globalThis as any).WebSocket = ContextUsageWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token" } });
  assert.deepEqual(await run.usage(), {});
  run.close();
});

test("usage uses Gateway-owned aggregate when usage_snapshot is advertised", async () => {
  class UsageSnapshotWebSocket extends FakeWebSocket {
    override send(raw: string): void {
      const frame = JSON.parse(raw);
      if (frame.type === "hello") {
        this.emitForTest({ type: "hello_ok", protocolVersion: "1.1", serverVersion: "test", serverInfo: { mode: "remote", capabilities: ["usage_snapshot"] } });
        return;
      }
      if (frame.method === "new_session") {
        this.emitForTest({ type: "response", id: frame.id, ok: true, result: { sessionKey: "usage-session" } });
        return;
      }
      if (frame.method === "usage_snapshot") {
        this.emitForTest({ type: "response", id: frame.id, ok: true, result: {
          scope: "session",
          sessionId: "usage-session",
          aggregate: {
            totalRequests: 2,
            totalInputTokens: 10,
            totalOutputTokens: 4,
            totalCost: 0.003,
            totalBaselineCost: 0.005,
            totalSavedCost: 0.002,
            perScenario: { default: 2 },
            perModel: { "test/model": 0.003 },
            perProvider: { test: 0.003 },
            perTier: { default: 2 },
            perRole: { main: 2 },
          },
        } });
        return;
      }
      super.send(raw);
    }
    emitForTest(frame: unknown): void { (this as any).emit("message", { data: JSON.stringify(frame) }); }
  }
  (globalThis as any).WebSocket = UsageSnapshotWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token" } });
  assert.deepEqual(await run.usage(), {
    scope: "session",
    totalRequests: 2,
    totalInputTokens: 10,
    totalOutputTokens: 4,
    totalCost: 0.003,
    totalBaselineCost: 0.005,
    totalSavedCost: 0.002,
    perScenario: { default: 2 },
    perModel: { "test/model": 0.003 },
    perProvider: { test: 0.003 },
    perTier: { default: 2 },
    perRole: { main: 2 },
    inputTokens: 10,
    outputTokens: 4,
    totalCostUsd: 0.003,
  });
  run.close();
});

test("modelUsage uses the Gateway-owned per-model aggregate", async () => {
  class ModelUsageWebSocket extends FakeWebSocket {
    override send(raw: string): void {
      const frame = JSON.parse(raw);
      if (frame.type === "hello") {
        this.emitForTest({ type: "hello_ok", protocolVersion: "1.1", serverVersion: "test", serverInfo: { mode: "remote", capabilities: ["model_usage_snapshot"] } });
        return;
      }
      if (frame.method === "new_session") {
        this.emitForTest({ type: "response", id: frame.id, ok: true, result: { sessionKey: "model-usage-session" } });
        return;
      }
      if (frame.method === "model_usage_snapshot") {
        assert.deepEqual(frame.params, { sessionKey: "model-usage-session" });
        this.emitForTest({ type: "response", id: frame.id, ok: true, result: {
          scope: "session",
          sessionId: "model-usage-session",
          models: [{
            provider: "test",
            model: "model-a",
            totalRequests: 2,
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
            totalTokens: 18,
            totalCost: 0.003,
            roles: { main: { totalRequests: 2, inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 1, totalTokens: 18, totalCost: 0.003 } },
          }],
        } });
        return;
      }
      super.send(raw);
    }
    emitForTest(frame: unknown): void { (this as any).emit("message", { data: JSON.stringify(frame) }); }
  }
  (globalThis as any).WebSocket = ModelUsageWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token" } });
  assert.deepEqual(await run.modelUsage(), {
    scope: "session",
    sessionId: "model-usage-session",
    models: [{
      provider: "test",
      model: "model-a",
      totalRequests: 2,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      totalTokens: 18,
      totalCost: 0.003,
      roles: { main: { totalRequests: 2, inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 1, totalTokens: 18, totalCost: 0.003 } },
    }],
  });
  run.close();
});

class EphemeralSessionWebSocket extends FakeWebSocket {
  static deletes: Array<Record<string, unknown>> = [];
  static sessionConfigs: Array<unknown> = [];
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "submit_turn") {
      EphemeralSessionWebSocket.sessionConfigs.push(frame.params.sdkSessionConfig);
    }
    if (frame.method === "rename_session") {
      throw new Error("persistSession=false must not write durable session metadata before submit_turn");
    }
    if (frame.method === "delete_session") {
      EphemeralSessionWebSocket.deletes.push(frame.params);
      (this as any).emit("message", { data: JSON.stringify({ type: "response", id: frame.id, ok: true, result: { ok: true } }) });
      return;
    }
    super.send(raw);
  }
}

class AbortableEphemeralSessionWebSocket extends FakeWebSocket {
  static deletes: Array<Record<string, unknown>> = [];
  static aborts: Array<Record<string, unknown>> = [];
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "submit_turn") {
      (this as any).emit("message", {
        data: JSON.stringify({ type: "event", id: frame.id, seq: 0, final: false, event: { type: "turn_started", runId: "r-abort" } }),
      });
      return;
    }
    if (frame.method === "abort_turn") {
      AbortableEphemeralSessionWebSocket.aborts.push(frame.params);
      (this as any).emit("message", { data: JSON.stringify({ type: "response", id: frame.id, ok: true, result: { aborted: true } }) });
      return;
    }
    if (frame.method === "delete_session") {
      AbortableEphemeralSessionWebSocket.deletes.push(frame.params);
      (this as any).emit("message", { data: JSON.stringify({ type: "response", id: frame.id, ok: true, result: { ok: true } }) });
      return;
    }
    super.send(raw);
  }
}

test("persistSession=false removes a terminal SDK-created Gateway session", async () => {
  EphemeralSessionWebSocket.deletes = [];
  EphemeralSessionWebSocket.sessionConfigs = [];
  (globalThis as any).WebSocket = EphemeralSessionWebSocket;
  const run = query({
    prompt: "hello",
    options: { gatewayUrl: "ws://fake", authToken: "token", persistSession: false, title: "temporary" },
  });
  for await (const _event of run) { /* consume */ }
  assert.deepEqual(EphemeralSessionWebSocket.deletes, [{ sessionKey: "s1" }]);
  assert.deepEqual(EphemeralSessionWebSocket.sessionConfigs, [{ persistSession: false }]);
  run.close();
});

test("persistSession=false removes a session after explicit abort", async () => {
  AbortableEphemeralSessionWebSocket.deletes = [];
  AbortableEphemeralSessionWebSocket.aborts = [];
  (globalThis as any).WebSocket = AbortableEphemeralSessionWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token", persistSession: false } });
  await run.abort("user_cancelled");
  assert.deepEqual(AbortableEphemeralSessionWebSocket.aborts, [{ sessionKey: "s1", reason: "user_cancelled" }]);
  assert.deepEqual(AbortableEphemeralSessionWebSocket.deletes, [{ sessionKey: "s1" }]);
  assert.deepEqual(await run.result(), { status: "aborted", reason: "user_cancelled" });
});

test("persistSession=false rejects mutation of an existing session", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  const run = query({
    prompt: "hello",
    options: { gatewayUrl: "ws://fake", authToken: "token", sessionId: "existing", persistSession: false },
  });
  await assert.rejects(() => run.next(), { code: "validation_error" });
});

class SettingsWebSocket extends FakeWebSocket {
  static calls: Array<Record<string, unknown>> = [];

  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "update_settings") {
      SettingsWebSocket.calls.push(frame.params);
      (this as any).emit("message", {
        data: JSON.stringify({
          type: "response", id: frame.id, ok: true,
          result: { applied: ["agent.maxContextTokens"], cleared: [], changedPaths: ["agent.maxContextTokens"] },
        }),
      });
      return;
    }
    super.send(raw);
  }
}

test("updateSettings sends an allowlisted local-settings request to the Gateway host", async () => {
  SettingsWebSocket.calls = [];
  (globalThis as any).WebSocket = SettingsWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token" } });
  await run.updateSettings("localSettings", {
    agent: { maxContextTokens: 4096, subagents: { default: "test/test", timeoutMs: 3000, maxDepth: 2 } },
    extension: { builtinPluginsEnabled: { core: true } },
    tools: { webSearch: { enabled: false } },
  });
  assert.deepEqual(SettingsWebSocket.calls, [{
    source: "localSettings",
    settings: {
      agent: { maxContextTokens: 4096, subagents: { default: "test/test", timeoutMs: 3000, maxDepth: 2 } },
      extension: { builtinPluginsEnabled: { core: true } },
      tools: { webSearch: { enabled: false } },
    },
  }]);
  await assert.rejects(
    () => run.updateSettings("not-local" as "localSettings", {}),
    { code: "validation_error" },
  );
  run.close();
});

class ResolveSettingsWebSocket extends FakeWebSocket {
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "resolve_settings") {
      (this as any).emit("message", {
        data: JSON.stringify({
          type: "response", id: frame.id, ok: true,
          result: {
            schemaVersion: 1, version: 4, loadedAt: "2026-09-09T00:00:00.000Z", contentHash: "abc",
            config: { model: { providers: { test: { apiKey: "<redacted>" } } } }, sources: [], diagnostics: [],
          },
        }),
      });
      return;
    }
    super.send(raw);
  }
}

test("resolveSettings reads the redacted Gateway-hosted settings snapshot", async () => {
  (globalThis as any).WebSocket = ResolveSettingsWebSocket;
  assert.deepEqual(await resolveSettings({ gatewayUrl: "ws://fake", authToken: "token" }), {
    schemaVersion: 1, version: 4, loadedAt: "2026-09-09T00:00:00.000Z", contentHash: "abc",
    config: { model: { providers: { test: { apiKey: "<redacted>" } } } }, sources: [], diagnostics: [],
  });
});

test("SDK hook endpoint authenticates callbacks and returns native HookRuntime output", async () => {
  let callbackInput: unknown;
  const hooks = new HostedHookServer({
    UserPromptSubmit: [{
      hooks: [(input, _toolUseId, context) => {
        callbackInput = { input, aborted: context.signal.aborted };
        return {
          continue: false,
          reason: "Policy blocked the prompt.",
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: "This must not reach the model.",
          },
        };
      }],
    }],
  });
  const endpoint = await hooks.start();
  try {
    const payload = {
      hookEventName: "UserPromptSubmit",
      sessionId: "session-1",
      transcriptPath: "",
      cwd: "/workspace",
      prompt: "deploy this",
    };
    const unauthorized = await fetch(`${endpoint.url}?event=UserPromptSubmit&matcher=0`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(unauthorized.status, 401);
    const response = await fetch(`${endpoint.url}?event=UserPromptSubmit&matcher=0`, {
      method: "POST",
      headers: { "content-type": "application/json", ...endpoint.headers },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      continue: false,
      reason: "Policy blocked the prompt.",
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "This must not reach the model.",
      },
    });
    assert.equal((callbackInput as any).aborted, false);
    assert.equal((callbackInput as any).input.prompt, "deploy this");
    assert.equal((callbackInput as any).input.hook_event_name, "UserPromptSubmit");
    assert.equal((callbackInput as any).input.session_id, "session-1");
  } finally {
    await hooks.close();
  }
});

test("SDK hook bridge rejects compatibility hook names without a per-query Gateway lifecycle", () => {
  for (const event of ["Notification", "CwdChanged", "WorktreeCreate", "WorktreeRemove"] as const) {
    assert.throws(
      () => new HostedHookServer({
        [event]: [{ hooks: [() => ({})] }],
      }),
      {
        code: "unsupported_capability",
        message: new RegExp(`hooks\\.${event} is unsupported`),
      },
    );
  }
});

test("SDK hook bridge maps Claude defer and returns an invocation id for deferred delivery", async () => {
  let callbackInvocationId: string | undefined;
  const hooks = new HostedHookServer({
    PreToolUse: [{
      hooks: [() => ({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "defer",
        },
      })],
    }],
    UserPromptSubmit: [{ hooks: [(_input, _toolUseId, options) => {
      callbackInvocationId = options.asyncHookId;
      return { async: true, asyncTimeout: 12 };
    }] }],
  });
  const endpoint = await hooks.start();
  const base = { sessionId: "session-1", transcriptPath: "", cwd: "/workspace" };
  try {
    const deferred = await fetch(`${endpoint.url}?event=PreToolUse&matcher=0`, {
      method: "POST",
      headers: { "content-type": "application/json", ...endpoint.headers },
      body: JSON.stringify({ ...base, hookEventName: "PreToolUse", toolName: "bash", toolInput: {}, toolUseId: "tool-1" }),
    });
    assert.equal(deferred.status, 200);
    assert.deepEqual(await deferred.json(), {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "passthrough" },
    });
    const asyncOutput = await fetch(`${endpoint.url}?event=UserPromptSubmit&matcher=0`, {
      method: "POST",
      headers: { "content-type": "application/json", ...endpoint.headers },
      body: JSON.stringify({ ...base, hookEventName: "UserPromptSubmit", prompt: "hello" }),
    });
    assert.equal(asyncOutput.status, 200);
    const body = await asyncOutput.json() as { async?: boolean; asyncHookId?: string; asyncTimeout?: number };
    assert.deepEqual(body, {
      async: true,
      asyncHookId: callbackInvocationId,
      asyncTimeout: 12,
    });
    assert.equal(typeof callbackInvocationId, "string");
  } finally {
    await hooks.close();
  }
});

class AsyncHookResultWebSocket extends FakeWebSocket {
  static requests: Array<{ method: string; params: Record<string, unknown> }> = [];

  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.type === "hello") {
      (this as any).emit("message", {
        data: JSON.stringify({
          type: "hello_ok",
          protocolVersion: "1.1",
          serverVersion: "test",
          serverInfo: { mode: "remote", capabilities: ["async_hook_result"] },
        }),
      });
      return;
    }
    if (frame.method === "submit_turn") {
      (this as any).emit("message", {
        data: JSON.stringify({
          type: "event",
          id: frame.id,
          seq: 0,
          final: false,
          event: { type: "turn_started", runId: "async-hook-run" },
        }),
      });
      return;
    }
    if (frame.method === "hook_async_result") {
      AsyncHookResultWebSocket.requests.push({ method: frame.method, params: frame.params });
      (this as any).emit("message", {
        data: JSON.stringify({
          type: "response",
          id: frame.id,
          ok: true,
          result: { invocationId: frame.params.invocationId, status: "delivered" },
        }),
      });
      return;
    }
    super.send(raw);
  }
}

test("Query submits a deferred hook result through the Gateway-owned registry", async () => {
  AsyncHookResultWebSocket.requests = [];
  (globalThis as any).WebSocket = AsyncHookResultWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token" } });
  await run.next();
  assert.deepEqual(await run.submitAsyncHookResult("hook-invocation-1", {
    async: false,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "Review the deployment policy.",
    },
  }), { invocationId: "hook-invocation-1", status: "delivered" });
  assert.deepEqual(AsyncHookResultWebSocket.requests, [{
    method: "hook_async_result",
    params: {
      sessionKey: "s1",
      invocationId: "hook-invocation-1",
      output: {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "Review the deployment policy.",
        },
      },
    },
  }]);
  run.close();
});

class FakeMcpControlWebSocket extends FakeWebSocket {
  static requests: Array<{ method: string; params: any }> = [];
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "reload_extensions") {
      FakeMcpControlWebSocket.requests.push(frame);
      this.emitForTest({ type: "response", id: frame.id, ok: true, result: { reloaded: true, changedPaths: frame.params.changedPaths ?? [] } });
      return;
    }
    if (["set_mcp_servers", "mcp_server_reconnect", "mcp_server_toggle", "set_mcp_permission_mode_override", "output_styles_list", "set_output_style", "reload_output_styles"].includes(frame.method)) {
      FakeMcpControlWebSocket.requests.push(frame);
      this.emitForTest({
        type: "response",
        id: frame.id,
        ok: true,
      result: frame.method === "output_styles_list" ? { styles: [{ name: "concise", description: "Short answers", source: "project" }] }
        : frame.method === "set_output_style" ? { applied: true, selected: frame.params.name }
        : frame.method === "reload_output_styles" ? { reloaded: true, changed: ["project:concise"] }
        : frame.method === "set_mcp_servers" ? { added: ["tickets"], removed: [], errors: [] }
        : frame.method === "set_mcp_permission_mode_override" ? { warning: "conservative" }
        : { ok: true },
      });
      return;
    }
    super.send(raw);
  }
  emitForTest(frame: unknown): void { (this as any).emit("message", { data: JSON.stringify(frame) }); }
}

class FakeSeedReadStateWebSocket extends FakeWebSocket {
  static requests: Array<{ method: string; params: any }> = [];
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "seed_read_state") {
      FakeSeedReadStateWebSocket.requests.push(frame);
      this.emitForTest({ type: "response", id: frame.id, ok: true, result: { applied: true } });
      return;
    }
    super.send(raw);
  }
  emitForTest(frame: unknown): void { (this as any).emit("message", { data: JSON.stringify(frame) }); }
}

test("seedReadState delegates a completed query's observed file state to the Gateway", async () => {
  FakeSeedReadStateWebSocket.requests = [];
  (globalThis as any).WebSocket = FakeSeedReadStateWebSocket;
  const run = query({
    prompt: "hello",
    options: { gatewayUrl: "ws://fake", authToken: "token", projectKey: "/workspace/project", cwd: "/workspace/project" },
  });
  for await (const _event of run) { /* wait for the terminal Gateway result */ }
  await run.seedReadState("src/index.ts", 1_725_000_000_123);
  assert.deepEqual(FakeSeedReadStateWebSocket.requests.map(({ method, params }) => ({ method, params })), [{
    method: "seed_read_state",
    params: {
      sessionKey: "s1",
      projectKey: "/workspace/project",
      channelKey: "api_server",
      workspaceCwd: "/workspace/project",
      path: "src/index.ts",
      mtime: 1_725_000_000_123,
    },
  }]);
  run.close();
});

test("query configures stdio, Claude HTTP alias, and legacy SSE MCP servers before the submitted turn", async () => {
  FakeMcpControlWebSocket.requests = [];
  (globalThis as any).WebSocket = FakeMcpControlWebSocket;
  const run = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      mcpServers: {
        tickets: { type: "stdio", command: "ticket-mcp", args: ["--stdio"] },
        compat_http: { type: "http", url: "https://tickets.example/mcp" },
        legacy_sse: { type: "sse", url: "https://tickets.example/events", headers: { authorization: "Bearer legacy" } },
      },
    },
  });
  for await (const _event of run) { /* consume */ }
  assert.deepEqual(FakeMcpControlWebSocket.requests.map((request) => request.method), ["set_mcp_servers"]);
  assert.deepEqual(FakeMcpControlWebSocket.requests[0]?.params.servers, {
    tickets: { type: "stdio", command: "ticket-mcp", args: ["--stdio"] },
    compat_http: { type: "streamable_http", url: "https://tickets.example/mcp" },
    legacy_sse: { type: "sse", url: "https://tickets.example/events", headers: { authorization: "Bearer legacy" } },
  });
});

test("createSdkMcpServer hosts SDK tool handlers through standard MCP", async () => {
  const server = createSdkMcpServer({
    name: "tickets",
    instructions: "Use ticket tools for read-only lookup.",
    timeout: 100,
    tools: [tool(
      "find_ticket",
      "Find a ticket by id.",
      { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      async (input) => ({ content: [{ type: "text", text: `ticket:${(input as { id: string }).id}` }] }),
    )],
  });
  const endpoint = await server.start();
  const client = new Client({ name: "sdk-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url));
  try {
    await client.connect(transport);
    assert.equal(client.getInstructions(), "Use ticket tools for read-only lookup.");
    assert.equal(endpoint.timeout, 100);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((item) => item.name), ["find_ticket"]);
    assert.deepEqual(tools.tools[0]?.inputSchema, {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    });
    const result = await client.callTool({ name: "find_ticket", arguments: { id: "PDX-123" } });
    assert.deepEqual(result.content, [{ type: "text", text: "ticket:PDX-123" }]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("SDK MCP server aborts a handler after its configured timeout", async () => {
  const server = createSdkMcpServer({
    name: "slow-tools",
    timeout: 10,
    tools: [tool(
      "slow",
      "A deliberately slow tool.",
      { type: "object" },
      async (_input, { signal }) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        return { content: [{ type: "text", text: signal.aborted ? "aborted" : "late" }] };
      },
    )],
  });
  const endpoint = await server.start();
  const client = new Client({ name: "sdk-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url));
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "slow", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(String(((result as any).content?.[0] as any)?.text), /timed out/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test("SDK MCP alwaysLoad describes eager and deferred hosted tools", async () => {
  const eager = createSdkMcpServer({
    name: "eager-tools",
    alwaysLoad: true,
    tools: [tool("ping", "Ping.", { type: "object" }, async () => ({ content: [{ type: "text", text: "pong" }] }))],
  });
  assert.equal(eager.alwaysLoad, true);
  assert.equal(eager.tools[0]?.extras?.alwaysLoad, true);
  const deferred = createSdkMcpServer({
    name: "deferred-tools",
    alwaysLoad: false,
    tools: [
      tool("searchable", "Searchable tool.", { type: "object" }, async () => ({ content: [] }), { searchHint: "find searchable work" }),
      tool("eager-override", "Eager override.", { type: "object" }, async () => ({ content: [] }), { alwaysLoad: true }),
    ],
  });
  assert.equal(deferred.alwaysLoad, false);
  assert.deepEqual(deferred.deferredTools, [{ name: "searchable", searchHint: "find searchable work" }]);
});

test("query exposes dynamic MCP controls with Claude HTTP alias and legacy SSE", async () => {
  FakeMcpControlWebSocket.requests = [];
  (globalThis as any).WebSocket = FakeMcpControlWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token" } });
  await run.next();
  await run.setMcpServers({
    tickets: { type: "streamable_http", url: "https://tickets.example/mcp" },
    compat_http: { type: "http", url: "https://compat.example/mcp" },
    legacy_sse: { type: "sse", url: "https://legacy.example/events" },
    deferred: {
      type: "streamable_http",
      url: "https://deferred.example/mcp",
      deferredTools: [{ name: "search", searchHint: "search a deferred catalog" }],
    },
  });
  await run.reconnectMcpServer("tickets");
  await run.toggleMcpServer("tickets", false);
  assert.deepEqual(await run.setMcpPermissionModeOverride("tickets", "auto"), { warning: "conservative" });
  assert.deepEqual(FakeMcpControlWebSocket.requests.map((request) => request.method), [
    "set_mcp_servers",
    "mcp_server_reconnect",
    "mcp_server_toggle",
    "set_mcp_permission_mode_override",
  ]);
  assert.deepEqual(FakeMcpControlWebSocket.requests[0]?.params.servers, {
    tickets: { type: "streamable_http", url: "https://tickets.example/mcp" },
    compat_http: { type: "streamable_http", url: "https://compat.example/mcp" },
    legacy_sse: { type: "sse", url: "https://legacy.example/events" },
    deferred: {
      type: "streamable_http",
      url: "https://deferred.example/mcp",
      deferredTools: [{ name: "search", searchHint: "search a deferred catalog" }],
    },
  });
  run.close();
});

test("query serializes deferred metadata from an SDK-hosted MCP server", async () => {
  FakeMcpControlWebSocket.requests = [];
  (globalThis as any).WebSocket = FakeMcpControlWebSocket;
  const server = createSdkMcpServer({
    name: "hosted-deferred-tools",
    alwaysLoad: false,
    tools: [tool(
      "lookup",
      "Look up deferred data.",
      { type: "object" },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      { searchHint: "lookup deferred data" },
    )],
  });
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://127.0.0.1", authToken: "token" } });
  try {
    await run.next();
    await run.setMcpServers({ hosted: server });
    const request = FakeMcpControlWebSocket.requests.find((entry) => entry.method === "set_mcp_servers");
    assert.deepEqual((request?.params as any).servers.hosted.deferredTools, [{
      name: "lookup",
      searchHint: "lookup deferred data",
    }]);
  } finally {
    run.close();
    await server.close();
  }
});

test("query exposes output-style list, selection, and independent reload controls", async () => {
  FakeMcpControlWebSocket.requests = [];
  (globalThis as any).WebSocket = FakeMcpControlWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token" } });
  await run.next();
  assert.deepEqual(await run.outputStyles(), [{ name: "concise", description: "Short answers", source: "project" }]);
  assert.deepEqual(await run.setOutputStyle("concise"), { applied: true, selected: "concise" });
  assert.deepEqual(await run.reloadOutputStyles(), { reloaded: true, changed: ["project:concise"] });
  assert.deepEqual(FakeMcpControlWebSocket.requests.map((request) => request.method), ["output_styles_list", "set_output_style", "reload_output_styles"]);
  run.close();
});

class FakeNoFinalWebSocket extends FakeWebSocket {
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "submit_turn") {
      this.emitForTest({ type: "event", id: frame.id, seq: 0, final: false, event: { type: "turn_started", runId: "r2" } });
      this.emitForTest({ type: "event", id: frame.id, seq: 1, final: true, event: { type: "assistant_text_delta", text: "partial" } });
      return;
    }
    super.send(raw);
  }
  emitForTest(frame: unknown): void {
    (this as any).emit("message", { data: JSON.stringify(frame) });
  }
}

test("query reports result_unknown when the gateway stream has no terminal frame", async () => {
  (globalThis as any).WebSocket = FakeNoFinalWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token" } });
  await run.next();
  await run.next();
  const result = await run.result();
  assert.equal(result.status, "result_unknown");
});

class FakeInteractiveWebSocket extends FakeWebSocket {
  static decisions: unknown[] = [];
  static submits: unknown[] = [];
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "submit_turn") {
      FakeInteractiveWebSocket.submits.push(frame.params);
      const events = [
        { type: "turn_started", runId: "r3" },
        { type: "permission_request", requestId: "p1", toolName: "bash", payload: { command: "pwd" } },
        { type: "elicitation_request", requestId: "e1", toolCallId: "t1", toolName: "ask_user_question", questions: [{ question: "Continue?", header: "Choice", options: [] }] },
        { type: "turn_completed", usage: {}, finishReason: "stop" },
      ];
      events.forEach((event, seq) => this.emitForTest({ type: "event", id: frame.id, seq, final: seq === events.length - 1, event }));
      return;
    }
    if (frame.method === "permission_decide" || frame.method === "elicitation_respond") {
      FakeInteractiveWebSocket.decisions.push({ method: frame.method, params: frame.params });
      this.emitForTest({ type: "response", id: frame.id, ok: true, result: { delivered: true } });
      return;
    }
    super.send(raw);
  }
  emitForTest(frame: unknown): void { (this as any).emit("message", { data: JSON.stringify(frame) }); }
}

test("query round-trips permission and elicitation callbacks", async () => {
  FakeInteractiveWebSocket.decisions = [];
  FakeInteractiveWebSocket.submits = [];
  (globalThis as any).WebSocket = FakeInteractiveWebSocket;
  const run = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      canUseTool: () => ({ behavior: "allow", remember: true }),
      onElicitation: () => ({ action: "accept", content: { answers: { "Continue?": "yes" } } }),
    },
  });
  for await (const _event of run) { /* consume */ }
  assert.deepEqual(FakeInteractiveWebSocket.decisions.map((item: any) => item.method), ["permission_decide", "elicitation_respond"]);
  assert.equal((FakeInteractiveWebSocket.decisions[0] as any).params.decision, "allow");
  assert.equal((FakeInteractiveWebSocket.decisions[1] as any).params.answer.type, "answered");
});

test("query enables native elicitation without enabling permission prompts", async () => {
  FakeInteractiveWebSocket.decisions = [];
  FakeInteractiveWebSocket.submits = [];
  (globalThis as any).WebSocket = FakeInteractiveWebSocket;
  const run = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      onElicitation: () => ({ action: "accept", content: { answers: { "Continue?": "yes" } } }),
    },
  });
  for await (const _event of run) { /* consume */ }

  assert.deepEqual(FakeInteractiveWebSocket.submits, [{
    sessionKey: "s1",
    channelKey: "api_server",
    message: "hello",
    canPrompt: false,
    canElicit: true,
  }]);
  assert.deepEqual(FakeInteractiveWebSocket.decisions.map((item: any) => item.method), ["elicitation_respond"]);
});

test("query adapts the native elicitation lifecycle to onUserDialog", async () => {
  FakeInteractiveWebSocket.decisions = [];
  FakeInteractiveWebSocket.submits = [];
  (globalThis as any).WebSocket = FakeInteractiveWebSocket;
  let dialog: any;
  const run = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      supportedDialogKinds: ["elicitation"],
      canUseTool: () => ({ behavior: "allow" }),
      onUserDialog: (request) => {
        dialog = request;
        return { behavior: "answered", value: { answers: { "Continue?": "yes" } } };
      },
    },
  });
  for await (const _event of run) { /* consume */ }

  assert.equal((FakeInteractiveWebSocket.submits[0] as any).canElicit, true);

  assert.deepEqual(dialog, {
    requestId: "e1",
    dialogKind: "elicitation",
    payload: {
      sessionId: "s1",
      runId: "r3",
      toolCallId: "t1",
      toolName: "ask_user_question",
      questions: [{ question: "Continue?", header: "Choice", options: [] }],
      metadata: {},
    },
  });
  assert.deepEqual(FakeInteractiveWebSocket.decisions, [
    {
      method: "permission_decide",
      params: { sessionKey: "s1", requestId: "p1", decision: "allow" },
    },
    {
      method: "elicitation_respond",
      params: {
        sessionKey: "s1",
        requestId: "e1",
        answer: { type: "answered", answers: { "Continue?": "yes" } },
      },
    },
  ]);
});

class FakeInputDialogWebSocket extends FakeWebSocket {
  static submits: unknown[] = [];
  static responses: unknown[] = [];

  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "submit_turn") {
      FakeInputDialogWebSocket.submits.push(frame.params);
      const events = [
        { type: "turn_started", runId: "r-input" },
        {
          type: "user_dialog_request",
          requestId: "input-1",
          dialogKind: "input",
          toolCallId: "tool-input-1",
          toolName: "request_user_input",
          prompt: "Which test command should I run?",
          placeholder: "pnpm test",
        },
        { type: "turn_completed", usage: {}, finishReason: "stop" },
      ];
      events.forEach((event, seq) => this.emitForTest({
        type: "event",
        id: frame.id,
        seq,
        final: seq === events.length - 1,
        event,
      }));
      return;
    }
    if (frame.method === "user_dialog_respond") {
      FakeInputDialogWebSocket.responses.push(frame.params);
      this.emitForTest({ type: "response", id: frame.id, ok: true, result: { delivered: true } });
      return;
    }
    super.send(raw);
  }

  emitForTest(frame: unknown): void {
    (this as any).emit("message", { data: JSON.stringify(frame) });
  }
}

class FakeRestartedDialogWebSocket extends FakeWebSocket {
  static requests: Array<{ method: string; params: unknown }> = [];

  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "user_dialog_list") {
      FakeRestartedDialogWebSocket.requests.push({ method: frame.method, params: frame.params });
      this.emitForTest({
        type: "response",
        id: frame.id,
        ok: true,
        result: {
          dialogs: [{
            type: "user_dialog_terminated",
            reason: "gateway_restarted",
            terminatedAt: "2026-09-10T00:00:00.000Z",
            recovery: "next_turn_context",
            request: {
              type: "user_dialog_request",
              requestId: "restarted-input-1",
              dialogKind: "input",
              toolCallId: "tool-input-1",
              toolName: "request_user_input",
              prompt: "Which test command should I run?",
              placeholder: "pnpm test",
            },
          }],
        },
      });
      return;
    }
    if (frame.method === "user_dialog_respond") {
      FakeRestartedDialogWebSocket.requests.push({ method: frame.method, params: frame.params });
      this.emitForTest({
        type: "response",
        id: frame.id,
        ok: true,
        result: { delivered: true, recovered: true, reason: "gateway_restarted" },
      });
      return;
    }
    super.send(raw);
  }

  emitForTest(frame: unknown): void {
    (this as any).emit("message", { data: JSON.stringify(frame) });
  }
}

class FakeDialogLeaseWebSocket extends FakeWebSocket {
  static requests: Array<{ method: string; params: unknown }> = [];

  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "user_dialog_list") {
      FakeDialogLeaseWebSocket.requests.push({ method: frame.method, params: frame.params });
      this.emitForTest({
        type: "response",
        id: frame.id,
        ok: true,
        result: {
          dialogs: [{
            type: "user_dialog_request",
            requestId: "leased-input-1",
            dialogKind: "input",
            toolCallId: "tool-input-1",
            toolName: "request_user_input",
            prompt: "Which test command should I run?",
            lease: { expiresAt: "2026-09-11T00:00:30.000Z" },
          }],
        },
      });
      return;
    }
    if (frame.method === "user_dialog_claim") {
      FakeDialogLeaseWebSocket.requests.push({ method: frame.method, params: frame.params });
      this.emitForTest({
        type: "response",
        id: frame.id,
        ok: true,
        result: { claimed: true, leaseId: "lease-1", expiresAt: "2026-09-11T00:00:30.000Z" },
      });
      return;
    }
    if (frame.method === "user_dialog_release") {
      FakeDialogLeaseWebSocket.requests.push({ method: frame.method, params: frame.params });
      this.emitForTest({ type: "response", id: frame.id, ok: true, result: { released: true } });
      return;
    }
    if (frame.method === "user_dialog_respond") {
      FakeDialogLeaseWebSocket.requests.push({ method: frame.method, params: frame.params });
      this.emitForTest({ type: "response", id: frame.id, ok: true, result: { delivered: true } });
      return;
    }
    super.send(raw);
  }

  emitForTest(frame: unknown): void {
    (this as any).emit("message", { data: JSON.stringify(frame) });
  }
}

class FakeSelectAndConfirmDialogWebSocket extends FakeWebSocket {
  static submits: unknown[] = [];
  static responses: unknown[] = [];

  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "submit_turn") {
      FakeSelectAndConfirmDialogWebSocket.submits.push(frame.params);
      const events = [
        { type: "turn_started", runId: "r-choice" },
        {
          type: "user_dialog_request",
          requestId: "select-1",
          dialogKind: "select",
          toolCallId: "tool-select-1",
          toolName: "request_user_choice",
          prompt: "Choose a test command.",
          choices: [
            { value: "unit", label: "Unit", description: "Run unit tests" },
            { value: "e2e", label: "E2E" },
          ],
          defaultValue: "unit",
        },
        {
          type: "user_dialog_request",
          requestId: "confirm-1",
          dialogKind: "confirm",
          toolCallId: "tool-confirm-1",
          toolName: "request_user_confirmation",
          prompt: "Run the selected command now?",
          confirmLabel: "Run",
          cancelLabel: "Skip",
          defaultValue: false,
        },
        { type: "turn_completed", usage: {}, finishReason: "stop" },
      ];
      events.forEach((event, seq) => this.emitForTest({
        type: "event",
        id: frame.id,
        seq,
        final: seq === events.length - 1,
        event,
      }));
      return;
    }
    if (frame.method === "user_dialog_respond") {
      FakeSelectAndConfirmDialogWebSocket.responses.push(frame.params);
      this.emitForTest({ type: "response", id: frame.id, ok: true, result: { delivered: true } });
      return;
    }
    super.send(raw);
  }

  emitForTest(frame: unknown): void {
    (this as any).emit("message", { data: JSON.stringify(frame) });
  }
}

class FakeFormDialogWebSocket extends FakeWebSocket {
  static submits: unknown[] = [];
  static responses: unknown[] = [];

  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "submit_turn") {
      FakeFormDialogWebSocket.submits.push(frame.params);
      const events = [
        { type: "turn_started", runId: "r-form" },
        {
          type: "user_dialog_request",
          requestId: "form-1",
          dialogKind: "form",
          toolCallId: "tool-form-1",
          toolName: "request_user_form",
          prompt: "Configure the SDK test run.",
          schema: {
            type: "object",
            properties: {
              suite: { type: "string", enum: ["unit", "e2e"] },
              retries: { type: "integer" },
            },
            required: ["suite"],
            additionalProperties: false,
          },
        },
        { type: "turn_completed", usage: {}, finishReason: "stop" },
      ];
      events.forEach((event, seq) => this.emitForTest({
        type: "event",
        id: frame.id,
        seq,
        final: seq === events.length - 1,
        event,
      }));
      return;
    }
    if (frame.method === "user_dialog_respond") {
      FakeFormDialogWebSocket.responses.push(frame.params);
      this.emitForTest({ type: "response", id: frame.id, ok: true, result: { delivered: true } });
      return;
    }
    super.send(raw);
  }

  emitForTest(frame: unknown): void {
    (this as any).emit("message", { data: JSON.stringify(frame) });
  }
}

test("query opt-in input dialog exposes a public event and answers through Gateway", async () => {
  FakeInputDialogWebSocket.submits = [];
  FakeInputDialogWebSocket.responses = [];
  (globalThis as any).WebSocket = FakeInputDialogWebSocket;
  let dialog: any;
  const run = query({
    prompt: "help me run a test",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      supportedDialogKinds: ["input"],
      onUserDialog: (request) => {
        dialog = request;
        return { behavior: "answered", value: "pnpm test" };
      },
    },
  });

  const events: string[] = [];
  for await (const event of run) events.push(event.type);

  assert.deepEqual((FakeInputDialogWebSocket.submits[0] as any).sdkSessionConfig, {
    userDialogKinds: ["input"],
  });
  assert.deepEqual(dialog, {
    requestId: "input-1",
    dialogKind: "input",
    payload: {
      sessionId: "s1",
      toolCallId: "tool-input-1",
      toolName: "request_user_input",
      prompt: "Which test command should I run?",
      placeholder: "pnpm test",
    },
  });
  assert.equal(events.includes("user_dialog.requested"), true);
  assert.deepEqual(FakeInputDialogWebSocket.responses, [{
    sessionKey: "s1",
    requestId: "input-1",
    result: { behavior: "answered", value: "pnpm test" },
  }]);
});

test("query manual dialog mode leaves the Gateway request pending for an explicit response", async () => {
  FakeInputDialogWebSocket.submits = [];
  FakeInputDialogWebSocket.responses = [];
  (globalThis as any).WebSocket = FakeInputDialogWebSocket;
  const run = query({
    prompt: "help me run a test",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      supportedDialogKinds: ["input"],
      userDialogMode: "manual",
    },
  });

  let requestId: string | undefined;
  for await (const event of run) {
    if (event.type !== "user_dialog.requested") continue;
    requestId = String(event.requestId);
    assert.equal(await run.respondUserDialog(requestId, { behavior: "answered", value: "pnpm test" }).then((result) => result.delivered), true);
  }

  assert.equal(requestId, "input-1");
  assert.deepEqual((FakeInputDialogWebSocket.submits[0] as any).sdkSessionConfig, {
    userDialogKinds: ["input"],
  });
  assert.deepEqual(FakeInputDialogWebSocket.responses, [{
    sessionKey: "s1",
    requestId: "input-1",
    result: { behavior: "answered", value: "pnpm test" },
  }]);
});

test("client projects restart-terminated dialogs and exposes the persisted recovery receipt", async () => {
  FakeRestartedDialogWebSocket.requests = [];
  (globalThis as any).WebSocket = FakeRestartedDialogWebSocket;
  const client = createPilotDeckClient({ gatewayUrl: "ws://fake", authToken: "token", projectKey: "project" });
  try {
    assert.deepEqual(await client.dialogs.list({ sessionId: "s1" }), [{
      type: "user_dialog_terminated",
      reason: "gateway_restarted",
      terminatedAt: "2026-09-10T00:00:00.000Z",
      recovery: "next_turn_context",
      request: {
        requestId: "restarted-input-1",
        dialogKind: "input",
        payload: {
          sessionId: "s1",
          toolCallId: "tool-input-1",
          toolName: "request_user_input",
          prompt: "Which test command should I run?",
          placeholder: "pnpm test",
        },
      },
    }]);
    assert.deepEqual(await client.dialogs.respond({
      sessionId: "s1",
      requestId: "restarted-input-1",
      result: { behavior: "cancelled", reason: "renderer observed restart" },
    }), { delivered: true, recovered: true, reason: "gateway_restarted" });
    assert.deepEqual(FakeRestartedDialogWebSocket.requests, [
      { method: "user_dialog_list", params: { sessionKey: "s1", projectKey: "project" } },
      {
        method: "user_dialog_respond",
        params: {
          sessionKey: "s1",
          projectKey: "project",
          requestId: "restarted-input-1",
          result: { behavior: "cancelled", reason: "renderer observed restart" },
        },
      },
    ]);
  } finally {
    await client.close();
  }
});

test("client projects and serializes live user-dialog renderer leases", async () => {
  FakeDialogLeaseWebSocket.requests = [];
  (globalThis as any).WebSocket = FakeDialogLeaseWebSocket;
  const client = createPilotDeckClient({ gatewayUrl: "ws://fake", authToken: "token", projectKey: "project" });
  try {
    assert.deepEqual(await client.dialogs.list({ sessionId: "s1" }), [{
      requestId: "leased-input-1",
      dialogKind: "input",
      payload: {
        sessionId: "s1",
        toolCallId: "tool-input-1",
        toolName: "request_user_input",
        prompt: "Which test command should I run?",
      },
      lease: { expiresAt: "2026-09-11T00:00:30.000Z" },
    }]);
    assert.deepEqual(await client.dialogs.claim({
      sessionId: "s1",
      requestId: "leased-input-1",
      ttlMs: 10_000,
    }), { claimed: true, leaseId: "lease-1", expiresAt: "2026-09-11T00:00:30.000Z" });
    assert.deepEqual(await client.dialogs.release({
      sessionId: "s1",
      requestId: "leased-input-1",
      leaseId: "lease-1",
    }), { released: true });
    assert.deepEqual(await client.dialogs.respond({
      sessionId: "s1",
      requestId: "leased-input-1",
      leaseId: "lease-1",
      result: { behavior: "answered", value: "pnpm test" },
    }), { delivered: true });
    assert.deepEqual(FakeDialogLeaseWebSocket.requests, [
      { method: "user_dialog_list", params: { sessionKey: "s1", projectKey: "project" } },
      {
        method: "user_dialog_claim",
        params: { sessionKey: "s1", projectKey: "project", requestId: "leased-input-1", ttlMs: 10_000 },
      },
      {
        method: "user_dialog_release",
        params: { sessionKey: "s1", projectKey: "project", requestId: "leased-input-1", leaseId: "lease-1" },
      },
      {
        method: "user_dialog_respond",
        params: {
          sessionKey: "s1",
          projectKey: "project",
          requestId: "leased-input-1",
          leaseId: "lease-1",
          result: { behavior: "answered", value: "pnpm test" },
        },
      },
    ]);
  } finally {
    await client.close();
  }
});

test("Query responds to a restart-terminated dialog in its configured project", async () => {
  FakeRestartedDialogWebSocket.requests = [];
  (globalThis as any).WebSocket = FakeRestartedDialogWebSocket;
  const run = query({
    prompt: "continue the session",
    options: { gatewayUrl: "ws://fake", authToken: "token", projectKey: "project" },
  });
  try {
    await run.next();
    assert.deepEqual(await run.respondUserDialog("restarted-input-1", {
      behavior: "cancelled",
      reason: "renderer observed restart",
    }), { delivered: true, recovered: true, reason: "gateway_restarted" });
    assert.deepEqual(FakeRestartedDialogWebSocket.requests, [{
      method: "user_dialog_respond",
      params: {
        sessionKey: "s1",
        projectKey: "project",
        requestId: "restarted-input-1",
        result: { behavior: "cancelled", reason: "renderer observed restart" },
      },
    }]);
  } finally {
    run.close();
  }
});

test("query rejects native elicitation in manual generic dialog mode", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  const run = query({
    prompt: "ask a native elicitation question",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      supportedDialogKinds: ["elicitation"],
      userDialogMode: "manual",
    },
  });
  await assert.rejects(() => run.next(), (error: unknown) =>
    (error as any)?.code === "validation_error"
      && /native elicitation/.test((error as Error).message),
  );
});

test("query projects opt-in select and confirm dialogs with typed answers", async () => {
  FakeSelectAndConfirmDialogWebSocket.submits = [];
  FakeSelectAndConfirmDialogWebSocket.responses = [];
  (globalThis as any).WebSocket = FakeSelectAndConfirmDialogWebSocket;
  const dialogs: any[] = [];
  const run = query({
    prompt: "choose and confirm",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      supportedDialogKinds: ["select", "confirm"],
      onUserDialog: (request) => {
        dialogs.push(request);
        return request.dialogKind === "select"
          ? { behavior: "answered", value: "e2e" }
          : { behavior: "answered", value: true };
      },
    },
  });

  for await (const _event of run) { /* consume */ }

  assert.deepEqual((FakeSelectAndConfirmDialogWebSocket.submits[0] as any).sdkSessionConfig, {
    userDialogKinds: ["select", "confirm"],
  });
  assert.deepEqual(dialogs, [
    {
      requestId: "select-1",
      dialogKind: "select",
      payload: {
        sessionId: "s1",
        toolCallId: "tool-select-1",
        toolName: "request_user_choice",
        prompt: "Choose a test command.",
        choices: [
          { value: "unit", label: "Unit", description: "Run unit tests" },
          { value: "e2e", label: "E2E" },
        ],
        defaultValue: "unit",
      },
    },
    {
      requestId: "confirm-1",
      dialogKind: "confirm",
      payload: {
        sessionId: "s1",
        toolCallId: "tool-confirm-1",
        toolName: "request_user_confirmation",
        prompt: "Run the selected command now?",
        confirmLabel: "Run",
        cancelLabel: "Skip",
        defaultValue: false,
      },
    },
  ]);
  assert.deepEqual(FakeSelectAndConfirmDialogWebSocket.responses, [
    { sessionKey: "s1", requestId: "select-1", result: { behavior: "answered", value: "e2e" } },
    { sessionKey: "s1", requestId: "confirm-1", result: { behavior: "answered", value: true } },
  ]);
});

test("query projects opt-in schema-backed form dialogs with object answers", async () => {
  FakeFormDialogWebSocket.submits = [];
  FakeFormDialogWebSocket.responses = [];
  (globalThis as any).WebSocket = FakeFormDialogWebSocket;
  let dialog: any;
  const run = query({
    prompt: "configure a test run",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      supportedDialogKinds: ["form"],
      onUserDialog: (request) => {
        dialog = request;
        return { behavior: "answered", value: { suite: "e2e", retries: 2 } };
      },
    },
  });

  for await (const _event of run) { /* consume */ }

  assert.deepEqual((FakeFormDialogWebSocket.submits[0] as any).sdkSessionConfig, {
    userDialogKinds: ["form"],
  });
  assert.deepEqual(dialog, {
    requestId: "form-1",
    dialogKind: "form",
    payload: {
      sessionId: "s1",
      toolCallId: "tool-form-1",
      toolName: "request_user_form",
      prompt: "Configure the SDK test run.",
      schema: {
        type: "object",
        properties: {
          suite: { type: "string", enum: ["unit", "e2e"] },
          retries: { type: "integer" },
        },
        required: ["suite"],
        additionalProperties: false,
      },
    },
  });
  assert.deepEqual(FakeFormDialogWebSocket.responses, [{
    sessionKey: "s1",
    requestId: "form-1",
    result: { behavior: "answered", value: { suite: "e2e", retries: 2 } },
  }]);
});

test("query rejects unsupported generic dialog kinds", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  const run = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      supportedDialogKinds: ["text_input"] as any,
      onUserDialog: () => ({ behavior: "cancelled" }),
    },
  });
  await assert.rejects(() => run.next(), { code: "unsupported_capability" });
});

class FailureWebSocket extends FakeWebSocket {
  constructor(url: string, private readonly closeCode: number, private readonly closeReason: string) {
    super(url);
  }
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.type === "hello") {
      queueMicrotask(() => (this as any).emit("close", { code: this.closeCode, reason: this.closeReason }));
      return;
    }
    super.send(raw);
  }
}

test("transport preserves authentication and protocol errors during hello", async () => {
  (globalThis as any).WebSocket = class extends FailureWebSocket {
    constructor(url: string) { super(url, 4003, "auth_failed"); }
  };
  const auth = new GatewayTransport({ url: "ws://fake", token: "bad", connectTimeoutMs: 100 });
  await assert.rejects(() => auth.connect(), { code: "authentication_error" });

  (globalThis as any).WebSocket = class extends FailureWebSocket {
    constructor(url: string) { super(url, 4001, "protocol_mismatch"); }
  };
  const protocol = new GatewayTransport({ url: "ws://fake", token: "token", connectTimeoutMs: 100 });
  await assert.rejects(() => protocol.connect(), { code: "protocol_version_error" });
});

class RetryWebSocket extends FakeWebSocket {
  static attempts = 0;
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.type === "hello") {
      RetryWebSocket.attempts += 1;
      if (RetryWebSocket.attempts === 1) {
        queueMicrotask(() => (this as any).emit("close", { code: 1006, reason: "network_lost" }));
        return;
      }
    }
    super.send(raw);
  }
}

test("transport retries transient handshake failures with bounded backoff", async () => {
  RetryWebSocket.attempts = 0;
  (globalThis as any).WebSocket = RetryWebSocket;
  const transport = new GatewayTransport({
    url: "ws://fake",
    token: "token",
    reconnect: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, jitter: 0 },
  });
  const info = await transport.connect();
  assert.equal(info.protocolVersion, "1.1");
  assert.equal(RetryWebSocket.attempts, 2);
  transport.close();
});

class OutOfOrderWebSocket extends FakeWebSocket {
  private requests: Array<{ id: string; method: string }> = [];
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.type === "hello") { super.send(raw); return; }
    if (frame.type === "request") {
      this.requests.push({ id: frame.id, method: frame.method });
      if (this.requests.length === 2) {
        for (const request of [...this.requests].reverse()) {
          (this as any).emit("message", { data: JSON.stringify({ type: "response", id: request.id, ok: true, result: request.method }) });
        }
      }
    }
  }
}

test("transport correlates out-of-order responses by request id", async () => {
  (globalThis as any).WebSocket = OutOfOrderWebSocket;
  const transport = new GatewayTransport({ url: "ws://fake", token: "token" });
  await transport.connect();
  const first = transport.request("first", {});
  const second = transport.request("second", {});
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  transport.close();
});

class SequenceGapWebSocket extends FakeWebSocket {
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.type === "hello") { super.send(raw); return; }
    if (frame.method === "submit_turn") {
      (this as any).emit("message", { data: JSON.stringify({ type: "event", id: frame.id, seq: 0, final: false, event: { type: "turn_started" } }) });
      (this as any).emit("message", { data: JSON.stringify({ type: "event", id: frame.id, seq: 2, final: true, event: { type: "turn_completed" } }) });
    }
  }
}

test("transport rejects stream sequence gaps", async () => {
  (globalThis as any).WebSocket = SequenceGapWebSocket;
  const transport = new GatewayTransport({ url: "ws://fake", token: "token" });
  await transport.connect();
  const iterator = transport.stream("submit_turn", {});
  assert.deepEqual((await iterator[Symbol.asyncIterator]().next()).value?.type, "turn_started");
  await assert.rejects(() => iterator[Symbol.asyncIterator]().next(), { code: "validation_error" });
  transport.close();
});

class InvalidSequenceWebSocket extends FakeWebSocket {
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.type === "hello") { super.send(raw); return; }
    if (frame.method === "submit_turn") {
      (this as any).emit("message", { data: JSON.stringify({ type: "event", id: frame.id, seq: -1, final: true, event: { type: "turn_completed" } }) });
    }
  }
}

test("transport rejects invalid negative event sequence values", async () => {
  (globalThis as any).WebSocket = InvalidSequenceWebSocket;
  const transport = new GatewayTransport({ url: "ws://fake", token: "token" });
  await transport.connect();
  const iterator = transport.stream("submit_turn", {})[Symbol.asyncIterator]();
  await assert.rejects(() => iterator.next(), { code: "validation_error" });
  transport.close();
});

class DuplicateFinalWebSocket extends FakeWebSocket {
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.type === "hello") { super.send(raw); return; }
    if (frame.method === "submit_turn") {
      (this as any).emit("message", { data: JSON.stringify({ type: "event", id: frame.id, seq: 0, final: true, event: { type: "turn_completed", result: "ok" } }) });
      queueMicrotask(() => (this as any).emit("message", { data: JSON.stringify({ type: "event", id: frame.id, seq: 1, final: true, event: { type: "turn_completed", result: "duplicate" } }) }));
    }
  }
}

test("transport treats duplicate final frames as idempotent", async () => {
  (globalThis as any).WebSocket = DuplicateFinalWebSocket;
  const transport = new GatewayTransport({ url: "ws://fake", token: "token" });
  await transport.connect();
  const values: unknown[] = [];
  for await (const event of transport.stream("submit_turn", {})) values.push(event);
  assert.equal(values.length, 1);
  assert.equal((values[0] as any).result, "ok");
  transport.close();
});

class PendingWebSocket extends FakeWebSocket {
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.type === "hello") { super.send(raw); return; }
    // Deliberately leave requests unresolved so close() must reject them.
  }
}

test("transport rejects pending requests when closed", async () => {
  (globalThis as any).WebSocket = PendingWebSocket;
  const transport = new GatewayTransport({ url: "ws://fake", token: "token" });
  await transport.connect();
  const pending = transport.request("never", {});
  transport.close();
  await assert.rejects(() => pending, { code: "transport_error" });
});

test("embedded transport uses Gateway wire frames and rejects pending work on close", async () => {
  const endpoint = new FakeEmbeddedEndpoint();
  const transport = new PilotDeckEmbeddedTransport({ endpoint, token: "embedded-test" });
  const info = await transport.connect();
  assert.equal(info.protocolVersion, "1.1");
  const events: any[] = [];
  for await (const event of transport.stream("submit_turn", {})) events.push(event);
  assert.deepEqual(events, [{ type: "turn_completed", result: "embedded", sequence: 0 }]);
  const pending = transport.request("never", {});
  transport.close();
  await assert.rejects(() => pending, { code: "transport_error" });
});

test("embedded client exposes resource facades without allowing a query to close its host endpoint", async () => {
  const endpoint = new FakeEmbeddedEndpoint();
  const client = createEmbeddedPilotDeckClient({
    connection: { endpoint, token: "embedded-client-test" },
    projectKey: "project",
  });

  assert.equal((await client.connect()).serverVersion, "embedded");
  assert.equal((await client.describeServer()).mode, "default");
  assert.equal((await client.sessions.create()).sessionId, "embedded-session");

  const run = client.query("Run through the embedded client.");
  assert.equal((await run.result()).status, "completed");
  run.close();

  assert.equal((await client.sessions.list()).length, 1, "closing one query must not close the client control transport");
  assert.equal(endpoint.requests.some((request) => request.method === "submit_turn"), true);
  assert.equal(endpoint.helloCount, 1, "one embedded endpoint represents one authenticated Gateway wire connection");

  await client.close();
  await assert.rejects(() => client.describeServer(), { code: "transport_error" });
});

class UnknownNotificationWebSocket extends FakeWebSocket {
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.type === "hello") { super.send(raw); return; }
    if (frame.method === "submit_turn") {
      (this as any).emit("message", { data: JSON.stringify({ type: "notification", name: "future_event", payload: { ignored: true } }) });
      (this as any).emit("message", { data: JSON.stringify({ type: "event", id: frame.id, seq: 0, final: true, event: { type: "turn_completed" } }) });
    }
  }
}

test("transport ignores unknown notifications without breaking the stream", async () => {
  (globalThis as any).WebSocket = UnknownNotificationWebSocket;
  const transport = new GatewayTransport({ url: "ws://fake", token: "token" });
  await transport.connect();
  let count = 0;
  for await (const _event of transport.stream("submit_turn", {})) count += 1;
  assert.equal(count, 1);
  transport.close();
});

class FakeControlWebSocket extends FakeWebSocket {
  static requests: Array<{ method: string; params: any }> = [];
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "supported_agents") {
      FakeControlWebSocket.requests.push(frame);
      this.emitForTest({ type: "response", id: frame.id, ok: true, result: { agents: [{ name: "explore", description: "Read-only", tools: ["read_file"], readOnly: true }] } });
      return;
    }
    if (["rename_session", "tag_session", "delete_session", "background_task_stop", "background_tasks"].includes(frame.method)) {
      FakeControlWebSocket.requests.push(frame);
      const result = frame.method === "background_task_stop"
        ? { stopped: true, status: "cancelled" }
        : frame.method === "background_tasks"
          ? { backgrounded: false, reason: "no_foreground_tasks" }
          : { updated: true };
      this.emitForTest({ type: "response", id: frame.id, ok: true, result });
      return;
    }
    super.send(raw);
  }
  emitForTest(frame: unknown): void { (this as any).emit("message", { data: JSON.stringify(frame) }); }
}

class FakeStreamInputWebSocket extends FakeWebSocket {
  static requests: Array<{ method: string; params: any }> = [];
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "submit_turn") {
      this.emitForTest({ type: "event", id: frame.id, seq: 0, final: false, event: { type: "turn_started", runId: "r-stream" } });
      return;
    }
    if (frame.method === "steer_turn") {
      FakeStreamInputWebSocket.requests.push(frame);
      this.emitForTest({ type: "response", id: frame.id, ok: true, result: { accepted: true } });
      return;
    }
    super.send(raw);
  }
  emitForTest(frame: unknown): void { (this as any).emit("message", { data: JSON.stringify(frame) }); }
}

test("query and client expose supported agents and session mutations", async () => {
  FakeControlWebSocket.requests = [];
  (globalThis as any).WebSocket = FakeControlWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token" } });
  assert.equal((await run.supportedAgents())[0]?.name, "explore");
  run.close();
  const client = createPilotDeckClient({ gatewayUrl: "ws://fake", authToken: "token" });
  await client.sessions.rename("s1", "Title");
  await client.sessions.tag("s1", "tag");
  await client.sessions.delete("s1");
  assert.deepEqual(FakeControlWebSocket.requests.map((request) => request.method), ["supported_agents", "rename_session", "tag_session", "delete_session"]);
});

test("query exposes Claude task controls through Gateway-owned background tasks", async () => {
  FakeControlWebSocket.requests = [];
  (globalThis as any).WebSocket = FakeControlWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token" } });
  assert.equal(await run.backgroundTasks(), false);
  await run.stopTask("task-1");
  assert.equal(FakeControlWebSocket.requests.some((request) => request.method === "background_tasks"), true);
  assert.deepEqual(
    FakeControlWebSocket.requests.find((request) => request.method === "background_task_stop")?.params,
    { sessionKey: "s1", taskId: "task-1" },
  );
  run.close();
});

class FakeSdkClientWebSocket extends FakeWebSocket {
  static connections = 0;
  static requests: Array<{ method: string; params: any }> = [];
  constructor(url: string) {
    super(url);
    FakeSdkClientWebSocket.connections += 1;
  }
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.type === "hello") {
      super.send(raw);
      return;
    }
    FakeSdkClientWebSocket.requests.push(frame);
    const respond = (result: unknown) => this.emitForTest({ type: "response", id: frame.id, ok: true, result });
    switch (frame.method) {
      case "describe_server": respond({ mode: "remote", protocolVersion: "1.1", capabilities: ["project_files_list"] }); return;
      case "new_session": respond({ sessionKey: "session-new" }); return;
      case "resume_session": respond({ sessionKey: frame.params.sessionKey }); return;
      case "list_sessions": respond({ sessions: [{ sessionId: "session-existing", sessionKey: "session-existing", projectKey: "project" }] }); return;
      case "read_session_messages": respond({ messages: [{ type: "assistant.message", text: "history", entryId: "entry-1" }] }); return;
      case "fork_session": respond({ newSessionKey: "session-fork" }); return;
      case "replace_last_turn": respond({
        sessionKey: frame.params.sessionKey,
        replacedTurnId: frame.params.expectedTurnId,
        removedEntryCount: 2,
        transactionId: `replacement-${frame.params.replacementTurnId}`,
      }); return;
      case "finalize_last_turn_replacement": respond({
        sessionKey: frame.params.sessionKey,
        transactionId: frame.params.transactionId,
        action: frame.params.action,
      }); return;
      case "close_session":
      case "rename_session":
      case "tag_session":
      case "delete_session":
      case "session_model_clear":
      case "abort_turn": respond({ ok: true }); return;
      case "project_files_list": respond({ items: [{ id: "file-1", name: "README.md", relativePath: "README.md", kind: "file" }], nextCursor: "next" }); return;
      case "project_file_read": respond({ path: frame.params.path, content: "# PilotDeck", encoding: "utf-8" }); return;
      case "list_projects": respond({ projects: [{ projectKey: "project", name: "PilotDeck" }] }); return;
      case "describe_project": respond({ projectKey: frame.params.projectKey, name: "PilotDeck" }); return;
      case "model_catalog_list": respond({ items: [{ id: "openai/gpt-test", provider: "openai", model: "gpt-test" }] }); return;
      case "session_model_get":
      case "session_model_set": respond({ effective: { provider: "openai", model: "gpt-test", source: "session" } }); return;
      case "commands_list": respond({ pinned: [{ name: "help" }], builtIn: [{ name: "clear" }], custom: [] }); return;
      case "skill_list": respond({ items: [{ name: "release", slug: "release" }] }); return;
      case "skill_read": respond({ name: "release", content: "# Release" }); return;
      case "mcp_server_status": respond({ servers: [{ name: "tickets", status: "connected" }] }); return;
      case "set_mcp_servers": respond({ added: Object.keys(frame.params.servers ?? {}), removed: [], errors: [] }); return;
      case "mcp_server_reconnect":
      case "mcp_server_toggle": respond({ ok: true }); return;
      case "set_mcp_permission_mode_override": respond({
        ...(frame.params.mode === "auto" ? { warning: "conservative" } : {}),
      }); return;
      case "reload_config":
      case "reload_extensions": respond({ reloaded: true }); return;
      case "cron_create": respond({ task: {
        schemaVersion: 1,
        taskId: "cron-1",
        message: frame.params.message,
        schedule: frame.params.schedule,
        status: "scheduled",
        sessionKey: frame.params.sessionKey ?? "cron-session",
        channelKey: frame.params.channelKey ?? "api_server",
        projectKey: frame.params.projectKey,
        createdAt: "2026-09-08T00:00:00.000Z",
        updatedAt: "2026-09-08T00:00:00.000Z",
        revision: 1,
      } }); return;
      case "cron_list": respond({ tasks: [], recentRuns: [] }); return;
      case "cron_update": respond({ updated: true, task: { taskId: frame.params.taskId, revision: frame.params.expectedRevision + 1 } }); return;
      case "cron_delete": respond({ deleted: true, stoppedRunId: "cron-run-1" }); return;
      case "cron_stop": respond({ stopped: true, taskId: frame.params.taskId, runId: frame.params.runId }); return;
      case "cron_run_now": respond({ started: true, taskId: frame.params.taskId }); return;
      case "steer_turn": respond({ accepted: true }); return;
      case "cancel_steer": respond({ cancelled: true }); return;
      case "submit_turn": {
        const events = [
          { type: "turn_started", runId: frame.params.runId },
          { type: "assistant_text_delta", text: "done" },
          { type: "turn_completed", usage: { inputTokens: 1 }, finishReason: "stop" },
        ];
        events.forEach((event, seq) => this.emitForTest({ type: "event", id: frame.id, seq, final: false, event }));
        this.emitForTest({ type: "event", id: frame.id, seq: events.length, final: true, event: events[2] });
        return;
      }
      default: super.send(raw);
    }
  }
  emitForTest(frame: unknown): void { (this as any).emit("message", { data: JSON.stringify(frame) }); }
}

test("client exposes Gateway-authoritative session, run and resource facades", async () => {
  FakeSdkClientWebSocket.connections = 0;
  FakeSdkClientWebSocket.requests = [];
  (globalThis as any).WebSocket = FakeSdkClientWebSocket;
  const client = createPilotDeckClient({ gatewayUrl: "ws://fake", authToken: "token", projectKey: "project" });

  const connected = await client.connect();
  assert.equal(connected.protocolVersion, "1.1");
  await client.connect();
  assert.equal(FakeSdkClientWebSocket.connections, 1);
  assert.equal((await client.describeServer()).mode, "remote");

  assert.equal((await client.sessions.create()).id, "session-new");
  assert.equal((await client.sessions.get("session-existing")).projectKey, "project");
  assert.equal((await client.sessions.resume("session-existing")).sessionId, "session-existing");
  assert.equal((await client.sessions.messages("session-existing"))[0]?.text, "history");
  assert.equal((await client.sessions.fork("session-existing")).sessionId, "session-fork");
  await client.sessions.close("session-existing", { reason: "test" });

  const rolledBackReplacement = await client.sessions.prepareLastTurnReplacement("session-existing", {
    expectedTurnId: "turn-original",
  });
  await rolledBackReplacement.rollback();
  await rolledBackReplacement.rollback();
  const rollbackFrame = FakeSdkClientWebSocket.requests.find((request) => (
    request.method === "finalize_last_turn_replacement"
    && request.params.transactionId === `replacement-${rolledBackReplacement.runId}`
  ));
  assert.deepEqual(rollbackFrame?.params, {
    sessionKey: "session-existing",
    projectKey: "project",
    transactionId: `replacement-${rolledBackReplacement.runId}`,
    action: "rollback",
  });

  const replacement = await client.sessions.prepareLastTurnReplacement("session-existing", {
    expectedTurnId: "turn-to-replace",
  });
  const replacementRun = replacement.start({ type: "text", text: "corrected prompt" });
  assert.throws(
    () => replacement.start({ type: "text", text: "second corrected prompt" }),
    { code: "conflict" },
  );
  assert.equal((await replacementRun.events()[Symbol.asyncIterator]().next()).value?.type, "turn.started");
  assert.equal((await replacementRun.result()).status, "completed");
  const replacementSubmit = FakeSdkClientWebSocket.requests.find((request) => (
    request.method === "submit_turn" && request.params.runId === replacement.runId
  ));
  assert.equal(replacementSubmit?.params.message, "corrected prompt");
  assert.equal(replacementSubmit?.params.sessionKey, "session-existing");
  assert.equal(
    FakeSdkClientWebSocket.requests.some((request) => (
      request.method === "finalize_last_turn_replacement"
      && request.params.transactionId === `replacement-${replacement.runId}`
      && request.params.action === "commit"
    )),
    false,
    "Gateway commits after accepted input; the SDK must not issue a second transaction state change.",
  );
  await assert.rejects(() => replacement.rollback(), { code: "conflict" });

  assert.equal((await client.projects.list())[0]?.projectKey, "project");
  assert.equal((await client.projects.get("project")).name, "PilotDeck");
  assert.equal((await client.files.list({ projectKey: "project" })).nextCursor, "next");
  assert.equal((await client.files.read({ projectKey: "project", path: "README.md" }))?.content, "# PilotDeck");
  assert.equal((await client.models.list({ projectKey: "project" }))[0]?.id, "openai/gpt-test");
  await client.models.get({ sessionId: "session-existing", projectKey: "project" });
  await client.models.set({ sessionId: "session-existing", projectKey: "project", selection: { mode: "model", provider: "openai", model: "gpt-test" } });
  await client.models.clear({ sessionId: "session-existing", projectKey: "project" });
  assert.deepEqual((await client.commands.list({ projectKey: "project" })).items.map((command) => command.name), ["help", "clear"]);
  assert.equal((await client.skills.list())[0]?.name, "release");
  assert.equal((await client.skills.read({ scope: "user", slug: "release" })).content, "# Release");
  assert.equal((await client.mcp.status({ sessionId: "session-existing" }))[0]?.name, "tickets");
  assert.deepEqual(await client.mcp.setServers({
    sessionId: "session-existing",
    servers: { tickets: { type: "http", url: "https://tickets.example/mcp" } },
  }), { added: ["tickets"], removed: [], errors: [] });
  await client.mcp.reconnect({ sessionId: "session-existing", serverName: "tickets" });
  await client.mcp.toggle({ sessionId: "session-existing", serverName: "tickets", enabled: false });
  assert.deepEqual(await client.mcp.setPermissionModeOverride({
    sessionId: "session-existing",
    serverName: "tickets",
    mode: "auto",
  }), { warning: "conservative" });
  const clientMcpSet = FakeSdkClientWebSocket.requests.find((request) => request.method === "set_mcp_servers");
  assert.deepEqual(clientMcpSet?.params.servers.tickets, {
    type: "streamable_http",
    url: "https://tickets.example/mcp",
  });
  assert.equal((await client.config.reload()).reloaded, true);
  assert.equal((await client.extensions.reload()).reloaded, true);

  const scheduled = await client.cron.create({
    projectKey: "project",
    sessionId: "session-existing",
    message: "Review the release status.",
    schedule: { type: "delay", amount: 10, unit: "minute" },
  });
  assert.equal(scheduled.taskId, "cron-1");
  assert.equal(scheduled.sessionKey, "session-existing");
  assert.deepEqual(await client.cron.list({ projectKey: "project", includeHistory: true }), { tasks: [], recentRuns: [] });
  assert.equal((await client.cron.update({
    taskId: "cron-1",
    projectKey: "project",
    expectedRevision: 1,
    message: "Review the release status.",
    schedule: { type: "once", runAt: "2026-09-09T00:00:00.000Z" },
  })).updated, true);
  assert.equal((await client.cron.runNow({ taskId: "cron-1", projectKey: "project" })).started, true);
  assert.equal((await client.cron.stop({ taskId: "cron-1", projectKey: "project" })).stopped, true);
  assert.equal((await client.cron.delete({ taskId: "cron-1", projectKey: "project", stopRunning: true })).deleted, true);
  const cronCreate = FakeSdkClientWebSocket.requests.find((request) => request.method === "cron_create");
  assert.equal(cronCreate?.params.sessionKey, "session-existing");
  assert.equal("sessionId" in (cronCreate?.params ?? {}), false);

  const run = client.runs.start({
    sessionId: "session-existing",
    input: { type: "user", message: { role: "user", content: "hello" } },
  });
  const events = run.events()[Symbol.asyncIterator]();
  await events.next();
  const steer = await run.steer({ type: "user", message: { role: "user", content: [{ type: "text", text: "continue" }] } });
  assert.equal((await run.cancelSteer(steer.itemId)).cancelled, true);
  await run.abort("test_abort");
  assert.deepEqual(await run.result(), { status: "aborted", reason: "test_abort" });
  const submit = FakeSdkClientWebSocket.requests.find((request) => (
    request.method === "submit_turn" && request.params.runId === run.id
  ));
  assert.equal(submit?.params.runId, run.id);
  assert.equal(submit?.params.message, "hello");
  assert.equal(FakeSdkClientWebSocket.requests.find((request) => request.method === "steer_turn")?.params.message, "continue");
  assert.equal(FakeSdkClientWebSocket.requests.some((request) => request.method === "steer_turn" && request.params.runId === run.id), true);
  assert.equal(FakeSdkClientWebSocket.requests.some((request) => request.method === "cancel_steer" && request.params.itemId === steer.itemId), true);

  await client.close();
  await client.close();
  await assert.rejects(() => client.describeServer(), { code: "transport_error" });
  assert.throws(() => client.query("after close"), { code: "transport_error" });
});

test("top-level last-turn replacement helper keeps its control connections short-lived", async () => {
  FakeSdkClientWebSocket.requests = [];
  (globalThis as any).WebSocket = FakeSdkClientWebSocket;

  const replacement = await prepareLastTurnReplacement("session-existing", {
    gatewayUrl: "ws://fake",
    authToken: "token",
    projectKey: "project",
    expectedTurnId: "turn-original",
  });
  await replacement.rollback();

  const prepareFrame = FakeSdkClientWebSocket.requests.find((request) => request.method === "replace_last_turn");
  const rollbackFrame = FakeSdkClientWebSocket.requests.find((request) => request.method === "finalize_last_turn_replacement");
  assert.equal(prepareFrame?.params.replacementTurnId, replacement.runId);
  assert.equal(rollbackFrame?.params.transactionId, `replacement-${replacement.runId}`);
});

test("client shares an in-flight handshake and run observation signals do not abort the Gateway run", async () => {
  FakeSdkClientWebSocket.connections = 0;
  FakeSdkClientWebSocket.requests = [];
  (globalThis as any).WebSocket = FakeSdkClientWebSocket;
  const client = createPilotDeckClient({ gatewayUrl: "ws://fake", authToken: "token", projectKey: "project" });

  await Promise.all([client.connect(), client.connect()]);
  assert.equal(FakeSdkClientWebSocket.connections, 1);

  const run = client.runs.start({ sessionId: "session-existing", input: { type: "text", text: "hello" } });
  const eventAbort = new AbortController();
  eventAbort.abort("caller stopped observing");
  await assert.rejects(
    () => run.events({ signal: eventAbort.signal })[Symbol.asyncIterator]().next(),
    (error: unknown) => error instanceof AbortError && (error as any).code === "aborted",
  );
  const resultAbort = new AbortController();
  resultAbort.abort("caller stopped observing");
  await assert.rejects(() => run.result({ signal: resultAbort.signal }), (error: unknown) => error instanceof AbortError && (error as any).code === "aborted");

  const received: string[] = [];
  for await (const event of run.events()) received.push(event.type);
  assert.deepEqual(received, ["turn.started", "result"]);
  assert.deepEqual(await run.result(), { status: "completed", output: "done", usage: { inputTokens: 1 }, finishReason: "stop" });
  assert.equal(FakeSdkClientWebSocket.requests.some((request) => request.method === "abort_turn"), false);
  await client.close();
});

test("permission callback failures deny the request and surface a typed error", async () => {
  FakeInteractiveWebSocket.decisions = [];
  (globalThis as any).WebSocket = FakeInteractiveWebSocket;
  const run = query({
    prompt: "hello",
    options: { gatewayUrl: "ws://fake", authToken: "token", canUseTool: () => { throw new Error("callback failed"); } },
  });
  await run.next();
  await assert.rejects(() => run.next(), { code: "permission_callback_error" });
  assert.equal((FakeInteractiveWebSocket.decisions[0] as any).params.decision, "deny");
});

test("an already-aborted controller prevents gateway startup", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  const controller = new AbortController();
  controller.abort();
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token", abortController: controller } });
  assert.deepEqual(await run.result(), { status: "aborted", reason: "abort_controller" });
});

test("streamInput forwards later user messages through the active turn steer mailbox", async () => {
  FakeStreamInputWebSocket.requests = [];
  (globalThis as any).WebSocket = FakeStreamInputWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token", projectKey: "project" } });
  await run.next();
  await run.steer({ type: "user", message: { role: "user", content: [{ type: "text", text: "direct Claude-shaped steer" }] } });
  await run.streamInput((async function* () {
    yield { type: "text" as const, text: "follow up" };
    yield { type: "user" as const, message: { role: "user" as const, content: "second follow up" } };
  })());
  assert.equal(FakeStreamInputWebSocket.requests[0]?.params.runId, "r-stream");
  assert.equal(FakeStreamInputWebSocket.requests[0]?.params.message, "direct Claude-shaped steer");
  assert.equal(FakeStreamInputWebSocket.requests[1]?.params.message, "follow up");
  assert.equal(FakeStreamInputWebSocket.requests[2]?.params.message, "second follow up");
  run.close();
});

test("query mirrors streamed events into a Claude-like SessionStore without changing results", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  const store = new InMemorySessionStore();
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token", projectKey: "project", sessionStore: store } });
  for await (const _event of run) { /* consume */ }
  const entries = await store.load({ projectKey: "project", sessionId: "s1" });
  assert.equal(entries?.length, 3);
  assert.equal(entries?.[0]?.type, "sdk_event");
  assert.equal((entries?.at(-1)?.event as any)?.type, "result");
});

test("query normalizes a model id through the Gateway catalog", async () => {
  class ModelWebSocket extends FakeWebSocket {
    override send(raw: string): void {
      const frame = JSON.parse(raw);
      if (frame.method === "model_catalog_list") {
        this.emitForTest({ type: "response", id: frame.id, ok: true, result: { items: [{ id: "openai/gpt-test", provider: "openai", model: "gpt-test", available: true }] } });
        return;
      }
      if (frame.method === "submit_turn") {
        assert.deepEqual(frame.params.modelOverride, { mode: "model", provider: "openai", model: "gpt-test" });
      }
      super.send(raw);
    }
    emitForTest(frame: unknown): void { (this as any).emit("message", { data: JSON.stringify(frame) }); }
  }
  (globalThis as any).WebSocket = ModelWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token", projectKey: "project", model: "openai/gpt-test" } });
  for await (const _event of run) { /* consume */ }
});

test("toEmbeddedTool adapts a local SDK handler without changing runtime ownership", async () => {
  const controller = new AbortController();
  let seen: unknown;
  const embedded = toEmbeddedTool(tool(
    "echo",
    "Echo input",
    { type: "object", properties: { value: { type: "string" } } },
    async (input, context) => {
      seen = { input, signal: context.signal, toolUseId: context.toolUseId };
      return { content: [{ type: "text", text: String((input as any).value) }] };
    },
    { annotations: { readOnly: true } },
  ));
  const output = await embedded.execute({ value: "ok" }, { sessionId: "s", turnId: "r", currentToolCallId: "t", abortSignal: controller.signal });
  assert.equal(embedded.isReadOnly({}), true);
  assert.equal((seen as any).signal, controller.signal);
  assert.equal((seen as any).toolUseId, "t");
  assert.deepEqual(output.content, [{ type: "text", text: "ok" }]);
});

test("embedded tool registry publishes local tools only through an attached Gateway host", () => {
  const updates: string[][] = [];
  const registry = createEmbeddedToolRegistry();
  const detach = registry.attach({
    updateSubsystems: ({ extraTools }) => updates.push(extraTools.map((entry) => entry.name)),
  });
  const first = registry.register(tool(
    "embedded_echo",
    "Echo a local value",
    { type: "object", properties: { value: { type: "string" } } },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
    { annotations: { readOnly: true } },
  ));
  assert.equal(first.name, "embedded_echo");
  assert.deepEqual(updates, [[], ["embedded_echo"]]);
  assert.throws(() => registry.register(tool(
    "embedded_echo",
    "Duplicate",
    { type: "object" },
    async () => ({ content: [] }),
  )), { code: "conflict" });

  detach();
  assert.equal(registry.unregister("embedded_echo"), true);
  assert.deepEqual(updates, [[], ["embedded_echo"]]);
  assert.deepEqual(registry.list(), []);
});

test("embedded host composes a client and local tools, then detaches publication on close", async () => {
  const endpoint = new FakeEmbeddedEndpoint();
  const updates: string[][] = [];
  const host = createEmbeddedPilotDeckHost({
    connection: { endpoint, token: "embedded-host-test" },
    projectKey: "project",
    gatewayHost: {
      updateSubsystems: ({ extraTools }) => updates.push(extraTools.map((entry) => entry.name)),
    },
    localTools: [tool(
      "embedded_host_echo",
      "Echo input from the embedded host.",
      { type: "object", properties: { value: { type: "string" } } },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      { annotations: { readOnly: true } },
    )],
  });

  assert.deepEqual(updates, [["embedded_host_echo"]]);
  assert.equal((await host.client.connect()).serverVersion, "embedded");
  await host.close();
  await host.close();

  host.toolRegistry!.register(tool(
    "embedded_host_late",
    "Must not publish after the composed host closes.",
    { type: "object" },
    async () => ({ content: [] }),
  ));
  assert.deepEqual(updates, [["embedded_host_echo"]]);
  await assert.rejects(() => host.client.describeServer(), { code: "transport_error" });
});

test("embedded host rejects local handlers without a Gateway tool host", () => {
  assert.throws(() => createEmbeddedPilotDeckHost({
    connection: { endpoint: new FakeEmbeddedEndpoint(), token: "embedded-host-test" },
    localTools: [tool(
      "missing_host",
      "Requires an attached host.",
      { type: "object" },
      async () => ({ content: [] }),
    )],
  }), { code: "validation_error" });
});

test("startup returns a warmed query handle that reuses its handshake", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  const warm = await (await import("../src/index.js")).startup({ options: { gatewayUrl: "ws://fake", authToken: "token" } });
  const run = warm.query("hello");
  for await (const _event of run) { /* consume */ }
  assert.throws(() => warm.query("again"), { code: "conflict" });
  warm.close();
});

class FakeThinkingAndRewindWebSocket extends FakeWebSocket {
  static requests: Array<{ method: string; params: any }> = [];
  override send(raw: string): void {
    const frame = JSON.parse(raw);
    if (frame.method === "set_session_thinking") {
      FakeThinkingAndRewindWebSocket.requests.push(frame);
      this.emitForTest({ type: "response", id: frame.id, ok: true, result: { applied: true } });
      return;
    }
    if (frame.method === "rewind_files") {
      FakeThinkingAndRewindWebSocket.requests.push(frame);
      this.emitForTest({
        type: "response",
        id: frame.id,
        ok: true,
        result: { canRewind: true, filesChanged: ["/workspace/a.ts"], insertions: 2, deletions: 1 },
      });
      return;
    }
    super.send(raw);
  }
  emitForTest(frame: unknown): void { (this as any).emit("message", { data: JSON.stringify(frame) }); }
}

test("query applies Claude-like thinking options before the native turn starts", async () => {
  FakeThinkingAndRewindWebSocket.requests = [];
  (globalThis as any).WebSocket = FakeThinkingAndRewindWebSocket;
  const run = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      thinking: { type: "enabled", budgetTokens: 2048 },
    },
  });
  for await (const _event of run) { /* consume */ }
  assert.deepEqual(FakeThinkingAndRewindWebSocket.requests[0]?.params.thinking, {
    enabled: true,
    mode: "medium",
    budgetTokens: 2048,
  });
  run.close();
});

test("query maps Claude effort to the existing native thinking mode", async () => {
  FakeThinkingAndRewindWebSocket.requests = [];
  (globalThis as any).WebSocket = FakeThinkingAndRewindWebSocket;
  const run = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      effort: "xhigh",
    },
  });
  for await (const _event of run) { /* consume */ }
  assert.deepEqual(FakeThinkingAndRewindWebSocket.requests[0]?.params.thinking, {
    enabled: true,
    mode: "xhigh",
  });
  run.close();
});

test("applyFlagSettings configures an unstarted query without racing its first turn", async () => {
  class FlagSettingsWebSocket extends FakeThinkingAndRewindWebSocket {
    static submitParams: any;
    override send(raw: string): void {
      const frame = JSON.parse(raw);
      if (frame.method === "submit_turn") FlagSettingsWebSocket.submitParams = frame.params;
      super.send(raw);
    }
  }
  FakeThinkingAndRewindWebSocket.requests = [];
  (globalThis as any).WebSocket = FlagSettingsWebSocket;
  const run = query({
    prompt: "hello",
    options: { gatewayUrl: "ws://fake", authToken: "token" },
  });
  await run.applyFlagSettings({ effortLevel: "high", permissions: { defaultMode: "plan" } });
  for await (const _event of run) { /* consume */ }
  assert.deepEqual(FakeThinkingAndRewindWebSocket.requests[0]?.params.thinking, { enabled: true, mode: "high" });
  assert.equal(FlagSettingsWebSocket.submitParams.mode, "plan");
  // The base mode is restored when native plan mode exits; it remains the
  // conservative default rather than pinning the session in plan mode.
  assert.equal(FlagSettingsWebSocket.submitParams.basePermissionMode, "default");
  run.close();
});

test("setMaxThinkingTokens can configure an unstarted query and rewind after result", async () => {
  FakeThinkingAndRewindWebSocket.requests = [];
  (globalThis as any).WebSocket = FakeThinkingAndRewindWebSocket;
  const run = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      projectKey: "/workspace",
      enableFileCheckpointing: true,
    },
  });
  await run.setMaxThinkingTokens(1024, "omitted");
  for await (const _event of run) { /* consume */ }
  const rewind = await run.rewindFiles("message-1", { dryRun: false });
  assert.deepEqual(rewind, {
    canRewind: true,
    filesChanged: ["/workspace/a.ts"],
    insertions: 2,
    deletions: 1,
  });
  assert.deepEqual(
    FakeThinkingAndRewindWebSocket.requests.map((request) => request.method),
    ["set_session_thinking", "rewind_files"],
  );
  run.close();
});

test("query serializes only native-equivalent session config options", async () => {
  class SessionConfigWebSocket extends FakeWebSocket {
    static submitParams: any;
    override send(raw: string): void {
      const frame = JSON.parse(raw);
      if (frame.method === "set_session_thinking") {
        this.emitForTest({ type: "response", id: frame.id, ok: true, result: { applied: true } });
        return;
      }
      if (frame.method === "submit_turn") SessionConfigWebSocket.submitParams = frame.params;
      super.send(raw);
    }
    emitForTest(frame: unknown): void { (this as any).emit("message", { data: JSON.stringify(frame) }); }
  }
  (globalThis as any).WebSocket = SessionConfigWebSocket;
  const run = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      systemPrompt: "You are a release reviewer.",
      appendSystemPrompt: "Always include a verification note.",
      outputStyle: "concise",
      fallbackModel: "openai/gpt-4.1-mini",
      agentProgressSummaries: true,
      managedSettings: {
        permissions: {
          deny: ["Bash(git push *)"],
          ask: ["WebFetch"],
          defaultMode: "plan",
        },
      },
      effort: "high",
      toolAliases: { Bash: "sandbox_bash" },
      additionalDirectories: ["/workspace/shared"],
      tools: ["read_file", "sandbox_bash"],
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          required: ["status"],
          additionalProperties: false,
          properties: { status: { type: "string", enum: ["ok", "failed"] } },
        },
      },
      agents: {
        reviewer: {
          description: "Review a proposed change.",
          prompt: "Inspect the change carefully and report actionable issues.",
          model: "openai/gpt-4.1-mini",
          tools: ["read_file", "grep"],
          disallowedTools: ["bash"],
          maxTurns: 3,
          permissionMode: "plan",
          mcpServers: {
            review_tools: { type: "streamable_http", url: "http://127.0.0.1:4312/mcp" },
          },
          skills: ["review"],
          memory: "disabled",
          initialPrompt: "Inspect repository conventions before the task.",
          criticalSystemReminder_EXPERIMENTAL: "Report only verified findings.",
        },
      },
      skills: ["review"],
    },
  });
  for await (const _event of run) { /* consume */ }
  assert.deepEqual(SessionConfigWebSocket.submitParams.sdkSessionConfig, {
    systemPrompt: "You are a release reviewer.",
    appendSystemPrompt: "Always include a verification note.",
    outputStyle: "concise",
    fallbackModel: "openai/gpt-4.1-mini",
    agentProgressSummaries: true,
    managedPermissions: {
      deny: ["Bash(git push *)"],
      ask: ["WebFetch"],
      defaultMode: "plan",
    },
    toolAliases: { Bash: "sandbox_bash" },
    additionalWorkingDirectories: ["/workspace/shared"],
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        required: ["status"],
        additionalProperties: false,
        properties: { status: { type: "string", enum: ["ok", "failed"] } },
      },
    },
    agents: {
      reviewer: {
        description: "Review a proposed change.",
        prompt: "Inspect the change carefully and report actionable issues.",
        model: "openai/gpt-4.1-mini",
        tools: ["read_file", "grep"],
        disallowedTools: ["bash"],
        maxTurns: 3,
        permissionMode: "plan",
        mcpServers: {
          review_tools: { type: "streamable_http", url: "http://127.0.0.1:4312/mcp" },
        },
        skills: ["review"],
        memory: "disabled",
        initialPrompt: "Inspect repository conventions before the task.",
        criticalSystemReminder_EXPERIMENTAL: "Report only verified findings.",
      },
    },
    skills: ["review"],
  });
  assert.deepEqual(SessionConfigWebSocket.submitParams.sdkSessionConfig, {
    systemPrompt: "You are a release reviewer.",
    appendSystemPrompt: "Always include a verification note.",
    outputStyle: "concise",
    fallbackModel: "openai/gpt-4.1-mini",
    agentProgressSummaries: true,
    managedPermissions: {
      deny: ["Bash(git push *)"],
      ask: ["WebFetch"],
      defaultMode: "plan",
    },
    toolAliases: { Bash: "sandbox_bash" },
    additionalWorkingDirectories: ["/workspace/shared"],
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        required: ["status"],
        additionalProperties: false,
        properties: { status: { type: "string", enum: ["ok", "failed"] } },
      },
    },
    agents: {
      reviewer: {
        description: "Review a proposed change.",
        prompt: "Inspect the change carefully and report actionable issues.",
        model: "openai/gpt-4.1-mini",
        tools: ["read_file", "grep"],
        disallowedTools: ["bash"],
        maxTurns: 3,
        permissionMode: "plan",
        mcpServers: {
          review_tools: { type: "streamable_http", url: "http://127.0.0.1:4312/mcp" },
        },
        skills: ["review"],
        memory: "disabled",
        initialPrompt: "Inspect repository conventions before the task.",
        criticalSystemReminder_EXPERIMENTAL: "Report only verified findings.",
      },
    },
    skills: ["review"],
  });
  assert.deepEqual(SessionConfigWebSocket.submitParams.allowedTools, ["read_file", "sandbox_bash"]);
  run.close();
});

test("query forwards title and Claude-like prompt compatibility fields", async () => {
  class TitleWebSocket extends FakeWebSocket {
    static requests: Array<{ method: string; params: any }> = [];
    override send(raw: string): void {
      const frame = JSON.parse(raw);
      if (frame.type === "hello") return super.send(raw);
      TitleWebSocket.requests.push({ method: frame.method, params: frame.params });
      if (frame.method === "rename_session") {
        (this as any).emit("message", { data: JSON.stringify({ type: "response", id: frame.id, ok: true, result: { updated: true } }) });
        return;
      }
      super.send(raw);
    }
  }
  TitleWebSocket.requests = [];
  (globalThis as any).WebSocket = TitleWebSocket;
  const run = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      title: "SDK review",
      systemPrompt: ["first", "second"],
      planModeInstructions: "Use the project plan.",
      permissionMode: "dontAsk",
    },
  });
  for await (const _event of run) { /* consume */ }
  const rename = TitleWebSocket.requests.find((request) => request.method === "rename_session");
  const submit = TitleWebSocket.requests.find((request) => request.method === "submit_turn");
  assert.equal(rename?.params.value, "SDK review");
  assert.deepEqual(submit?.params.sdkSessionConfig, {
    systemPrompt: "first\n\nsecond",
    planModeInstructions: "Use the project plan.",
    permissionMode: "dontAsk",
  });
  assert.equal(submit?.params.canPrompt, false);
  run.close();
});

test("loadTimeoutMs reports a distinct timeout during Gateway initialization", async () => {
  class SlowHelloWebSocket extends FakeWebSocket {
    override send(raw: string): void {
      const frame = JSON.parse(raw);
      if (frame.type === "hello") return;
      super.send(raw);
    }
  }
  (globalThis as any).WebSocket = SlowHelloWebSocket;
  const run = query({ prompt: "hello", options: { gatewayUrl: "ws://fake", authToken: "token", loadTimeoutMs: 5 } });
  await assert.rejects(() => run.next(), (error: unknown) => (error as any)?.code === "timeout");
  assert.equal((await run.result()).status, "result_unknown");
  run.close();
});

test("resumeSessionAt forks at the requested chain entry without mutating the source", async () => {
  class ResumeWebSocket extends FakeWebSocket {
    static requests: Array<{ method: string; params: any }> = [];
    override send(raw: string): void {
      const frame = JSON.parse(raw);
      if (frame.type === "hello") return super.send(raw);
      ResumeWebSocket.requests.push({ method: frame.method, params: frame.params });
      if (frame.method === "fork_session") {
        (this as any).emit("message", { data: JSON.stringify({ type: "response", id: frame.id, ok: true, result: { newSessionKey: "forked" } }) });
        return;
      }
      if (frame.method === "resume_session" && frame.params.sessionKey === "forked") {
        (this as any).emit("message", { data: JSON.stringify({ type: "response", id: frame.id, ok: true, result: { sessionKey: "forked" } }) });
        return;
      }
      super.send(raw);
    }
  }
  ResumeWebSocket.requests = [];
  (globalThis as any).WebSocket = ResumeWebSocket;
  const run = query({
    prompt: "continue from here",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      resume: "source",
      resumeSessionAt: "entry-42",
      resumeDropsTurn: "turn-entry-99",
    },
  });
  for await (const _event of run) { /* consume */ }
  const fork = ResumeWebSocket.requests.find((request) => request.method === "fork_session");
  assert.deepEqual(fork?.params, {
    sessionKey: "source",
    fromEntryId: "entry-42",
    resumeAt: true,
    resumeDropsTurn: "turn-entry-99",
  });
  assert.equal(ResumeWebSocket.requests.some((request) => request.method === "resume_session" && request.params.sessionKey === "source"), false);
  run.close();
});

test("query rejects Claude options without a native-equivalent lifecycle", async () => {
  (globalThis as any).WebSocket = FakeWebSocket;
  const presetTools = query({
    prompt: "hello",
    options: { gatewayUrl: "ws://fake", authToken: "token", tools: { type: "preset", preset: "claude_code" } },
  });
  await assert.rejects(() => presetTools.next(), { code: "unsupported_capability" });
  const invalidOutput = query({
    prompt: "hello",
    options: {
      gatewayUrl: "ws://fake",
      authToken: "token",
      outputFormat: { type: "json_schema", schema: { type: "object", required: [42 as any] } },
    },
  });
  await assert.rejects(() => invalidOutput.next(), { code: "validation_error" });
});

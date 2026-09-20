#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { chromium } from "playwright";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const productRoot = resolve(scriptDir, "..");
const pilotdeckRoot = resolve(productRoot, "../..");
const staffdeckRoot = resolve(process.env.STAFFDECK_SOP_ROOT ?? join(pilotdeckRoot, "../StaffDeck-portable-sop"));
const node = process.execPath;
const docker = process.env.DOCKER_BIN ?? "docker";
const modelPort = Number(process.env.PILOTDECK_EXPORTED_WEB_MODEL_PORT ?? "18192");
const webPort = Number(process.env.PILOTDECK_EXPORTED_WEB_PORT ?? "13003");
const sopEnabled = process.env.PILOTDECK_EXPORTED_WEB_SOP_ENABLED !== "false";
const realModel = process.env.PILOTDECK_EXPORTED_WEB_REAL_MODEL === "1";
const realModelSource = process.env.PILOTDECK_EXPORTED_WEB_REAL_MODEL_SOURCE ?? "/Users/a1/.pilotdeck/pilotdeck.yaml";
const realModelId = process.env.PILOTDECK_EXPORTED_WEB_REAL_MODEL_ID ?? "provider1/qwen3.6-flash-distill";
const project = `pilotdeckexportweb${process.pid}`;
const root = await mkdtemp(join(tmpdir(), "pilotdeck-exported-web-"));
const artifactDir = resolve(process.env.PILOTDECK_EXPORTED_WEB_ARTIFACT_DIR ?? join(tmpdir(), `pilotdeck-exported-web-artifacts-${process.pid}`));
const profilePath = join(root, "profile.yaml");
const reusedExportPath = process.env.PILOTDECK_EXPORTED_WEB_EXPORT_DIR;
const exportPath = reusedExportPath ? resolve(reusedExportPath) : join(root, "export");
const reuseImage = process.env.PILOTDECK_EXPORTED_WEB_REUSE_IMAGE === "1";
const runRecovery = sopEnabled && process.env.PILOTDECK_EXPORTED_WEB_SKIP_RECOVERY !== "1";
const model = realModel ? undefined : spawn(node, [join(scriptDir, "local-openai-mock.mjs")], {
  env: {
    ...process.env,
    LOCAL_OPENAI_MOCK_MODE: "operator-approval",
    LOCAL_OPENAI_MOCK_PORT: String(modelPort),
    LOCAL_OPENAI_MOCK_DEBUG: process.env.PILOTDECK_EXPORTED_WEB_DEBUG ?? "",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
let browser;
let lastPage;
let real;
let phase = "initializing";
let composeStarted = false;

try {
  await mkdir(artifactDir, { recursive: true });
  await rm("/tmp/pilotdeck-exported-web-smoke-failure.log", { force: true });
  real = realModel ? await loadRealModel() : undefined;
  if (!realModel) {
    console.log("[exported-web-smoke] starting model mock");
    await waitForModel(model, modelPort);
  }
  if (reusedExportPath) {
    await access(join(exportPath, "compose.yaml"));
    console.log(`[exported-web-smoke] reusing export ${exportPath}`);
  } else {
    await writeFile(profilePath, YAML.stringify(real ? real.profile : {
      schemaVersion: 1,
      agent: { model: "smoke/operator" },
      model: {
        providers: {
          smoke: {
            protocol: "openai",
            url: `http://host.docker.internal:${modelPort}/v1`,
            apiKey: "local-only",
            models: { operator: { capabilities: { supportsToolUse: true } } },
          },
        },
      },
      modules: {
        agentLoop: { enabled: true, provider: "pilotdeck" },
        modelProvider: { enabled: true, provider: "pilotdeck" },
        tools: { enabled: true, provider: "pilotdeck" },
        ...(sopEnabled ? { sop: {
          enabled: true,
          provider: "staffdeck",
          definitionsPath: join(productRoot, "sops/operator-approval.yaml"),
          defaultSopId: "operator_approval",
          timeoutMs: 10000,
        } } : {}),
      },
    }), "utf8");
    console.log("[exported-web-smoke] exporting product");
    await run(node, [join(scriptDir, "export-composition.mjs"), "--profile", profilePath, "--out", exportPath, "--staffdeck-root", staffdeckRoot], pilotdeckRoot);
  }
  const composeUpArgs = ["compose", "--project-name", project, "-f", join(exportPath, "compose.yaml"), "up"];
  if (process.env.PILOTDECK_EXPORTED_WEB_SKIP_BUILD !== "1" && !reuseImage) composeUpArgs.push("--build");
  composeUpArgs.push("--detach");
  console.log("[exported-web-smoke] starting Compose");
  await run(docker, composeUpArgs, exportPath, runtimeEnv(real));
  composeStarted = true;
  console.log("[exported-web-smoke] waiting for web server");
  await waitForHttp(`http://127.0.0.1:${webPort}/`);

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
  });
  const viewports = realModel || process.env.PILOTDECK_EXPORTED_WEB_SKIP_VIEWPORTS === "1"
    ? []
    : [{ width: 1280, height: 900 }, { width: 390, height: 844 }];
  if (realModel) await exerciseRealModelUi(browser);
  for (const viewport of viewports) {
    console.log(`[exported-web-smoke] exercising ${viewport.width}x${viewport.height}`);
    const viewportContext = sopEnabled ? await browser.newContext({ viewport }) : undefined;
    const page = viewportContext ? await viewportContext.newPage() : await browser.newPage({ viewport });
    lastPage = page;
    phase = `${viewport.width}x${viewport.height}: initial turn`;
    await page.goto(`http://127.0.0.1:${webPort}/p/general`);
    if (!sopEnabled) {
      await enableFullAccess(page);
    }
    const composer = page.getByRole("textbox").last();
    await composer.fill(sopEnabled ? "Start the operator approval workflow." : "Start the ordinary PilotDeck-only workflow.");
    await composer.press("Enter");
    if (!sopEnabled) {
      await page.getByText("PilotDeck-only browser smoke completed.").waitFor();
      assert.equal(await page.getByText("PilotDeck-only browser smoke completed.", { exact: true }).count(), 1);
      assert.equal(await page.getByTestId("sop-wait-banner").count(), 0);
      await page.screenshot({ path: join(artifactDir, `pilotdeck-only-${viewport.width}x${viewport.height}.png`), fullPage: true });
      if (viewportContext) await viewportContext.close();
      else await page.close();
      continue;
    }
    await page.getByText("This SOP is waiting for a handoff response.").waitFor();
    console.log(`[exported-web-smoke] ${viewport.width} handoff visible`);
    if (runRecovery && viewport.width >= 1000) {
      phase = "recovery: record handoff state";
      const beforeRestart = await readSopStatus(page);
      assert.equal(beforeRestart?.state?.status, "handoff");
      assert.ok(beforeRestart?.wait?.id, "handoff must have a durable wait id");
      phase = "recovery: restart PilotDeck";
      await compose(exportPath, ["restart", "pilotdeck"]);
      await waitForHttp(`http://127.0.0.1:${webPort}/`);
      await page.reload();
      await page.getByText("This SOP is waiting for a handoff response.").waitFor();
      const afterPilotDeckRestart = await readSopStatus(page);
      assert.equal(afterPilotDeckRestart?.wait?.id, beforeRestart.wait.id);
      assert.equal(afterPilotDeckRestart?.state?.status, "handoff");
      phase = "recovery: restart StaffDeck SOP runtime";
      await compose(exportPath, ["restart", "sop-runtime"]);
      await waitForSopRuntime(exportPath);
      await page.reload();
      await page.getByText("This SOP is waiting for a handoff response.").waitFor();
      const afterSidecarRestart = await readSopStatus(page);
      assert.equal(afterSidecarRestart?.wait?.id, beforeRestart.wait.id);
      await page.screenshot({ path: join(artifactDir, "recovered-wait-after-restarts.png"), fullPage: true });
      console.log("[exported-web-smoke] restart recovery retained wait identity");
    }
    phase = `${viewport.width}x${viewport.height}: refresh wait`;
    await page.reload();
    await page.getByText("This SOP is waiting for a handoff response.").waitFor();
    phase = `${viewport.width}x${viewport.height}: resume`;
    const continuation = page.getByRole("textbox", { name: "SOP continuation message" });
    await continuation.click();
    await continuation.pressSequentially("Browser operator approved");
    const continueButton = page.getByRole("button", { name: "Continue" });
    await assertEventually(async () => await continueButton.isEnabled());
    await continueButton.click();
    const resumedComposer = page.getByRole("textbox").last();
    await assertEventually(async () => (await resumedComposer.inputValue()).includes("Browser operator approved"));
    phase = `${viewport.width}x${viewport.height}: completion`;
    await resumedComposer.press("Enter");
    await page.getByText("Browser operator approval completed.").waitFor();
    console.log(`[exported-web-smoke] ${viewport.width} completion visible`);
    assert.equal(await page.getByText("Browser operator approval completed.", { exact: true }).count(), 1);
    assert.equal(await page.getByTestId("sop-wait-banner").count(), 0);
    await page.screenshot({ path: join(artifactDir, `completed-${viewport.width}x${viewport.height}.png`), fullPage: true });
    if (viewportContext) await viewportContext.close();
    else await page.close();
  }
  if (sopEnabled && !realModel) {
    phase = "stale-tab and session-isolation";
    const isolationContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const primary = await isolationContext.newPage();
    lastPage = primary;
    await startHandoff(primary);
    const stale = await isolationContext.newPage();
    lastPage = stale;
    await stale.goto(primary.url());
    await stale.getByText("This SOP is waiting for a handoff response.").waitFor();

    const primaryContinuation = primary.getByRole("textbox", { name: "SOP continuation message" });
    await primaryContinuation.click();
    await primaryContinuation.pressSequentially("Primary operator approved");
    const primaryContinue = primary.getByRole("button", { name: "Continue" });
    await assertEventually(async () => await primaryContinue.isEnabled());
    await primaryContinue.click();
    const primaryComposer = primary.getByRole("textbox").last();
    await assertEventually(async () => (await primaryComposer.inputValue()).includes("Primary operator approved"));

    const staleContinuation = stale.getByRole("textbox", { name: "SOP continuation message" });
    await staleContinuation.click();
    await staleContinuation.pressSequentially("Stale operator response");
    const staleContinue = stale.getByRole("button", { name: "Continue" });
    await assertEventually(async () => await staleContinue.isEnabled());
    await staleContinue.click();
    await assertEventually(async () => !(await stale.getByRole("textbox").last().inputValue()).includes("Stale operator response"));
    assert.equal(await stale.getByText("Continuation prepared. Send it to continue the SOP.").count(), 0);

    await primaryComposer.press("Enter");
    await primary.getByText("Browser operator approval completed.").waitFor();
    assert.equal(await primary.getByTestId("sop-wait-banner").count(), 0);

    const waiting = await isolationContext.newPage();
    lastPage = waiting;
    await startHandoff(waiting);
    assert.equal(await waiting.getByTestId("sop-wait-banner").count(), 1);
    await primary.reload();
    assert.equal(await primary.getByTestId("sop-wait-banner").count(), 0);
    await primary.screenshot({ path: join(artifactDir, "completed-session-isolation.png"), fullPage: true });
    await waiting.screenshot({ path: join(artifactDir, "waiting-session-isolation.png"), fullPage: true });
    await isolationContext.close();
    console.log("[exported-web-smoke] stale-tab and session isolation passed");
    if (runRecovery) await exerciseSidecarOutage(browser);
  }
  const result = {
    status: "passed",
    artifactDir,
    sopEnabled,
    recovery: runRecovery && !realModel,
    ...(real ? { provider: real.providerId, model: real.modelId } : {}),
    viewports: viewports.map(({ width, height }) => `${width}x${height}`),
  };
  await writeFile(join(artifactDir, "result.json"), `${JSON.stringify(result)}\n`, "utf8");
  console.log(JSON.stringify(result));
} catch (error) {
  await writeFile("/tmp/pilotdeck-exported-web-smoke-failure.log", `${phase}\n${error instanceof Error ? error.stack : String(error)}\n`, "utf8");
  if (lastPage) {
    try {
      await lastPage.screenshot({ path: join(artifactDir, "failure.png"), fullPage: true });
      const text = await lastPage.locator("body").innerText();
      await writeFile(join(artifactDir, "failure-visible-text.txt"), text.slice(0, 20000), "utf8");
    } catch {
      // The original failure is the actionable result; diagnostics are best effort.
    }
  }
  if (composeStarted) {
    try {
      const logs = await capture(docker, ["compose", "--project-name", project, "-f", join(exportPath, "compose.yaml"), "logs", "--no-color"], exportPath);
      await writeFile(join(artifactDir, "failure-compose.log"), logs, "utf8");
    } catch {
      // Diagnostics must not hide the browser failure.
    }
  }
  throw error;
} finally {
  await browser?.close();
  if (composeStarted) {
    await run(docker, ["compose", "--project-name", project, "-f", join(exportPath, "compose.yaml"), "down", "--volumes"], exportPath, runtimeEnv(real), true);
  }
  model?.kill();
  await rm(root, { recursive: true, force: true });
}

function run(command, args, cwd, env = {}, ignoreFailure = false) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || ignoreFailure) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

async function waitForModel(child, port) {
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  await assertEventually(() => output.includes(`:${port}`), 10000);
}

async function waitForHttp(url) {
  await assertEventually(async () => {
    try {
      return (await fetch(url)).ok;
    } catch {
      return false;
    }
  }, 30000);
}

async function assertEventually(assertion, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await assertion();
      if (result === false) throw new Error("condition was false");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
  }
  throw lastError ?? new Error("timed out");
}

async function startHandoff(page) {
  await page.goto(`http://127.0.0.1:${webPort}/p/general`);
  const composer = page.getByRole("textbox").last();
  await composer.fill("Start the operator approval workflow.");
  await composer.press("Enter");
  await page.getByText("This SOP is waiting for a handoff response.").waitFor();
}

async function loadRealModel() {
  const source = YAML.parse(await readFile(realModelSource, "utf8"));
  const [providerId, modelId] = realModelId.split("/");
  const provider = source?.model?.providers?.[providerId];
  if (!providerId || !modelId || !provider || typeof provider.apiKey !== "string" || !provider.apiKey.trim()) {
    throw new Error(`Real model '${realModelId}' is not configured in ${realModelSource}.`);
  }
  const safeProvider = structuredClone(provider);
  const credential = safeProvider.apiKey;
  safeProvider.apiKey = "${PILOTDECK_REAL_MODEL_API_KEY}";
  return {
    providerId,
    modelId,
    credential,
    profile: {
      schemaVersion: 1,
      agent: { model: realModelId },
      model: { providers: { [providerId]: safeProvider } },
      modules: {
        agentLoop: { enabled: true, provider: "pilotdeck" },
        modelProvider: { enabled: true, provider: "pilotdeck" },
        tools: { enabled: true, provider: "pilotdeck" },
        sop: {
          enabled: true, provider: "staffdeck",
          definitionsPath: join(productRoot, "sops/operator-approval.yaml"),
          defaultSopId: "operator_approval", timeoutMs: 30000,
        },
      },
    },
  };
}

function runtimeEnv(realConfig) {
  return {
    PILOTDECK_API_KEY: "test-only",
    PILOTDECK_PORT: String(webPort),
    ...(realConfig ? { PILOTDECK_REAL_MODEL_API_KEY: realConfig.credential } : {}),
  };
}

async function exerciseRealModelUi(browserInstance) {
  phase = "real model: handoff";
  const context = await browserInstance.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const diagnostics = [];
  page.on("console", (message) => diagnostics.push(`console:${message.type()}:${message.text()}`));
  page.on("requestfailed", (request) => diagnostics.push(`requestfailed:${request.method()}:${request.url()}:${request.failure()?.errorText ?? "unknown"}`));
  lastPage = page;
  try {
    await page.goto(`http://127.0.0.1:${webPort}/p/general`);
    const composer = page.getByRole("textbox").last();
    await composer.fill("Use submit_step_result to request operator approval now with status handoff.");
    const sendButton = page.getByRole("button", { name: "Send" });
    await assertEventually(async () => await sendButton.isEnabled(), 60000);
    await sendButton.click();
    await page.getByRole("paragraph").filter({
      hasText: "Use submit_step_result to request operator approval now with status handoff.",
    }).waitFor({ timeout: 30000 });
    await page.getByTestId("sop-wait-banner").waitFor({ timeout: 120000 });
    const waiting = await readSopStatus(page);
    assert.equal(waiting?.state?.status, "handoff");
    assert.ok(waiting?.wait?.id);
    phase = "real model: UI resume";
    const continuation = page.getByRole("textbox", { name: "SOP continuation message" });
    await continuation.pressSequentially("Operator approved. Submit status completed with a concise final reply.");
    const continueButton = page.getByRole("button", { name: "Continue" });
    await assertEventually(async () => await continueButton.isEnabled());
    await continueButton.click();
    const resumed = page.getByRole("textbox").last();
    await assertEventually(async () => (await resumed.inputValue()).includes("Operator approved"));
    await resumed.press("Enter");
    phase = "real model: completion";
    await assertEventually(async () => (await readSopStatus(page))?.state?.status === "completed", 120000);
    assert.equal(await page.getByTestId("sop-wait-banner").count(), 0);
    await page.screenshot({ path: join(artifactDir, "real-model-completed.png"), fullPage: true });
  } finally {
    await writeFile(join(artifactDir, "real-model-browser-events.log"), `${diagnostics.join("\n")}\n`, "utf8");
    await context.close();
  }
}

async function enableFullAccess(page) {
  const selector = page.getByRole("button", { name: /Default Permissions|Full Access/ });
  if (await selector.count()) {
    await selector.click();
    await page.getByRole("menuitemradio", { name: "Full Access" }).click();
    return;
  }
  // The compact composer intentionally omits the selector. Persist the same
  // global preference through the Web API before exercising its tool turn.
  const response = await page.request.put(`http://127.0.0.1:${webPort}/api/settings/permissions`, {
    data: { skipPermissions: true },
  });
  assert.equal(response.ok(), true);
  const body = await response.json();
  assert.equal(body?.permissions?.skipPermissions, true);
  await page.reload();
}

async function readSopStatus(page) {
  return page.evaluate(async () => {
    const entries = performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => url.includes("/api/sop/status?"));
    const url = entries.at(-1);
    if (!url) return null;
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`SOP status returned HTTP ${response.status}`);
    const body = await response.json();
    return body.status;
  });
}

async function exerciseSidecarOutage(browser) {
  phase = "sidecar outage: start handoff";
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await startHandoff(page);
    const before = await readSopStatus(page);
    assert.equal(before?.state?.status, "handoff");
    phase = "sidecar outage: stop runtime";
    await compose(exportPath, ["stop", "sop-runtime"]);
    const continuation = page.getByRole("textbox", { name: "SOP continuation message" });
    await continuation.click();
    await continuation.pressSequentially("Outage operator approved");
    const continueButton = page.getByRole("button", { name: "Continue" });
    await assertEventually(async () => await continueButton.isEnabled());
    await continueButton.click();
    const composer = page.getByRole("textbox").last();
    await assertEventually(async () => (await composer.inputValue()).includes("Outage operator approved"));
    await composer.press("Enter");
    await assertEventually(async () => (await page.getByText(/StaffDeck SOP runtime request failed|SOP_RUNTIME_UNAVAILABLE/u).count()) > 0);
    const duringOutage = await readSopStatus(page);
    assert.equal(duringOutage?.state?.status, "active");
    assert.equal(duringOutage?.state?.active_step_id, before?.state?.active_step_id);
    phase = "sidecar outage: restore runtime";
    await compose(exportPath, ["start", "sop-runtime"]);
    await waitForSopRuntime(exportPath);
    await composer.fill("Recovered operator approved");
    await composer.press("Enter");
    await page.getByText("Browser operator approval completed.").waitFor();
    const completed = await readSopStatus(page);
    assert.equal(completed?.state?.status, "completed");
    await page.screenshot({ path: join(artifactDir, "sidecar-outage-recovered.png"), fullPage: true });
    console.log("[exported-web-smoke] sidecar outage rejected without completion and recovered in the same session");
  } finally {
    await context.close();
  }
}

async function compose(cwd, args) {
  await run(docker, ["compose", "--project-name", project, "-f", join(cwd, "compose.yaml"), ...args], cwd, {
    PILOTDECK_API_KEY: "test-only",
    PILOTDECK_PORT: String(webPort),
  });
}

async function waitForSopRuntime(cwd) {
  await assertEventually(async () => {
    const output = await capture(docker, ["compose", "--project-name", project, "-f", join(cwd, "compose.yaml"), "ps", "--format", "json", "sop-runtime"], cwd);
    return output.includes("healthy");
  }, 30000);
}

function capture(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PILOTDECK_API_KEY: "test-only", PILOTDECK_PORT: String(webPort) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr}`)));
  });
}

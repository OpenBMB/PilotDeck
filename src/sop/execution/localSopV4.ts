import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

export async function startLocalSopV4(options: {
  endpoint: string; python: string; dataDirectory: string; token: string; maxConcurrency?: number;
  startupTimeoutMs?: number; env: Record<string, string | undefined>;
}): Promise<{ stop(): Promise<void> }> {
  const url = new URL(options.endpoint);
  // Refuse an occupied port rather than adopting another runtime and database.
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(Number(url.port), url.hostname, resolve); });
  await new Promise<void>(resolve => probe.close(() => resolve()));
  await mkdir(options.dataDirectory, { recursive: true });
  const logPath = join(options.dataDirectory, "service.log"), log = await open(logPath, "a", 0o600);
  const child = spawn(options.python, ["-m", "uvicorn", "staffdeck_sop_runtime.execution_api_v4:app_factory", "--factory",
    "--host", url.hostname, "--port", url.port], {
    cwd: options.dataDirectory, env: { ...options.env, PYTHONPATH: undefined, SOP_V4_HOST_TOKEN: options.token,
      SOP_V4_DB: join(options.dataDirectory, "runtime.sqlite"), SOP_V4_MAX_CONCURRENCY: String(options.maxConcurrency ?? 32) },
    stdio: ["ignore", log.fd, log.fd],
  });
  let failure: Error | undefined, exited = false;
  const exit = new Promise<void>(resolve => {
    child.once("error", error => { failure = error; });
    child.once("close", code => { exited = true; failure ??= new Error(`SOP v4 exited ${code}; see ${logPath}`); resolve(); });
  });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    if (!exited) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 3000);
      await exit; clearTimeout(timer);
    }
    await log.close();
  })();
  try {
    const deadline = Date.now() + (options.startupTimeoutMs ?? 10000);
    while (Date.now() < deadline) {
      if (failure) throw failure;
      try {
        const response = await fetch(new URL("/healthz", url), { signal: AbortSignal.timeout(500) });
        const health = await response.json() as { contract?: string };
        if (response.ok && health.contract === "sop.lifecycle/v4") return { stop };
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`SOP v4 startup timeout; see ${logPath}`);
  } catch (error) { await stop(); throw error; }
}

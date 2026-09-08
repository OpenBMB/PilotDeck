import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollHealthAndReload, restartAndReload } from "./restartUi";

function healthResponse(payload: unknown = {}) {
  return {
    ok: true,
    json: async () => payload,
  } as Response;
}

function statusResponse(ok: boolean, payload: unknown = {}): Response {
  return {
    ok,
    json: async () => payload,
    clone: () => statusResponse(ok, payload),
  } as Response;
}

async function flushPromises() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe("restartUi", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
    document.title = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
  });

  it("reports restarting before calling the restart request", async () => {
    const onStatusChange = vi.fn();
    const requestRestart = vi.fn(() => {
      expect(onStatusChange).toHaveBeenCalledWith("restarting");
      return Promise.resolve(statusResponse(true));
    });

    restartAndReload(requestRestart, {
      fetchImpl: vi.fn().mockResolvedValue(healthResponse({ instanceId: "old" })),
      onStatusChange,
      setIntervalImpl: vi.fn() as unknown as typeof window.setInterval,
    });

    await flushPromises();

    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it("keeps polling while health checks fail", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ ok: false });
    const reload = vi.fn();

    pollHealthAndReload({ fetchImpl, reload });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload when health stays on the same instance", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(healthResponse({ instanceId: "same" }));
    const reload = vi.fn();

    restartAndReload(() => Promise.resolve(statusResponse(true)), { fetchImpl, reload });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads when health reports a new instance id", async () => {
    vi.useFakeTimers();
    const onStatusChange = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(healthResponse({ instanceId: "old" }))
      .mockResolvedValueOnce(healthResponse({ instanceId: "new" }));
    const reload = vi.fn();

    restartAndReload(() => Promise.resolve(statusResponse(true)), { fetchImpl, reload, onStatusChange });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(2000);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith("confirmed");
  });

  it("reloads after an unavailable-to-healthy transition when no instance marker exists", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(healthResponse());
    const reload = vi.fn();

    restartAndReload(() => Promise.resolve(statusResponse(true)), { fetchImpl, reload });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows failure and does not reload when restart is rejected", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(healthResponse({ instanceId: "old" }));
    const reload = vi.fn();
    const onStatusChange = vi.fn();

    restartAndReload(() => Promise.resolve(statusResponse(false)), { fetchImpl, reload, onStatusChange });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(4000);

    expect(reload).not.toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenCalledWith("request-rejected");
  });

  it("continues polling when restart request disconnects and reloads on a new instance", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(healthResponse({ instanceId: "old" }))
      .mockResolvedValueOnce(healthResponse({ instanceId: "new" }));
    const reload = vi.fn();

    restartAndReload(() => Promise.reject(new Error("connection closed")), { fetchImpl, reload });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(2000);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload when baseline health fails and polling later sees a marked instance without restart proof", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("baseline unavailable"))
      .mockResolvedValueOnce(healthResponse({ instanceId: "same" }));
    const reload = vi.fn();

    restartAndReload(() => Promise.resolve(statusResponse(true)), { fetchImpl, reload });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(2000);

    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads when baseline health fails but restart response identifies the previous instance", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("baseline unavailable"))
      .mockResolvedValueOnce(healthResponse({ instanceId: "old" }))
      .mockResolvedValueOnce(healthResponse({ instanceId: "new" }));
    const reload = vi.fn();

    restartAndReload(
      () => Promise.resolve(statusResponse(true, { previousInstanceId: "old" })),
      { fetchImpl, reload },
    );

    await flushPromises();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads after a post-request unavailable-to-healthy transition when no previous marker exists", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("baseline unavailable"))
      .mockRejectedValueOnce(new Error("down after request"))
      .mockResolvedValueOnce(healthResponse({ instanceId: "new" }));
    const reload = vi.fn();

    restartAndReload(() => Promise.resolve(statusResponse(true)), { fetchImpl, reload });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("times out without reloading when restart is not confirmed", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(healthResponse({ instanceId: "same" }));
    const reload = vi.fn();
    const onStatusChange = vi.fn();

    restartAndReload(
      () => Promise.resolve(statusResponse(true)),
      { fetchImpl, reload, timeoutMs: 3000, onStatusChange },
    );

    await flushPromises();
    await vi.advanceTimersByTimeAsync(4000);

    expect(reload).not.toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenCalledWith("not-confirmed");
  });

  it("times out from the full flow start when baseline health hangs", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const requestRestart = vi.fn(() => Promise.resolve(statusResponse(true)));
    const reload = vi.fn();
    const onStatusChange = vi.fn();

    restartAndReload(requestRestart, {
      fetchImpl,
      reload,
      timeoutMs: 3000,
      onStatusChange,
    });

    await vi.advanceTimersByTimeAsync(3000);

    expect(requestRestart).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenCalledWith("not-confirmed");
  });

  it("times out from the full flow start when restart request hangs", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(healthResponse({ instanceId: "old" }));
    const requestRestart = vi.fn((_context: { signal: AbortSignal }) => new Promise<Response>(() => {}));
    const reload = vi.fn();
    const onStatusChange = vi.fn();

    restartAndReload(requestRestart, {
      fetchImpl,
      reload,
      timeoutMs: 3000,
      onStatusChange,
    });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(3000);

    expect(requestRestart).toHaveBeenCalledWith(expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    expect(reload).not.toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenCalledWith("not-confirmed");
    expect((requestRestart.mock.calls[0][0] as { signal: AbortSignal }).signal.aborted).toBe(true);
  });

  it("times out when parsing the accepted restart response hangs", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(healthResponse({ instanceId: "old" }));
    const restartResponse = {
      ok: true,
      clone: () => ({
        json: () => new Promise(() => {}),
      }),
    } as Response;
    const reload = vi.fn();
    const onStatusChange = vi.fn();

    restartAndReload(() => Promise.resolve(restartResponse), {
      fetchImpl,
      reload,
      timeoutMs: 3000,
      onStatusChange,
    });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(3000);

    expect(reload).not.toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenCalledWith("not-confirmed");
  });
});

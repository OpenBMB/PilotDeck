import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollHealthAndReload, restartAndReload, showRestartSplash } from "./restartUi";

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

  it("renders the restart splash and updates the document title", () => {
    showRestartSplash({
      title: "Restarting now",
      description: "Back soon",
    });

    expect(document.title).toBe("Restarting now");
    expect(document.body.textContent).toContain("Restarting now");
    expect(document.body.textContent).toContain("Back soon");
  });

  it("shows the splash before calling the restart request", () => {
    const requestRestart = vi.fn(() => {
      expect(document.body.textContent).toContain("Restarting PilotDeck...");
      return Promise.resolve();
    });

    restartAndReload(requestRestart, {
      fetchImpl: vi.fn(),
      setIntervalImpl: vi.fn() as unknown as typeof window.setInterval,
    });

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

  it("reloads once health succeeds", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const reload = vi.fn();

    pollHealthAndReload({ fetchImpl, reload });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

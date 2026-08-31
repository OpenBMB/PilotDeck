import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopVersionCheckResult } from "../../Settings";
import { authenticatedFetch } from "../../../../utils/api";
import AboutSections from ".";

vi.mock("../../../../utils/api", () => ({
  authenticatedFetch: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const mockedFetch = vi.mocked(authenticatedFetch);

function responseJson(payload: unknown, ok = true): Response {
  return {
    ok,
    json: async () => payload,
    clone: () => responseJson(payload, ok),
  } as Response;
}

function invalidJsonResponse() {
  return {
    ok: true,
    json: async () => {
      throw new Error("invalid json");
    },
  } as unknown as Response;
}

function renderAbout(versionInfo: Partial<DesktopVersionCheckResult> = {}) {
  const defaults: DesktopVersionCheckResult = {
    mode: "web",
    hasUpdate: false,
    checkUnavailable: false,
    currentVersion: "current",
    latestVersion: null,
    latestPublishedAt: null,
    buildTime: null,
  };

  return render(
    <AboutSections
      title="About"
      versionInfo={{ ...defaults, ...versionInfo }}
      checkingVersion={false}
    />,
  );
}

describe("AboutSections web update status recovery", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
  });

  async function flushEffects() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function advancePollingInterval() {
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("restores the restart action when the previous update needs a restart", async () => {
    mockedFetch.mockResolvedValue(responseJson({
      updateInProgress: false,
      lastUpdateResult: {
        success: true,
        alreadyUpToDate: false,
        needsRestart: true,
      },
    }));

    renderAbout({ hasUpdate: false });

    expect(await screen.findByRole("button", { name: "about.restartToApply" })).toBeTruthy();
    expect(mockedFetch).toHaveBeenCalledWith("/api/update/status");
  });

  it("shows updating and polls when an update is already in progress", async () => {
    vi.useFakeTimers();
    mockedFetch.mockResolvedValue(responseJson({
      updateInProgress: true,
      lastUpdateResult: null,
    }));

    renderAbout({ hasUpdate: false });
    await flushEffects();

    const updateButton = screen.getByRole("button", { name: "about.updating" }) as HTMLButtonElement;
    expect(updateButton.disabled).toBe(true);

    await advancePollingInterval();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("switches from in-progress polling to restart when the update completes", async () => {
    vi.useFakeTimers();
    mockedFetch
      .mockResolvedValueOnce(responseJson({
        updateInProgress: true,
        lastUpdateResult: null,
      }))
      .mockResolvedValueOnce(responseJson({
        updateInProgress: false,
        lastUpdateResult: {
          success: true,
          alreadyUpToDate: false,
          needsRestart: true,
        },
      }));

    renderAbout({ hasUpdate: false });
    await flushEffects();

    const updateButton = screen.getByRole("button", { name: "about.updating" }) as HTMLButtonElement;
    expect(updateButton.disabled).toBe(true);

    await advancePollingInterval();

    expect(screen.getByRole("button", { name: "about.restartToApply" })).toBeTruthy();
  });

  it("keeps polling after a temporary status failure once update progress was observed", async () => {
    vi.useFakeTimers();
    mockedFetch
      .mockResolvedValueOnce(responseJson({
        updateInProgress: true,
        lastUpdateResult: null,
      }))
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(responseJson({
        updateInProgress: false,
        lastUpdateResult: {
          success: true,
          alreadyUpToDate: false,
          needsRestart: true,
        },
      }));

    renderAbout({ hasUpdate: false });
    await flushEffects();

    expect(screen.getByRole("button", { name: "about.updating" })).toBeTruthy();

    await advancePollingInterval();
    expect(screen.getByRole("button", { name: "about.updating" })).toBeTruthy();

    await advancePollingInterval();
    expect(screen.getByRole("button", { name: "about.restartToApply" })).toBeTruthy();
  });

  it("keeps polling after an invalid status payload once update progress was observed", async () => {
    vi.useFakeTimers();
    mockedFetch
      .mockResolvedValueOnce(responseJson({
        updateInProgress: true,
        lastUpdateResult: null,
      }))
      .mockResolvedValueOnce(invalidJsonResponse())
      .mockResolvedValueOnce(responseJson({
        updateInProgress: false,
        lastUpdateResult: {
          success: true,
          alreadyUpToDate: false,
          needsRestart: true,
        },
      }));

    renderAbout({ hasUpdate: false });
    await flushEffects();

    await advancePollingInterval();
    expect(screen.getByRole("button", { name: "about.updating" })).toBeTruthy();

    await advancePollingInterval();
    expect(screen.getByRole("button", { name: "about.restartToApply" })).toBeTruthy();
  });

  it("does not start infinite polling when the initial status request fails", async () => {
    vi.useFakeTimers();
    mockedFetch.mockRejectedValue(new Error("status unavailable"));

    renderAbout({ hasUpdate: false });
    await flushEffects();

    await advancePollingInterval();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("switches from in-progress polling to failed status when the update fails", async () => {
    vi.useFakeTimers();
    mockedFetch
      .mockResolvedValueOnce(responseJson({
        updateInProgress: true,
        lastUpdateResult: null,
      }))
      .mockResolvedValueOnce(responseJson({
        updateInProgress: false,
        lastUpdateResult: {
          success: false,
          error: "build failed",
        },
      }));

    renderAbout({ hasUpdate: false });
    await flushEffects();

    const updateButton = screen.getByRole("button", { name: "about.updating" }) as HTMLButtonElement;
    expect(updateButton.disabled).toBe(true);

    await advancePollingInterval();

    expect(screen.getByText("settingsPage.about.status.unavailable")).toBeTruthy();
  });

  it("shows the web restart waiting overlay after click", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("server restarting")));
    mockedFetch
      .mockResolvedValueOnce(responseJson({
        updateInProgress: false,
        lastUpdateResult: {
          success: true,
          alreadyUpToDate: false,
          needsRestart: true,
        },
      }))
      .mockResolvedValueOnce(responseJson({ ok: true }));

    renderAbout({ hasUpdate: false });
    await flushEffects();

    const restartButton = screen.getByRole("button", { name: "about.restartToApply" });
    vi.useFakeTimers();
    fireEvent.click(restartButton);
    await flushEffects();

    expect(screen.getByText("about.restartingTitle")).toBeTruthy();
    expect(screen.getByText("about.restartWaitingDescription")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "about.restartToApply" })).toBeNull();
    expect(mockedFetch).toHaveBeenLastCalledWith("/api/update/restart", expect.objectContaining({
      method: "POST",
      suppressServerErrorToast: true,
      signal: expect.any(AbortSignal),
    }));
  });

  it("does not restore the restart button when the restart request disconnects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("server restarting")));
    mockedFetch
      .mockResolvedValueOnce(responseJson({
        updateInProgress: false,
        lastUpdateResult: {
          success: true,
          alreadyUpToDate: false,
          needsRestart: true,
        },
      }))
      .mockRejectedValueOnce(new Error("connection closed"));

    renderAbout({ hasUpdate: false });
    await flushEffects();

    const restartButton = screen.getByRole("button", { name: "about.restartToApply" });
    vi.useFakeTimers();
    fireEvent.click(restartButton);

    await flushEffects();

    expect(screen.getByText("about.restartingTitle")).toBeTruthy();
    expect(screen.getByText("about.restartWaitingDescription")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "about.restartToApply" })).toBeNull();
    expect(mockedFetch).toHaveBeenLastCalledWith("/api/update/restart", expect.objectContaining({
      method: "POST",
      suppressServerErrorToast: true,
      signal: expect.any(AbortSignal),
    }));
  });

  it("shows manual restart guidance when restart confirmation times out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("server unavailable")));
    mockedFetch
      .mockResolvedValueOnce(responseJson({
        updateInProgress: false,
        lastUpdateResult: {
          success: true,
          alreadyUpToDate: false,
          needsRestart: true,
        },
      }))
      .mockResolvedValueOnce(responseJson({
        status: "accepted",
        restartMode: "supervisor",
      }));

    renderAbout({ hasUpdate: false });
    await flushEffects();

    const restartButton = screen.getByRole("button", { name: "about.restartToApply" });
    vi.useFakeTimers();
    fireEvent.click(restartButton);
    await flushEffects();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(screen.getByText("about.restartFailedTitle")).toBeTruthy();
    expect(screen.getByText("about.restartFailedDescription")).toBeTruthy();
    expect(screen.getByRole("button", { name: "about.refreshPage" })).toBeTruthy();
  });
});

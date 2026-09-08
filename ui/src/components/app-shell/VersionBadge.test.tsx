import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restartAndReload } from "../../utils/restartUi";
import { VersionBadge } from "./VersionBadge";

const triggerRestart = vi.fn();
const triggerUpdate = vi.fn();
const fetchVersion = vi.fn();

vi.mock("../../utils/restartUi", () => ({
  restartAndReload: vi.fn(),
}));

vi.mock("../../hooks/useGitVersion", () => ({
  useGitVersion: () => ({
    info: {
      commitSha: "abc1234",
      branch: "main",
      hasUpdate: true,
      behindCount: 1,
      newCommits: ["new commit"],
      currentCommit: "abc1234",
      remoteHead: "def5678",
      checkUnavailable: false,
    },
    loading: false,
    triggerUpdate,
    triggerRestart,
    fetchVersion,
  }),
}));

describe("VersionBadge", () => {
  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("uses the shared restart helper after a successful update", async () => {
    triggerUpdate.mockResolvedValue({ success: true, lines: ["updated"] });

    render(<VersionBadge />);

    fireEvent.click(screen.getByRole("button", { name: /abc1234/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Update Now" }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Restart to Apply" }));

    expect(restartAndReload).toHaveBeenCalledTimes(1);
    expect(restartAndReload).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ onStatusChange: expect.any(Function) }),
    );
  });

  it("passes the restart response through to the shared helper", async () => {
    const restartResponse = { ok: false, status: 500 } as Response;
    triggerUpdate.mockResolvedValue({ success: true, lines: ["updated"] });
    triggerRestart.mockResolvedValue(restartResponse);

    render(<VersionBadge />);

    fireEvent.click(screen.getByRole("button", { name: /abc1234/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Update Now" }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Restart to Apply" }));

    const requestRestart = vi.mocked(restartAndReload).mock.calls[0][0];
    const signal = new AbortController().signal;
    await expect(requestRestart({ signal })).resolves.toBe(restartResponse);
    expect(triggerRestart).toHaveBeenCalledWith({ signal });
  });

  it("shows a restart waiting overlay after clicking restart", async () => {
    triggerUpdate.mockResolvedValue({ success: true, lines: ["updated"] });

    render(<VersionBadge />);

    fireEvent.click(screen.getByRole("button", { name: /abc1234/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Update Now" }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Restart to Apply" }));

    const options = vi.mocked(restartAndReload).mock.calls[0][1];
    expect(options).toBeTruthy();
    act(() => {
      options!.onStatusChange?.("restarting");
    });

    expect(screen.getByText("Restarting PilotDeck")).toBeTruthy();
    expect(screen.getByText("Restart may take a little while. Please wait.")).toBeTruthy();
  });

  it("switches the restart overlay to manual restart guidance when rejected", async () => {
    triggerUpdate.mockResolvedValue({ success: true, lines: ["updated"] });

    render(<VersionBadge />);

    fireEvent.click(screen.getByRole("button", { name: /abc1234/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Update Now" }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Restart to Apply" }));

    const options = vi.mocked(restartAndReload).mock.calls[0][1];
    expect(options).toBeTruthy();
    act(() => {
      options!.onStatusChange?.("request-rejected");
    });

    expect(screen.getByText("Automatic restart ran into a problem")).toBeTruthy();
    expect(screen.getByText("Restart PilotDeck manually from the command line, then refresh this page.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });
});

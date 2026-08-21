import { act, fireEvent, render, screen } from "@testing-library/react";
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
    expect(restartAndReload).toHaveBeenCalledWith(expect.any(Function));
  });
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import DesktopBuildInfo from "./DesktopBuildInfo";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
afterEach(() => { cleanup(); delete window.pilotdeckDesktop; vi.restoreAllMocks(); });
it("shows local build metadata and copies diagnostic information without checking updates", async () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  window.pilotdeckDesktop = { getAboutInfo: async () => ({ version: "2026.930.0-local", platform: "macOS", osRelease: "25.0", arch: "arm64", buildTime: "2026-09-30T04:00:00Z", commitSha: "abcdef123456789", versions: { electron: "42.0", chrome: "148", node: "22" }, license: "AGPL-3.0-only", projectWebsite: "https://github.com/OpenBMB/PilotDeck", versionInformation: "diagnostic info" }) } as any;
  render(<DesktopBuildInfo currentVersion="old" />);
  expect(await screen.findByText("macOS 25.0 (arm64)")).toBeTruthy();
  expect(screen.getByText("abcdef123456")).toBeTruthy(); expect(screen.getByText("Chromium")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "settingsPage.about.copyInfo" }));
  expect(await screen.findByRole("button", { name: "settingsPage.about.copied" })).toBeTruthy();
  expect(copy).toHaveBeenCalledWith("diagnostic info");
});
it("keeps the version/license/links available in older shells with no metadata bridge", () => {
  render(<DesktopBuildInfo currentVersion="test" />);
  expect(screen.getByText("test")).toBeTruthy(); expect(screen.getByText("AGPL-3.0-only")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

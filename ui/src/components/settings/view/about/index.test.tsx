import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AboutSections from ".";
import type { DesktopVersionCheckResult } from "../../version";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => cleanup());

describe("Web About page", () => {
  const versionInfo: DesktopVersionCheckResult = {
    mode: "web",
    hasUpdate: false,
    checkUnavailable: false,
    currentVersion: "v2026.09.23",
    latestVersion: null,
    latestPublishedAt: null,
    buildTime: null,
  };

  it("shows the local version and official Releases link without an update action", () => {
    render(<AboutSections title="About" versionInfo={versionInfo} checkingVersion={false} />);
    expect(screen.getByText("v2026.09.23")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://github.com/OpenBMB/PilotDeck/releases/latest");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

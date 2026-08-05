// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CodexAuthControl from "./CodexAuthControl";

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock("../../utils/api", () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.translate }),
}));

describe("CodexAuthControl", () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockImplementation(async (url: string) => {
      if (url === "/api/codex-auth/status") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            authenticated: false,
            importAvailable: false,
          }),
        };
      }
      if (url === "/api/codex-auth/device/start") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            state: "device-state",
            userCode: "ABCD-EFGH",
            verificationUrl: "https://auth.openai.com/codex/device",
            intervalMs: 5_000,
            expiresAt: Date.now() + 900_000,
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the device code before the user opens ChatGPT sign-in", async () => {
    const openSpy = vi.spyOn(window, "open");
    render(<CodexAuthControl />);

    await waitFor(() => {
      expect(mocks.authenticatedFetch).toHaveBeenCalledWith("/api/codex-auth/status");
    });

    fireEvent.click(screen.getByRole("button", {
      name: "pilotDeckConfig.panels.models.codexAuth.signIn",
    }));

    await waitFor(() => {
      expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
    });
    expect(openSpy).not.toHaveBeenCalled();

    const signInLink = screen.getByRole("link", {
      name: /pilotDeckConfig\.panels\.models\.codexAuth\.openSignIn/,
    });
    expect(signInLink.getAttribute("href")).toBe("https://auth.openai.com/codex/device");
    expect(signInLink.getAttribute("target")).toBe("_blank");
  });
});

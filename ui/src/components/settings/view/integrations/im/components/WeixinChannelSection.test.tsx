import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WeixinChannelSection from "./WeixinChannelSection";

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
}));

vi.mock("../../../../../../utils/api", () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("WeixinChannelSection", () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("starts a fresh QR session before polling for its result", async () => {
    mocks.authenticatedFetch.mockResolvedValue({
      json: async () => ({ ok: false, error: "QR session unavailable" }),
    });

    render(
      <WeixinChannelSection
        status={{
          enabled: false,
          hasCredentials: false,
          accountId: null,
        }}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "gateway.weixin.qrLogin" }),
    );

    await waitFor(() => {
      expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
        "/api/gateway/weixin/qr-begin",
        { method: "POST" },
      );
    });
    expect(
      mocks.authenticatedFetch.mock.calls.some(
        ([url]) => url === "/api/gateway/weixin/qr",
      ),
    ).toBe(false);
  });

  it("resumes an in-flight QR session from gateway runtime state", async () => {
    mocks.authenticatedFetch.mockResolvedValue({
      json: async () => ({
        pending: true,
        qrUrl: "https://example.test/existing-qr",
        runtime: {
          state: "waiting_for_login",
          qrUrl: "https://example.test/existing-qr",
          updatedAt: "2026-07-23T05:00:00.000Z",
        },
      }),
    });

    render(
      <WeixinChannelSection
        status={{
          enabled: true,
          hasCredentials: false,
          accountId: null,
          runtime: {
            state: "waiting_for_login",
            qrUrl: "https://example.test/existing-qr",
            updatedAt: "2026-07-23T05:00:00.000Z",
          },
        }}
        onSaved={vi.fn(async () => null)}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByAltText("WeChat QR Code").getAttribute("src"),
      ).toContain("existing-qr");
    });
    expect(
      screen.getAllByText("gateway.weixin.waitingForLogin"),
    ).toHaveLength(2);
    expect(
      mocks.authenticatedFetch.mock.calls.some(
        ([url]) => url === "/api/gateway/weixin/qr-begin",
      ),
    ).toBe(false);

    fireEvent.click(
      screen.getByRole("button", { name: "gateway.cancel" }),
    );
    expect(screen.queryByAltText("WeChat QR Code")).toBeNull();
    expect(
      screen.getByRole("button", { name: "gateway.weixin.relogin" }),
    ).toBeTruthy();
  });

  it("ignores a terminal runtime result left over from an older QR request", async () => {
    vi.useFakeTimers();
    mocks.authenticatedFetch
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          requestedAt: "2026-07-23T05:00:00.000Z",
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          ok: false,
          error: "stale failure",
          runtime: { updatedAt: "2026-07-22T05:00:00.000Z" },
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          pending: true,
          qrUrl: "https://example.test/fresh-qr",
          runtime: { updatedAt: "2026-07-23T05:00:01.000Z" },
        }),
      });

    render(
      <WeixinChannelSection
        status={{
          enabled: false,
          hasCredentials: false,
          accountId: null,
        }}
        onSaved={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "gateway.weixin.qrLogin" }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(screen.queryByText("stale failure")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(
      screen.getByAltText("WeChat QR Code").getAttribute("src"),
    ).toContain("fresh-qr");
  });
});

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "../../../../../../utils/api";
import type { GatewayStatus } from "../types";
import { useGatewayStatus } from "./useGatewayStatus";

vi.mock("../../../../../../utils/api", () => ({
  authenticatedFetch: vi.fn(),
}));

const mockedFetch = vi.mocked(authenticatedFetch);

function gatewayStatus(
  runtime: GatewayStatus["weixin"]["runtime"],
): GatewayStatus {
  return {
    feishu: {
      enabled: false,
      appId: "",
      hasSecret: false,
      connectionMode: "stream",
      domainName: "feishu",
    },
    weixin: {
      enabled: true,
      hasCredentials: runtime?.state === "connected",
      accountId: runtime?.state === "connected" ? "wx-account" : null,
      runtime,
    },
    wecom: {
      enabled: false,
      botId: "",
      hasSecret: false,
      websocketUrl: "",
      dmPolicy: "open",
      groupPolicy: "disabled",
      allowFrom: [],
      groupAllowFrom: [],
    },
  };
}

async function flushAsyncEffects() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("useGatewayStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps refreshing while Weixin login is starting or waiting", async () => {
    mockedFetch
      .mockResolvedValueOnce({
        json: async () => gatewayStatus({
          state: "waiting_for_login",
          qrUrl: "https://example.test/qr",
        }),
      } as Response)
      .mockResolvedValueOnce({
        json: async () => gatewayStatus({
          state: "connected",
          accountId: "wx-account",
        }),
      } as Response);

    const { result } = renderHook(() => useGatewayStatus());
    await act(flushAsyncEffects);

    expect(result.current.loading).toBe(false);
    expect(result.current.status?.weixin.runtime?.state).toBe(
      "waiting_for_login",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(result.current.status?.weixin.runtime?.state).toBe("connected");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});

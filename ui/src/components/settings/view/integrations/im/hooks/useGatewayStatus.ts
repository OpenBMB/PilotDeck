import { useCallback, useEffect, useState } from "react";
import { authenticatedFetch } from "../../../../../../utils/api";
import type { GatewayStatus } from "../types";

type FetchGatewayStatusOptions = { showLoading?: boolean };
export type RefreshGatewayStatus = (
  options?: FetchGatewayStatusOptions,
) => Promise<GatewayStatus | null>;

export function useGatewayStatus() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback<RefreshGatewayStatus>(async ({
    showLoading = false,
  } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const res = await authenticatedFetch("/api/gateway/status");
      const data = await res.json();
      setStatus(data);
      return data;
    } catch {
      if (showLoading) setStatus(null);
      return null;
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus({ showLoading: true });
  }, [fetchStatus]);

  const weixinState = status?.weixin?.runtime?.state;
  // Token channels start in the background after a save; keep polling until
  // they report connected/failed so the summary line settles by itself.
  const tokenChannelPending = (["slack", "telegram"] as const).some((key) => {
    const channel = status?.[key];
    if (!channel?.enabled) return false;
    const state = channel.runtime?.state;
    return !state || state === "starting" || state === "stopped";
  });

  useEffect(() => {
    const weixinWaiting = weixinState === "starting" || weixinState === "waiting_for_login";
    if (!weixinWaiting && !tokenChannelPending) {
      return undefined;
    }
    let polls = 0;
    const timer = window.setInterval(() => {
      void fetchStatus();
      // WeChat login waits on a human scan; token channels settle quickly.
      if (!weixinWaiting && ++polls >= 20) window.clearInterval(timer);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [fetchStatus, weixinState, tokenChannelPending]);

  return { status, loading, refresh: fetchStatus };
}

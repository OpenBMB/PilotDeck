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

  useEffect(() => {
    const state = status?.weixin?.runtime?.state;
    if (state !== "starting" && state !== "waiting_for_login") {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void fetchStatus();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [fetchStatus, status?.weixin?.runtime?.state]);

  return { status, loading, refresh: fetchStatus };
}

import { useCallback, useEffect, useState } from "react";
import { authenticatedFetch } from "../../../../../../utils/api";
import type { GatewayStatus } from "../types";

export function useGatewayStatus() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authenticatedFetch("/api/gateway/status");
      const data = await res.json();
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  return { status, loading, refresh: fetchStatus };
}

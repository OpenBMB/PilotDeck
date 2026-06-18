/**
 * APEX Router Bridge — HTTP client for APEX Φ scoring service
 */
const APEX_BRIDGE_URL = "http://127.0.0.1:18765/score";

export class ApexRouterBridge {
  get id() { return "apex-phi-router"; }

  async decide(input) {
    console.log("[apex-router] decide called, sessionId:", input.sessionId);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      const resp = await fetch(APEX_BRIDGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: input.sessionId,
          isMainAgent: input.isMainAgent,
          messages: input.request?.messages ?? [],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      console.log("[apex-router] response status:", resp.status);
      if (!resp.ok) return undefined;
      const data = await resp.json();
      console.log("[apex-router] data:", JSON.stringify(data));
      return data;
    } catch (err) {
      console.error("[apex-router] error:", err.message);
      return undefined;
    }
  }
}

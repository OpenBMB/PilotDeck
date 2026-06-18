/**
 * APEX Φ Router — PilotDeck CustomRouter plugin contribution
 */
import { ApexRouterBridge } from "./apex_router_bridge.js";

let _instance;

export const apexRouterContribution = {
  id: "apex-phi-router",
  description: "APEX Φ formula self-evolution LLM router",
  createCustomRouter() {
    if (!_instance) _instance = new ApexRouterBridge();
    return _instance;
  },
};

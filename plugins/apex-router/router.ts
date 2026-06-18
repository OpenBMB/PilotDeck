/**
 * APEX Φ Router — PilotDeck CustomRouter plugin contribution
 */
import type { RouterContribution } from ../../../extension/contributions/RouterContribution.js;
import { ApexRouterBridge } from ./apex_router_bridge.js;

let _instance: ApexRouterBridge | undefined;

export const apexRouterContribution: RouterContribution = {
  id: apex-phi-router,
  description: APEX Φ formula self-evolution LLM router,
  createCustomRouter() {
    if (!_instance) _instance = new ApexRouterBridge();
    return _instance;
  },
};

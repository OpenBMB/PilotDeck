import type { PilotDeckCustomRouter } from "../../router/customRouter/customRouter.js";

export type RouterContribution = {
  id: string;
  description?: string;
  createCustomRouter(): PilotDeckCustomRouter;
};

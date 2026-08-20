export function getChatResponseReserveTarget(viewportHeight: number): number {
  return Math.min(520, Math.max(220, Math.round(Math.max(viewportHeight, 0) * 0.52)));
}

export function shouldKeepChatResponseReservedSpace(
  latestUserRenderIndex: number,
  isAssistantWorking: boolean,
): boolean {
  if (latestUserRenderIndex < 0) return false;
  return latestUserRenderIndex > 0 || isAssistantWorking;
}

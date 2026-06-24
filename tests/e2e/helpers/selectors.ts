/**
 * Centralized selectors so refactors don't break all tests.
 *
 * The fork button is rendered by `ForkFromHereButton` in MessageRowV2 with
 *   aria-label={tooltip}
 * where tooltip = "Fork this conversation" (enabled) | "Fork not available here" (disabled).
 *
 * User / assistant messages get role-tagged wrappers we don't have stable
 * data-testids for; we infer by counting fork-button occurrences (user) vs
 * assistant text bubbles. See helpers/session.ts for the diff logic.
 */
export const SEL = {
  // The fork button as rendered on each user message row.
  forkButton: 'button[aria-label="Fork this conversation"]',
  forkButtonDisabled: 'button[aria-label="Fork not available here"]',
  // Sidebar entry title — used by A5 to verify "Fork of …" rendering.
  sidebarFirstTitle: '[data-testid="sidebar-item-0"] [data-testid="sidebar-item-title"], [data-testid="sidebar-item-0"]',
  // Message row anchors.
  // Real DOM: <div class="chat-message" data-message-timestamp="...">
  // User rows contain a fork button; assistant rows do not.
  messageRow: '.chat-message[data-message-timestamp]',
  userMessageRow: '.chat-message[data-message-timestamp]:has(button[aria-label="Fork this conversation"])',
  assistantMessageRow: '.chat-message[data-message-timestamp]:not(:has(button[aria-label="Fork this conversation"]))',
  // Composer input for A6.
  composerInput: 'textarea[aria-label*="omposer" i], textarea[placeholder*="essage" i], textarea',
  // "Forked from …" banner (top of MessagesPaneV2 when meta.forkedFrom present).
  forkedFromBanner: '[data-testid="forked-from-banner"]',
} as const;

/**
 * Returned by helper.sessionList() — describes a sidebar row.
 */
export type SidebarEntry = {
  index: number;
  title: string;
  sessionId: string;
};
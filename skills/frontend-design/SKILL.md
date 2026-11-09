---
name: frontend-design
description: 前端界面设计原则：视觉层次、布局、色彩、间距、响应式和避免“AI 味”页面。
---

# Frontend Design

Use this skill when creating or reviewing frontend UI where visual quality matters.

## Workflow

1. Clarify the product context, target user, and page goal.
2. Establish visual hierarchy before writing code: primary action, secondary action, supporting content.
3. Choose a deliberate visual direction instead of generic gradients and cards.
4. Use consistent spacing, type scale, color tokens, border radius, shadows, and component rhythm.
5. Design responsive states, loading states, empty states, error states, and disabled states.
6. Complete the runnable preview handoff for implementation tasks unless the user requests source only or prohibits service startup:
   - Reuse an appropriate existing service, or launch the project with `task_create` and `lifecycle: "service"`. Read `task_output` for its actual URL and errors; do not background it with shell `&`.
   - When `task_preview` is available, check your owned service's exact page URL with a distinctive initial-HTML marker (for example the application title). Fix startup/content failures before claiming readiness.
   - Verify rendering and the main interaction with an available browser capability. HTTP/content checks do not execute JavaScript or establish visual correctness; report any unavailable browser check.
   - Return a clickable Markdown preview URL, actual verification results and the `taskId` for `task_stop`. Leave the requested preview running for review. Loopback is on the executing Gateway; remote or Docker clients may need forwarding. Never invent a forwarded address or stop an unrelated service.

## Review Checklist

- The page has a clear focal point and primary action.
- Components align to a consistent grid.
- Typography has enough contrast and hierarchy.
- Color is meaningful, not decorative noise.
- The UI works at common mobile/tablet/desktop widths.
- Empty/loading/error states are intentional.

## PilotDeck Migration Note

- Source inspiration: Anthropic frontend-design skill and general frontend design best practices.
- This is a PilotDeck-native draft, not a verbatim copy.


import type { TuiMessage } from "./types.js";

export type DisplayItem =
  | { type: "single"; message: TuiMessage; index: number }
  | {
      type: "tool_group";
      toolName: string;
      messages: TuiMessage[];
      startIndex: number;
      expanded: boolean;
    };

/**
 * Group 3+ consecutive tool messages with the same toolName into a single
 * display item. Display-only — does not mutate state.
 */
export function groupConsecutiveTools(messages: TuiMessage[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i]!;

    if (msg.role === "tool" && msg.toolName) {
      let j = i + 1;
      while (
        j < messages.length &&
        messages[j]!.role === "tool" &&
        (messages[j] as Extract<TuiMessage, { role: "tool" }>).toolName === msg.toolName
      ) {
        j++;
      }

      if (j - i >= 3) {
        const slice = messages.slice(i, j);
        const expanded = slice.some(
          (m) => m.role === "tool" && m.expanded,
        );
        items.push({
          type: "tool_group",
          toolName: msg.toolName,
          messages: slice,
          startIndex: i,
          expanded,
        });
        i = j;
        continue;
      }
    }

    items.push({ type: "single", message: msg, index: i });
    i++;
  }

  return items;
}

/** The live Slack/Telegram formatters support triple-backtick code fences. */
export function codeFenceContinuation(text: string): string {
  let language: string | undefined;
  let offset = 0;
  while (offset < text.length) {
    const marker = text.indexOf("```", offset);
    if (marker < 0) break;
    if (language !== undefined) {
      language = undefined;
      offset = marker + 3;
    } else {
      const newline = text.indexOf("\n", marker + 3);
      language = text.slice(marker + 3, newline < 0 ? text.length : newline).trim();
      offset = newline < 0 ? text.length : newline + 1;
    }
  }
  return language === undefined ? "" : `\`\`\`${language}\n`;
}

export function closeCodeFence(text: string): string {
  return codeFenceContinuation(text) ? `${text}\n\`\`\`` : text;
}

/** Prefer whole lines, and never cut a fence marker or its language header. */
export function codeFenceSplitPoint(text: string, limit: number): number {
  let insideFence = false;
  let split = limit;
  const newline = text.lastIndexOf("\n", limit - 1);
  if (newline >= limit / 2) split = newline + 1;
  let offset = 0;
  while (offset < split) {
    const marker = text.indexOf("```", offset);
    if (marker < 0 || marker >= split) break;
    const end = insideFence ? marker + 3 : text.indexOf("\n", marker + 3) + 1;
    if (end === 0 || end > split) {
      // An exceptionally long language header must still make progress.
      return marker > 0 ? marker : split;
    }
    insideFence = !insideFence;
    offset = end;
  }
  // A marker may itself be arriving across deltas. Keep its trailing backticks
  // with the next segment instead of sealing them into a separate message.
  while (split > 0 && text[split - 1] === "`") split -= 1;
  return split || limit;
}

/**
 * Lightweight HTML fragment validator for ask-user HTML previews.
 *
 * Not a parser — HTML5 parsers are error-recovering by spec and accept
 * almost anything. This function checks model intent (did it emit HTML?)
 * and catches the specific things we asked it not to do.
 *
 * Returns `null` on success, or a human-readable error string. Behaviour
 * E_HTML in §5.1.6 — must stay byte-for-byte identical with legacy.
 */
export function validateHtmlPreview(preview: string | undefined): string | null {
  if (preview === undefined) return null;
  if (/<\s*(html|body|!doctype)\b/i.test(preview)) {
    return "preview must be an HTML fragment, not a full document (no <html>, <body>, or <!DOCTYPE>)";
  }
  // SDK consumers typically set this via innerHTML — disallow executable/style
  // tags so a preview can't run code or restyle the host page. Inline event
  // handlers (onclick etc.) are still possible; consumers should sanitize.
  if (/<\s*(script|style)\b/i.test(preview)) {
    return "preview must not contain <script> or <style> tags. Use inline styles via the style attribute if needed.";
  }
  if (!/<[a-z][^>]*>/i.test(preview)) {
    return "preview must contain HTML (previewFormat is set to \"html\"). Wrap content in a tag like <div> or <pre>.";
  }
  return null;
}

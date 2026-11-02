// JSON embedded in an HTML script must not contain a literal closing tag.
export function inlineJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

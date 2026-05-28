import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

let _instance: Tiktoken | null = null;

export function getTokenizer(): Tiktoken {
  if (!_instance) {
    _instance = new Tiktoken(o200k_base);
  }
  return _instance;
}

/**
 * Count the number of tokens in a text string using o200k_base encoding.
 * Returns 0 for empty strings without invoking the tokenizer.
 */
export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return getTokenizer().encode(text).length;
}

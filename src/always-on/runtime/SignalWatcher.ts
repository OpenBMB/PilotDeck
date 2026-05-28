import { existsSync } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { relative } from "node:path";

export type SignalWatcherOptions = {
  projectRoot: string;
  ignoreGlobs: string[];
  debounceMs: number;
  baselineAt: Date;
  onSignal: () => void;
  onError?: (error: Error) => void;
  /** Defaults to native `fs.watch`; tests may inject a fake. */
  watchFn?: typeof watch;
  now?: () => Date;
};

/**
 * SignalWatcher debounces filesystem changes under `projectRoot` and fires
 * `onSignal` once after activity settles. Events whose path matches any
 * configured ignore-glob (gitignore-style) are dropped, including the
 * Always-On state directory itself to prevent self-excitation.
 *
 * The watcher is a thin wrapper over `fs.watch({ recursive: true })`. macOS
 * and Windows support recursive natively; on Linux this still attaches to the
 * root only, so deep changes can be missed — projects that need deep coverage
 * can layer in a polling fallback later.
 */
export class SignalWatcher {
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly globRegexps: RegExp[];

  constructor(private readonly options: SignalWatcherOptions) {
    this.globRegexps = options.ignoreGlobs.map(compileGlob);
  }

  start(): void {
    if (this.stopped || this.watcher) return;
    if (!existsSync(this.options.projectRoot)) {
      this.options.onError?.(new Error(`projectRoot not found: ${this.options.projectRoot}`));
      this.stopped = true;
      return;
    }
    const watchFn = this.options.watchFn ?? watch;
    try {
      this.watcher = watchFn(this.options.projectRoot, { recursive: true }, (_event, filename) => {
        this.handleEvent(toUtf8(filename));
      });
      this.watcher.on("error", (error) => {
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.stopped = true;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // ignore close errors; watcher may already be detached.
      }
      this.watcher = undefined;
    }
  }

  /** Public for tests. */
  handleEvent(filename: string): void {
    if (this.stopped) return;
    if (this.shouldIgnore(filename)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.stopped) {
        this.options.onSignal();
      }
    }, Math.max(0, this.options.debounceMs));
  }

  private shouldIgnore(filename: string): boolean {
    if (filename.length === 0) return true;
    const rel = relative(this.options.projectRoot, filename);
    const candidate = rel.length > 0 ? rel : filename;
    for (const re of this.globRegexps) {
      if (re.test(candidate)) return true;
    }
    return false;
  }
}

function toUtf8(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as Buffer).toString === "function") {
    return (value as Buffer).toString("utf-8");
  }
  return "";
}

function compileGlob(glob: string): RegExp {
  // Translate a small subset of gitignore-glob to a RegExp:
  //   **/  -> any path segment(s)
  //   *    -> any chars except '/'
  //   ?    -> single non-'/' char
  //   .    -> literal '.'
  // Anything else is escaped.
  let body = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          body += "(?:.*/)?";
          i += 3;
          continue;
        }
        body += ".*";
        i += 2;
        continue;
      }
      body += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      body += "[^/]";
      i += 1;
      continue;
    }
    if (/[.+^$|()\\\[\]{}/]/.test(ch)) {
      body += `\\${ch}`;
      i += 1;
      continue;
    }
    body += ch;
    i += 1;
  }
  return new RegExp(`^(?:${body})$`);
}

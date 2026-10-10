import { createRequire } from "node:module";
import { Language, Parser, type Node, type Tree } from "web-tree-sitter";

// The bash grammar ships as WASM, so loading is async. Permission checks are
// sync, so the parser is preloaded on import and callers that must classify a
// command (ToolRuntime) await `preloadBashParser()` first. Until it is ready,
// or if loading fails, `parseBash` returns undefined and callers treat the
// command as unclassifiable (never read-only).

const require = createRequire(import.meta.url);

let parser: Parser | undefined;
let loading: Promise<void> | undefined;

export function preloadBashParser(): Promise<void> {
  loading ??= loadParser().catch((error: unknown) => {
    console.warn(
      "[pilotdeck] Failed to load the bash grammar; every shell command will require permission.",
      error,
    );
  });
  return loading;
}

async function loadParser(): Promise<void> {
  await Parser.init({
    locateFile: () => require.resolve("web-tree-sitter/tree-sitter.wasm"),
  });
  const bash = await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"));
  const instance = new Parser();
  instance.setLanguage(bash);
  parser = instance;
}

/** Parses `command` as bash. Returns undefined when the parser is not loaded. The caller must `delete()` the tree. */
export function parseBash(command: string): Tree | undefined {
  return parser?.parse(command) ?? undefined;
}

export interface BashCommandList {
  /** Source text of every simple command, including ones nested in substitutions, subshells, and control flow. */
  commands: string[];
  hasError: boolean;
}

/**
 * Splits `command` into its simple commands, mirroring opencode's shell tool
 * (`commands()` + `source()`). Returns undefined when the parser is not loaded.
 */
export function splitBashCommands(command: string): BashCommandList | undefined {
  const tree = parseBash(command);
  if (!tree) {
    return undefined;
  }
  try {
    const commands = tree.rootNode
      .descendantsOfType("command")
      .filter((node): node is Node => node !== null)
      .map(bashCommandSource);
    return { commands, hasError: tree.rootNode.hasError };
  } finally {
    tree.delete();
  }
}

/** A command's text including its redirections. */
export function bashCommandSource(node: Node): string {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim();
}

void preloadBashParser();

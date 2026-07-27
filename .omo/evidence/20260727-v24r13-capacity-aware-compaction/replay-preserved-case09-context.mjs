import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeRoot, sessionPath] = process.argv.slice(2);
if (!runtimeRoot || !sessionPath) {
  throw new Error("usage: node replay-preserved-case09-context.mjs <runtime-root> <session-jsonl>");
}

const importFromRuntime = (relativePath) => import(pathToFileURL(resolve(runtimeRoot, relativePath)).href);
const { CompactionEngine } = await importFromRuntime("dist/src/context/compaction/CompactionEngine.js");
const { TokenBudgetManager } = await importFromRuntime("dist/src/context/budget/TokenBudgetManager.js");
const { collectToolCallIds, collectToolResultIds } = await importFromRuntime(
  "dist/src/context/compaction/toolPairIntegrity.js",
);

const entries = (await readFile(sessionPath, "utf8"))
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const messages = entries.flatMap((entry) => {
  if (entry.type === "accepted_input" && Array.isArray(entry.messages)) return entry.messages;
  if ((entry.type === "assistant_message" || entry.type === "tool_result_message") && entry.message) {
    return [entry.message];
  }
  return [];
});

const requests = [];
const tokenBudget = new TokenBudgetManager();
const engine = new CompactionEngine({
  provider: "preserved-replay",
  model_: "preserved-replay",
  tokenBudget,
  maxProtectedPrefixTurns: 8,
  model: {
    async *stream(request) {
      requests.push(request);
      yield {
        type: "text_delta",
        text: "## Objective\nPreserved replay\n## Current State\nMeasured\n## Remaining\nNone\n## Files And Artifacts\nNone",
      };
    },
  },
});

const keepRatio = 0.35;
const result = await engine.run({ trigger: "auto", messages, keepTailRatio: keepRatio });
const summarizedMessages = requests[0]?.messages.slice(0, -1) ?? [];
const totalTokens = tokenBudget.estimateMessagesTokens(messages);
const retainedTokens = tokenBudget.estimateMessagesTokens(result.messagesToKeep);
const summaryInputTokens = tokenBudget.estimateMessagesTokens(summarizedMessages);
const summarizedCalls = collectToolCallIds(summarizedMessages);
const summarizedResults = collectToolResultIds(summarizedMessages);
const retainedCalls = collectToolCallIds(result.messagesToKeep);
const retainedResults = collectToolResultIds(result.messagesToKeep);
const newestToolCallId = [...collectToolCallIds(messages)].at(-1);

const countAgentCalls = (candidateMessages) => candidateMessages.reduce(
  (count, message) => count + message.content.filter(
    (block) => block.type === "tool_call" && ["agent", "Agent", "Task"].includes(block.name),
  ).length,
  0,
);
const setsEqual = (left, right) => left.size === right.size && [...left].every((value) => right.has(value));

console.log(JSON.stringify({
  schemaVersion: 1,
  sanitization: {
    sourceContentEmitted: false,
    promptContentEmitted: false,
    reasoningEmitted: false,
    credentialsEmitted: false,
    toolCallIdsEmitted: false,
  },
  totalMessages: messages.length,
  totalTokens,
  keepRatio,
  keepTargetTokens: Math.floor(totalTokens * keepRatio),
  retainedMessages: result.messagesToKeep.length,
  retainedTokens,
  retainedRatio: retainedTokens / totalTokens,
  projectedPostTokens: result.postTokens,
  summarizedMessages: summarizedMessages.length,
  summaryInputTokens,
  summarizedAgentCalls: countAgentCalls(summarizedMessages),
  retainedAgentCalls: countAgentCalls(result.messagesToKeep),
  summarizedPairsComplete: setsEqual(summarizedCalls, summarizedResults),
  retainedPairsComplete: setsEqual(retainedCalls, retainedResults),
  newestToolPairRetained: newestToolCallId !== undefined
    && retainedCalls.has(newestToolCallId)
    && retainedResults.has(newestToolCallId),
}, null, 2));

import test from "node:test";
import assert from "node:assert/strict";

import {
  AutoCompactionPolicy,
  buildPostCompactMessages,
  CompactionEngine,
  DefaultContextRuntime,
  MicroCompactionEngine,
  TokenBudgetManager,
  type TokenBudgetSnapshot,
} from "../../src/context/index.js";
import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
} from "../../src/model/index.js";

test("full compaction can disable protected turn preservation", async () => {
  const summaryRequests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    model: {
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        summaryRequests.push(request);
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "## Objective\nKeep going.\n\n## Current State\nTool result is available.\n\n## Remaining\nContinue.\n\n## Files And Artifacts\nNone." };
        yield { type: "message_end", finishReason: "stop" };
      },
    },
    provider: "local",
    model_: "local-chat",
  });

  const result = await engine.run({
    trigger: "auto",
    messages: compactFixture(),
    keepTailRatio: 0.2,
    protectedToolNames: null,
  });

  assert.equal(summaryRequests.length, 1);
  assert.ok(summaryRequests[0]!.messages.some((message) =>
    message.content.some((block) => block.type === "tool_call" && block.name === "Task")
  ));
  assert.equal(hasThinking(summaryRequests[0]!.messages), true);
  assert.deepEqual(summaryRequests[0]!.cacheBreakpoints, []);
  assert.match(summaryRequests[0]!.systemPrompt ?? "", /Summarize the conversation so far as a concise Markdown checkpoint handoff/);
  assert.match(summaryRequests[0]!.systemPrompt ?? "", /## Objective/);
  const prompt = summaryPromptText(summaryRequests[0]!);
  assert.match(prompt, /^Produce the Markdown handoff now\./);
  assert.match(prompt, /<compact-summary-anchors>/);
  assert.match(prompt, /"toolName":"Task"/);
  assert.match(prompt, /"toolName":"read_skill"/);
  assert.match(prompt, /task output/);
  assert.match(prompt, /skills\/pdf\/SKILL\.md/);
  assert.doesNotMatch(prompt, /private protected reasoning|native protected reasoning/);
  assert.doesNotMatch(prompt, /## Objective/);
  assert.equal(hasToolCall(result.messagesToKeep, "Task"), false);
  assert.equal(hasToolResult(result.messagesToKeep, "task-1"), false);
  assert.equal(hasToolCall(result.messagesToKeep, "read_skill"), false);
  assert.equal(hasToolResultReference(result.messagesToKeep, "skill-1"), false);
  assert.equal(hasToolCall(buildPostCompactMessages(result), "Task"), false);
  assert.match(summaryText(result.summaryMessage), /^\[CONTEXT COMPACTION - REFERENCE ONLY\]/);
  assert.match(summaryText(result.summaryMessage), /END OF CONTEXT SUMMARY/);
});

test("auto full compaction retries without protected turns when protected output still blocks", async () => {
  const summaryRequests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    model: {
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        summaryRequests.push(request);
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "## Objective\nKeep going.\n\n## Current State\nProtected tool output was summarized.\n\n## Remaining\nContinue.\n\n## Files And Artifacts\nNone." };
        yield { type: "message_end", finishReason: "stop" };
      },
    },
    provider: "local",
    model_: "local-chat",
  });
  const tokenBudget = new TokenBudgetManager();
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    maxContextTokens: 100,
  });

  const result = await runtime.tryAutoCompact({
    messages: compactFixture(),
    budgetEvaluator: (candidate) => Promise.resolve(fakeSnapshot(candidate, tokenBudget)),
  });

  assert.equal(result.type, "compacted");
  assert.equal(summaryRequests.length, 2);
  assert.equal(hasToolCall(summaryRequests[0]!.messages, "Task"), false);
  assert.equal(hasToolCall(summaryRequests[1]!.messages, "Task"), true);
  assert.equal(hasThinking(summaryRequests[0]!.messages), true);
  assert.equal(hasThinking(summaryRequests[1]!.messages), true);
  assert.deepEqual(summaryRequests[1]!.cacheBreakpoints, []);
  assert.match(summaryRequests[1]!.systemPrompt ?? "", /## Objective/);
  const relaxedPrompt = summaryPromptText(summaryRequests[1]!);
  assert.match(relaxedPrompt, /^Produce the Markdown handoff now\./);
  assert.match(relaxedPrompt, /<compact-summary-anchors>/);
  assert.match(relaxedPrompt, /"toolName":"Task"/);
  assert.match(relaxedPrompt, /"toolName":"read_skill"/);
  assert.match(relaxedPrompt, /task output/);
  assert.match(relaxedPrompt, /skills\/pdf\/SKILL\.md/);
  assert.doesNotMatch(relaxedPrompt, /private protected reasoning|native protected reasoning/);
  assert.doesNotMatch(relaxedPrompt, /## Objective/);
  assert.equal(hasToolCall(result.messages, "Task"), false);
  assert.equal(hasToolResult(result.messages, "task-1"), false);
  assert.equal(hasToolCall(result.messages, "read_skill"), false);
  assert.equal(hasToolResultReference(result.messages, "skill-1"), false);
});

test("auto full compaction keeps the best compacted result even when it still blocks", async () => {
  const summaryRequests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    model: {
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        summaryRequests.push(request);
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "## Objective\nKeep going.\n\n## Current State\nStill compacting.\n\n## Remaining\nContinue.\n\n## Files And Artifacts\nNone." };
        yield { type: "message_end", finishReason: "stop" };
      },
    },
    provider: "local",
    model_: "local-chat",
  });
  const tokenBudget = new TokenBudgetManager();
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    maxContextTokens: 100,
  });

  const result = await runtime.tryAutoCompact({
    messages: compactFixture(),
    budgetEvaluator: (candidate) => Promise.resolve(
      tokenBudget.snapshotFromTokens(hasToolCall(candidate, "Task") ? 130 : 120, 100),
    ),
  });

  assert.equal(result.type, "compacted");
  assert.equal(summaryRequests.length, 2);
  assert.equal(result.snapshot.state, "blocking");
  assert.equal(hasToolCall(result.messages, "Task"), false);
  assert.equal(hasToolCall(result.messages, "read_skill"), false);
  assert.match(summaryText(result.result?.summaryMessage), /^\[CONTEXT COMPACTION - REFERENCE ONLY\]/);
});

test("token-budget tail protection keeps the last turn group intact", async () => {
  const summaryRequests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    model: {
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        summaryRequests.push(request);
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "## Objective\nKeep going.\n\n## Current State\nToken tail selected.\n\n## Remaining\nContinue.\n\n## Files And Artifacts\nNone." };
        yield { type: "message_end", finishReason: "stop" };
      },
    },
    provider: "local",
    model_: "local-chat",
  });

  const result = await engine.run({
    trigger: "auto",
    messages: tokenTailFixture(),
    keepTailRatio: 0.05,
  });

  assert.equal(summaryRequests.length, 1);
  assert.equal(hasToolCall(summaryRequests[0]!.messages, "tail-tool"), false);
  assert.equal(hasToolResult(summaryRequests[0]!.messages, "tail-tool"), false);
  assert.equal(hasToolCall(result.messagesToKeep, "tail-tool"), true);
  assert.equal(hasToolResult(result.messagesToKeep, "tail-tool"), true);
  assert.match(summaryText(result.summaryMessage), /^\[CONTEXT COMPACTION - REFERENCE ONLY\]/);
  assert.match(summaryText(result.summaryMessage), /END OF CONTEXT SUMMARY/);
});

test("auto full compaction summarizes older tool groups inside one user task", async () => {
  const summaryRequests: CanonicalModelRequest[] = [];
  const events: Array<{ type: string }> = [];
  const engine = new CompactionEngine({
    model: {
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        summaryRequests.push(request);
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "## Objective\nKeep going.\n\n## Current State\nOlder tool groups were summarized.\n\n## Remaining\nContinue.\n\n## Files And Artifacts\nNone." };
        yield { type: "message_end", finishReason: "stop" };
      },
    },
    provider: "local",
    model_: "local-chat",
    eventEmitter: (event) => events.push(event),
  });
  const tokenBudget = new TokenBudgetManager();
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    maxContextTokens: 100,
  });

  const result = await runtime.tryAutoCompact({
    messages: singleUserToolChainFixture(),
    budgetEvaluator: (candidate) => Promise.resolve(
      tokenBudget.snapshotFromTokens(hasCompactSummary(candidate) ? 20 : 500, 100),
    ),
  });

  assert.equal(result.type, "compacted");
  assert.equal(result.tier, "full");
  assert.equal(summaryRequests.length, 1);
  assert.ok(findToolCall(summaryRequests[0]!.messages, "old-search-0"));
  assert.equal(findToolCall(summaryRequests[0]!.messages, "tail-fetch"), undefined);
  assert.ok(findToolCall(result.messages, "tail-fetch"));
  assert.equal(findToolResult(result.messages, "old-search-0"), undefined);
  assert.match(summaryText(result.result?.summaryMessage), /^\[CONTEXT COMPACTION - REFERENCE ONLY\]/);
  assert.deepEqual(events.map((event) => event.type), ["compact_started", "compact_completed"]);
});

test("blocking auto compaction continues to full summary when micro pruning only reaches warning", async () => {
  const summaryRequests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    model: {
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        summaryRequests.push(request);
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "## Objective\nKeep going.\n\n## Current State\nMicro-pruned output was summarized.\n\n## Remaining\nContinue.\n\n## Files And Artifacts\nNone." };
        yield { type: "message_end", finishReason: "stop" };
      },
    },
    provider: "local",
    model_: "local-chat",
  });
  const tokenBudget = new TokenBudgetManager();
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    microCompaction: new MicroCompactionEngine({ keepLatest: 1 }),
    maxContextTokens: 100,
  });

  const result = await runtime.tryAutoCompact({
    messages: singleUserToolChainFixture(),
    budgetEvaluator: (candidate) => {
      if (hasCompactSummary(candidate)) {
        return Promise.resolve(tokenBudget.snapshotFromTokens(20, 100));
      }
      if (hasMicroCompactMarker(candidate)) {
        return Promise.resolve(tokenBudget.snapshotFromTokens(85, 100));
      }
      return Promise.resolve(tokenBudget.snapshotFromTokens(500, 100));
    },
  });

  assert.equal(result.type, "compacted");
  assert.equal(result.tier, "full");
  assert.equal(summaryRequests.length, 1);
  assert.match(summaryText(result.result?.summaryMessage), /^\[CONTEXT COMPACTION - REFERENCE ONLY\]/);
});

test("summary failures fall back deterministically and cool down subsequent summary calls", async () => {
  const summaryRequests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    model: {
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        summaryRequests.push(request);
        throw new Error("summary backend down");
      },
    },
    provider: "local",
    model_: "local-chat",
  });
  const tokenBudget = new TokenBudgetManager();
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    maxContextTokens: 100,
  });

  const first = await runtime.tryAutoCompact({
    messages: compactFixture(),
    budgetEvaluator: (candidate) => Promise.resolve(fakeSnapshot(candidate, tokenBudget)),
  });

  assert.equal(first.type, "compacted");
  assert.match(first.result?.error ?? "", /summary backend down/);
  assert.match(summaryText(first.result?.summaryMessage), /^\[CONTEXT COMPACTION - REFERENCE ONLY\]/);
  assert.match(summaryText(first.result?.summaryMessage), /## Objective/);
  assert.match(summaryText(first.result?.summaryMessage), /private summarized reasoning/);
  assert.match(summaryText(first.result?.summaryMessage), /Task|read_skill/);

  const second = await runtime.tryAutoCompact({
    messages: compactFixture(),
    budgetEvaluator: (candidate) => Promise.resolve(fakeSnapshot(candidate, tokenBudget)),
  });

  assert.equal(second.type, "compacted");
  assert.equal(summaryRequests.length, 1);
  assert.match(summaryText(second.result?.summaryMessage), /^\[CONTEXT COMPACTION - REFERENCE ONLY\]/);
});

test("summary input preserves thinking blocks from the summarized prefix", async () => {
  const summaryRequests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    model: {
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        summaryRequests.push(request);
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "## Objective\nKeep going.\n\n## Current State\nThinking preserved.\n\n## Remaining\nContinue.\n\n## Files And Artifacts\nNone." };
        yield { type: "message_end", finishReason: "stop" };
      },
    },
    provider: "local",
    model_: "local-chat",
  });

  await engine.run({
    trigger: "auto",
    messages: summarizedThinkingFixture(),
    keepTailRatio: 0.01,
  });

  assert.equal(summaryRequests.length, 1);
  assert.ok(summaryRequests[0]!.messages.some((message) =>
    message.content.some((block) => block.type === "thinking" && block.text.includes("private reasoning before the tail"))
  ));
});

test("summary input prunes stale tool outputs and oversized tool-call args", async () => {
  const summaryRequests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    model: {
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        summaryRequests.push(request);
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "## Objective\nKeep going.\n\n## Current State\nPruned input.\n\n## Remaining\nContinue.\n\n## Files And Artifacts\nNone." };
        yield { type: "message_end", finishReason: "stop" };
      },
    },
    provider: "local",
    model_: "local-chat",
  });

  await engine.run({
    trigger: "auto",
    messages: pruningFixture(),
    keepTailRatio: 0.01,
    protectedToolNames: null,
  });

  assert.equal(summaryRequests.length, 1);
  assert.equal(hasThinking(summaryRequests[0]!.messages), false);

  const firstCall = findToolCall(summaryRequests[0]!.messages, "read-1");
  assert.ok(firstCall);
  assert.match(JSON.stringify(firstCall?.input), /\.\.\.\[truncated\]/);

  const firstResult = findToolResult(summaryRequests[0]!.messages, "read-1");
  assert.ok(firstResult);
  assert.match(toolResultText(firstResult!), /\[read_file\] output for call read-1:/);
  assert.ok(toolResultText(firstResult!).length < 1_500);

  const duplicateResult = findToolResult(summaryRequests[0]!.messages, "read-2");
  assert.ok(duplicateResult);
  assert.match(toolResultText(duplicateResult!), /Duplicate tool output omitted/);
});

function compactFixture(): CanonicalMessage[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "Original task" }],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "private summarized reasoning ".repeat(200) },
        { type: "text", text: "Visible progress" },
      ],
    },
    {
      role: "user",
      content: [{ type: "text", text: "Run protected task" }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          text: "private skill reasoning ".repeat(200),
          reasoningContent: "native skill reasoning ".repeat(200),
        },
        {
          type: "tool_call",
          id: "skill-1",
          name: "read_skill",
          input: { skill: "pdf", path: "/Users/a1/.pilotdeck/skills/pdf/SKILL.md" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result_reference",
          toolCallId: "skill-1",
          path: "/Users/a1/.pilotdeck/skills/pdf/SKILL.md",
          readFilePath: "skills/pdf/SKILL.md",
          originalBytes: 4096,
          preview: "# PDF skill\nUse this skill for PDF inspection.",
          hasMore: false,
          mimeType: "text/markdown",
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "text", text: "Run protected subtask" }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          text: "private protected reasoning ".repeat(200),
          reasoningContent: "native protected reasoning ".repeat(200),
        },
        { type: "tool_call", id: "task-1", name: "Task", input: { prompt: "inspect" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "task-1",
          content: [{ type: "text", text: "task output" }],
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "text", text: "Latest user tail" }],
    },
  ];
}

function summarizedThinkingFixture(): CanonicalMessage[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "Summarize earlier work" }],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "private reasoning before the tail".repeat(20) },
        { type: "text", text: "Early progress" },
      ],
    },
    {
      role: "user",
      content: [{ type: "text", text: "Tail request" }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Tail reply" }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "Final tail user" }],
    },
  ];
}

function hasToolCall(messages: CanonicalMessage[], name: string): boolean {
  return messages.some((message) =>
    message.content.some((block) => block.type === "tool_call" && block.name === name)
  );
}

function hasToolResult(messages: CanonicalMessage[], toolCallId: string): boolean {
  return messages.some((message) =>
    message.content.some((block) => block.type === "tool_result" && block.toolCallId === toolCallId)
  );
}

function hasToolResultReference(messages: CanonicalMessage[], toolCallId: string): boolean {
  return messages.some((message) =>
    message.content.some((block) => block.type === "tool_result_reference" && block.toolCallId === toolCallId)
  );
}

function hasThinking(messages: CanonicalMessage[]): boolean {
  return messages.some((message) =>
    message.content.some((block) => block.type === "thinking")
  );
}

function summaryText(message: CanonicalMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function findToolCall(
  messages: CanonicalMessage[],
  toolCallId: string,
): Extract<CanonicalContentBlock, { type: "tool_call" }> | undefined {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_call" && block.id === toolCallId) {
        return block;
      }
    }
  }
  return undefined;
}

function findToolResult(messages: CanonicalMessage[], toolCallId: string): Extract<CanonicalContentBlock, { type: "tool_result" }> | undefined {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_result" && block.toolCallId === toolCallId) {
        return block;
      }
    }
  }
  return undefined;
}

function toolResultText(block: Extract<CanonicalContentBlock, { type: "tool_result" }>): string {
  return block.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function summaryPromptText(request: CanonicalModelRequest): string {
  const lastMessage = request.messages.at(-1);
  return lastMessage?.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n") ?? "";
}

function hasCompactSummary(messages: CanonicalMessage[]): boolean {
  return messages.some((message) =>
    message.content.some((block) =>
      block.type === "text" && block.text.includes("[CONTEXT COMPACTION - REFERENCE ONLY]")
    )
  );
}

function hasMicroCompactMarker(messages: CanonicalMessage[]): boolean {
  return messages.some((message) =>
    message.content.some((block) =>
      block.type === "tool_result" && toolResultText(block).includes("[Old tool result content compacted]")
    )
  );
}

function tokenTailFixture(): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [];
  for (let index = 0; index < 18; index += 1) {
    messages.push(
      {
        role: "user",
        content: [{ type: "text", text: `Old request ${index}: ${"context ".repeat(20)}` }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `Old reply ${index}: ${"answer ".repeat(20)}` }],
      },
    );
  }
  messages.push(
    {
      role: "user",
      content: [{ type: "text", text: "Tail request" }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "tail-tool",
          name: "tail-tool",
          input: { command: "echo tail", note: "tail ".repeat(40) },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "tail-tool",
          content: [{ type: "text", text: "tail result" }],
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Tail answer" }],
    },
  );
  return messages;
}

function singleUserToolChainFixture(): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "Solve one WCB task with searches and fetches." }],
    },
  ];
  for (let index = 0; index < 6; index += 1) {
    messages.push(
      {
        role: "assistant",
        content: [
          { type: "text", text: `Search step ${index}` },
          {
            type: "tool_call",
            id: `old-search-${index}`,
            name: "web_search",
            input: { query: `query ${index}` },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: `old-search-${index}`,
            content: [{ type: "text", text: `old search result ${index} ${"context ".repeat(80)}` }],
          },
        ],
      },
    );
  }
  messages.push(
    {
      role: "assistant",
      content: [
        { type: "text", text: "Fetch final evidence" },
        {
          type: "tool_call",
          id: "tail-fetch",
          name: "web_fetch",
          input: { url: "https://example.test/final" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "tail-fetch",
          content: [{ type: "text", text: "tail evidence" }],
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Ready to finish." }],
    },
  );
  return messages;
}

function pruningFixture(): CanonicalMessage[] {
  const longText = "RAW TOOL OUTPUT ".repeat(450);
  const longArgs = "ARGUMENT ".repeat(400);
  return [
    {
      role: "user",
      content: [{ type: "text", text: "Please read the file" }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "read-1",
          name: "read_file",
          input: { path: "/tmp/demo.txt", content: longArgs, nested: { notes: longArgs } },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "read-1",
          content: [{ type: "text", text: longText }],
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "read-2",
          name: "read_file",
          input: { path: "/tmp/demo.txt", content: "duplicate" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "read-2",
          content: [{ type: "text", text: longText }],
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "Latest tail" }],
    },
  ];
}

function fakeSnapshot(
  messages: CanonicalMessage[],
  tokenBudget: TokenBudgetManager,
): TokenBudgetSnapshot {
  return tokenBudget.snapshotFromTokens(hasToolCall(messages, "Task") ? 200 : 20, 100);
}

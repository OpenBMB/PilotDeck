/**
 * Build parity evidence from the provider-visible request, not from the
 * context-budget event. The event is the value under test and may be faulty.
 */
export function createRequestBudgetEvidence({ request, tokenBudget, observedBudget = {} }) {
  if (!request || !tokenBudget || typeof tokenBudget.estimateTextTokens !== "function") {
    throw new TypeError("request token accounting is required for budget evidence");
  }
  const systemPrompt = request.systemPrompt ?? "";
  const systemTokens = systemPrompt ? tokenBudget.estimateTextTokens(systemPrompt) : 0;
  const mcp = Math.min(systemTokens, estimateDelimitedBlocks(tokenBudget, systemPrompt, "mcp-instructions"));
  const memory = Math.min(systemTokens - mcp, estimateDelimitedBlocks(tokenBudget, systemPrompt, "memory-context"));
  const messages = tokenBudget.estimateMessagesTokens(request.messages ?? []);
  const tools = estimateToolSchemas(tokenBudget, request.tools ?? []);
  const breakdown = {
    source: "local_estimate",
    total: systemTokens + messages + tools,
    system: systemTokens - mcp - memory,
    tools,
    messages,
    mcp,
    memory,
  };
  const used = breakdown.total;
  const evidence = {
    source: "gateway_token_accounting",
    accountingContract: "TokenAccountingRuntime/o200k_base/v1",
    request,
    breakdown,
    used,
  };
  for (const field of ["used", "displayUsed", "budgetUsed"]) {
    if (observedBudget[field] !== undefined) evidence[field] = used;
  }
  return evidence;
}

function estimateToolSchemas(tokenBudget, tools) {
  return tools.reduce(
    (total, tool) => total + tokenBudget.estimateTextTokens(
      `${tool.name}${tool.description ?? ""}${safeJsonStringify(tool.inputSchema)}`,
    ),
    0,
  );
}

function estimateDelimitedBlocks(tokenBudget, text, name) {
  const open = `<${name}>`;
  const close = `</${name}>`;
  let total = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(open, cursor);
    if (start < 0) break;
    const end = text.indexOf(close, start + open.length);
    if (end < 0) break;
    total += tokenBudget.estimateTextTokens(text.slice(start, end + close.length));
    cursor = end + close.length;
  }
  return total;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}

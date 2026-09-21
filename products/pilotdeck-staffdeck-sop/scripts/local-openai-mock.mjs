import { createServer } from "node:http";

const port = Number(process.env.LOCAL_OPENAI_MOCK_PORT ?? "18092");
const sopEnabled = process.env.LOCAL_OPENAI_MOCK_SOP_ENABLED !== "false";
const mode = process.env.LOCAL_OPENAI_MOCK_MODE ?? "browser-smoke";

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", mode }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (body.stream !== true) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: '{"title":"SOP browser smoke"}' }, finish_reason: "stop" }],
    }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const messages = JSON.stringify(body.messages ?? []);
  const latestUserText = latestUserMessage(body.messages ?? []);
  if (process.env.LOCAL_OPENAI_MOCK_DEBUG === "1") {
    console.error(JSON.stringify({ mode, latestUserText, messageCount: body.messages?.length ?? 0 }));
  }
  if (latestUserText.includes("Start the ordinary PilotDeck-only workflow.")) {
    if (messages.includes("pilotdeck-only-read-file")) {
      response.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: "PilotDeck-only browser smoke completed." }, finish_reason: "stop" }],
      })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    const toolCall = {
      id: "pilotdeck-only-read-file",
      name: "read_file",
      input: { file_path: "/root/.pilotdeck/pilotdeck.yaml" },
    };
    response.write(`data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: toolCall.id,
            type: "function",
            function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) },
          }],
        },
        finish_reason: "tool_calls",
      }],
    })}\n\n`);
    response.end("data: [DONE]\n\n");
    return;
  }
  if (mode === "operator-approval") {
    const completed = latestUserText.includes("operator approved");
    const toolCall = {
      id: completed ? "operator-approval-complete" : "operator-approval-handoff",
      name: "submit_step_result",
      input: completed
        ? { status: "completed", replyFragment: "Browser operator approval completed." }
        : { status: "handoff", replyFragment: "Waiting for browser operator approval." },
    };
    response.write(`data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: toolCall.id,
            type: "function",
            function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) },
          }],
        },
        finish_reason: "tool_calls",
      }],
    })}\n\n`);
    response.end("data: [DONE]\n\n");
    return;
  }
  if (!sopEnabled && messages.includes("browser-read-file")) {
    response.write(`data: ${JSON.stringify({
      choices: [{ delta: { content: "Browser SOP-disabled tool smoke completed." }, finish_reason: "stop" }],
    })}\n\n`);
    response.end("data: [DONE]\n\n");
    return;
  }
  let toolCall;
  if (messages.includes("Browser operator approved")) {
    toolCall = {
      id: "browser-sop-complete",
      name: "submit_step_result",
      input: { status: "completed", replyFragment: "Browser SOP smoke completed." },
    };
  } else if (messages.includes("Wait for browser operator approval.")) {
    toolCall = {
      id: "browser-sop-handoff",
      name: "submit_step_result",
      input: { status: "handoff", replyFragment: "Waiting for browser operator approval." },
    };
  } else if (messages.includes("browser-read-file")) {
    toolCall = {
      id: "browser-sop-first-step",
      name: "submit_step_result",
      input: { status: "completed", replyFragment: "Browser SOP business step completed." },
    };
  } else {
    toolCall = {
      id: "browser-read-file",
      name: "read_file",
      input: { file_path: process.env.BROWSER_SMOKE_INPUT_PATH ?? "browser-smoke-input.txt" },
    };
  }
  response.write(`data: ${JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.input),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}).listen(port, "127.0.0.1", () => {
  console.log(`local OpenAI mock listening on http://127.0.0.1:${port}`);
});

function latestUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => typeof part?.text === "string" ? part.text : "")
        .join("\n");
    }
  }
  return "";
}

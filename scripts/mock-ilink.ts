import { createServer } from "node:http";

const PORT = 8976;
let messageQueue: Array<{ from_user: string; content: string; msg_id: string }> = [];
let waitingPolls: Array<{ resolve: (value: string) => void; timer: NodeJS.Timeout }> = [];

const server = createServer((req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/getupdates") {
    const timeout = parseInt(url.searchParams.get("timeout") ?? "10", 10) * 1000;

    if (messageQueue.length > 0) {
      const messages = [...messageQueue];
      messageQueue = [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ updates: messages, next_offset: String(Date.now()) }));
      return;
    }

    const poll = {
      resolve: (body: string) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      },
      timer: setTimeout(() => {
        waitingPolls = waitingPolls.filter((p) => p !== poll);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ updates: [], next_offset: String(Date.now()) }));
      }, timeout),
    };
    waitingPolls.push(poll);
    return;
  }

  if (req.method === "POST" && url.pathname === "/sendmessage") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const data = JSON.parse(body);
      console.log(`\n[iLink mock] 收到回复 -> to_user=${data.to_user}`);
      console.log(`[iLink mock] 内容:\n${data.content}\n`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errcode: 0, msg_id: `reply_${Date.now()}` }));
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/inject") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const data = JSON.parse(body);
      const msg = {
        from_user: data.from_user ?? "test_user",
        content: data.content ?? "你好",
        msg_id: `msg_${Date.now()}`,
        chat_id: data.chat_id ?? data.from_user ?? "test_user",
        msg_type: "text",
      };
      console.log(`[iLink mock] 注入消息: from=${msg.from_user} content="${msg.content}"`);

      if (waitingPolls.length > 0) {
        const poll = waitingPolls.shift()!;
        clearTimeout(poll.timer);
        poll.resolve(JSON.stringify({ updates: [msg], next_offset: String(Date.now()) }));
      } else {
        messageQueue.push(msg);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`[iLink mock] Mock iLink server running on http://127.0.0.1:${PORT}`);
  console.log(`[iLink mock] 接口:`);
  console.log(`  GET  /getupdates   - WeixinChannel long-poll 端点`);
  console.log(`  POST /sendmessage  - WeixinChannel 发送回复端点`);
  console.log(`  POST /inject       - 手动注入测试消息`);
  console.log(`\n[iLink mock] 用法: curl -X POST http://127.0.0.1:${PORT}/inject -H 'Content-Type: application/json' -d '{"content":"你好"}'`);
});

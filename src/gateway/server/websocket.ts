import { createHash } from "node:crypto";
import type { Socket } from "node:net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function createWebSocketAcceptValue(key: string): string {
  return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

export class TextWebSocketConnection {
  private buffer = Buffer.alloc(0);
  private closed = false;
  private readonly messageHandlers: Array<(message: string) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => this.handleData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on("close", () => this.emitClose());
    socket.on("error", () => this.emitClose());
  }

  onMessage(handler: (message: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  sendText(message: string): void {
    if (this.closed) {
      return;
    }
    const payload = Buffer.from(message, "utf8");
    const header = createServerFrameHeader(payload.length, 0x1);
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.socket.write(Buffer.concat([createServerFrameHeader(payload.length, 0x8), payload]));
    this.socket.end();
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const frame = readClientFrame(this.buffer);
      if (!frame) {
        return;
      }
      this.buffer = this.buffer.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        this.close();
        return;
      }
      if (frame.opcode === 0x9) {
        this.socket.write(Buffer.concat([createServerFrameHeader(frame.payload.length, 0xa), frame.payload]));
        continue;
      }
      if (frame.opcode === 0x1) {
        const message = frame.payload.toString("utf8");
        for (const handler of this.messageHandlers) {
          handler(message);
        }
      }
    }
  }

  private emitClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const handler of this.closeHandlers) {
      handler();
    }
  }
}

function createServerFrameHeader(payloadLength: number, opcode: number): Buffer {
  if (payloadLength < 126) {
    return Buffer.from([0x80 | opcode, payloadLength]);
  }
  if (payloadLength <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payloadLength, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payloadLength), 2);
  return header;
}

function readClientFrame(buffer: Buffer): { opcode: number; payload: Buffer; consumed: number } | undefined {
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let payloadLength = second & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) {
      return undefined;
    }
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) {
      return undefined;
    }
    const length = buffer.readBigUInt64BE(offset);
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("WebSocket frame is too large.");
    }
    payloadLength = Number(length);
    offset += 8;
  }

  if (!masked) {
    throw new Error("Client WebSocket frames must be masked.");
  }
  if (buffer.length < offset + 4 + payloadLength) {
    return undefined;
  }

  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] ^= mask[index % 4];
  }

  return { opcode, payload, consumed: offset + payloadLength };
}

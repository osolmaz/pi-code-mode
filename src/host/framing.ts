import { Buffer } from "node:buffer";

import { MAX_FRAME_BYTES, parseEnvelope, type ProtocolEnvelope } from "./protocol.js";

export function encodeFrame(message: ProtocolEnvelope): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.byteLength > MAX_FRAME_BYTES) throw new Error("protocol frame exceeds the limit");
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer): ProtocolEnvelope[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages: ProtocolEnvelope[] = [];
    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) throw new Error("protocol frame exceeds the limit");
      if (this.#buffer.byteLength < length + 4) break;
      const payload = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      messages.push(parseEnvelope(JSON.parse(payload.toString("utf8")) as unknown));
    }
    return messages;
  }

  finish(): void {
    if (this.#buffer.byteLength !== 0) throw new Error("protocol stream ended inside a frame");
  }
}

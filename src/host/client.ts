import { Buffer } from "node:buffer";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { truncateUtf8 } from "../core/output.js";
import { encodeFrame, FrameDecoder } from "./framing.js";
import { launchHostProcess, type HostProcessOptions } from "./process.js";
import {
  parseHostHello,
  parseToolInvoke,
  PROTOCOL_VERSION,
  type HostHello,
  type ProtocolEnvelope,
  type ProtocolRequest,
  type ProtocolResponse,
  type ToolInvokeParams,
} from "./protocol.js";

const MAX_STDERR_BYTES = 16 * 1024;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type ToolInvokeHandler = (params: ToolInvokeParams) => Promise<unknown>;

export class HostProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HostProtocolError";
    this.code = code;
  }
}

export class HostClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #decoder = new FrameDecoder();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #toolHandler: ToolInvokeHandler;
  #closed = false;
  #nextRequestId = 1;
  #stderr = "";

  private constructor(child: ChildProcessWithoutNullStreams, toolHandler: ToolInvokeHandler) {
    this.#child = child;
    this.#toolHandler = toolHandler;
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const message of this.#decoder.push(chunk)) this.#receive(message);
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = truncateUtf8(
        `${this.#stderr}${chunk.toString("utf8")}`,
        MAX_STDERR_BYTES,
      ).text;
    });
    child.once("error", (error) => {
      this.#fail(error);
    });
    child.once("close", (code, signal) => {
      if (this.#closed && code === 0) return;
      const detail = this.#stderr.trim();
      const status = signal === null ? `code ${String(code)}` : `signal ${signal}`;
      this.#fail(
        new Error(
          `Code Mode host exited with ${status}${detail.length === 0 ? "" : `: ${detail}`}`,
        ),
      );
    });
  }

  static async start(
    toolHandler: ToolInvokeHandler,
    options: HostProcessOptions = {},
  ): Promise<{ client: HostClient; hello: HostHello }> {
    const client = new HostClient(launchHostProcess(options), toolHandler);
    try {
      const hello = parseHostHello(
        await client.request("client/hello", {
          protocolVersions: [PROTOCOL_VERSION],
          client: { name: "pi-code-mode", version: "0.2.0" },
          capabilities: { images: false, notifications: true, sessionStore: true },
        }),
      );
      if (hello.protocolVersion !== PROTOCOL_VERSION || hello.host.runtime !== "deno_core") {
        throw new Error("Code Mode host returned an incompatible handshake");
      }
      return { client, hello };
    } catch (error) {
      client.kill();
      throw error;
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Code Mode host is closed"));
    const id = `c:${String(this.#nextRequestId)}`;
    this.#nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#send({ type: "request", id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.request("host/shutdown", {});
    } finally {
      this.#closed = true;
      this.#child.stdin.end();
    }
  }

  kill(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.kill("SIGTERM");
    this.#rejectPending(new Error("Code Mode host was terminated"));
  }

  #send(message: ProtocolEnvelope): void {
    if (!this.#child.stdin.writable) throw new Error("Code Mode host input is closed");
    this.#child.stdin.write(encodeFrame(message));
  }

  #receive(message: ProtocolEnvelope): void {
    if (message.type === "response") {
      this.#receiveResponse(message);
      return;
    }
    if (message.type === "request") {
      void this.#receiveRequest(message);
      return;
    }
    if (message.method === "host/fatal") {
      this.#fail(
        new Error(`Code Mode host reported a fatal error: ${JSON.stringify(message.params)}`),
      );
    }
  }

  #receiveResponse(message: ProtocolResponse): void {
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      this.#fail(new Error(`Code Mode host returned an unknown request id: ${message.id}`));
      return;
    }
    this.#pending.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(new HostProtocolError(message.error.code, message.error.message));
    } else if ("result" in message) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error("Code Mode host response has no result or error"));
    }
  }

  async #receiveRequest(message: ProtocolRequest): Promise<void> {
    if (message.method !== "tool/invoke") {
      this.#send({
        type: "response",
        id: message.id,
        error: { code: "protocol_error", message: `unknown host request: ${message.method}` },
      });
      return;
    }
    try {
      const result = await this.#toolHandler(parseToolInvoke(message.params));
      this.#send({ type: "response", id: message.id, result });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.#send({
        type: "response",
        id: message.id,
        error: { code: "tool_failed", message: messageText },
      });
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(error);
    this.#child.kill("SIGTERM");
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

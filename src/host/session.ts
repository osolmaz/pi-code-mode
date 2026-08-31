import { randomUUID } from "node:crypto";

import { CodeModeBroker } from "../broker/broker.js";
import type { CodeModeCellResult, CodeModeLimits } from "../core/types.js";
import { outputTokensToBytes, parseExecOptions } from "../provider/openai-contract.js";
import { HostClient } from "./client.js";
import type { HostProcessOptions } from "./process.js";
import {
  executionOptions,
  parseCellResult,
  parseSessionId,
  type ToolInvokeParams,
  wireTools,
} from "./protocol.js";

function scopeKey(sessionId: string, parentToolCallId: string): string {
  return `${sessionId}\0${parentToolCallId}`;
}

type BrokerScope = {
  broker: CodeModeBroker;
  sessionId: string;
  parentToolCallId: string;
};

export class CodeModeHostManager {
  #client: HostClient | undefined;
  readonly #scopes = new Map<string, BrokerScope>();

  private constructor() {
    this.#client = undefined;
  }

  static async start(options: HostProcessOptions = {}): Promise<CodeModeHostManager> {
    const manager = new CodeModeHostManager();
    const { client } = await HostClient.start((params) => manager.#invoke(params), options);
    manager.#client = client;
    return manager;
  }

  async openSession(): Promise<CodeModeHostSession> {
    const client = this.#requireClient();
    const sessionId = parseSessionId(await client.request("session/open", {}));
    return new CodeModeHostSession(this, sessionId);
  }

  async close(): Promise<void> {
    for (const scope of this.#scopes.values()) scope.broker.cancel();
    this.#scopes.clear();
    const client = this.#client;
    this.#client = undefined;
    await client?.close();
  }

  kill(): void {
    for (const scope of this.#scopes.values()) scope.broker.cancel();
    this.#scopes.clear();
    this.#client?.kill();
    this.#client = undefined;
  }

  register(sessionId: string, parentToolCallId: string, broker: CodeModeBroker): void {
    const key = scopeKey(sessionId, parentToolCallId);
    if (this.#scopes.has(key))
      throw new Error(`duplicate Code Mode parent call: ${parentToolCallId}`);
    this.#scopes.set(key, { broker, sessionId, parentToolCallId });
  }

  release(sessionId: string, parentToolCallId: string): void {
    const scope = this.#scopes.get(scopeKey(sessionId, parentToolCallId));
    scope?.broker.cancel();
    this.#scopes.delete(scopeKey(sessionId, parentToolCallId));
  }

  releaseSession(sessionId: string): void {
    for (const [key, scope] of this.#scopes) {
      if (scope.sessionId !== sessionId) continue;
      scope.broker.cancel();
      this.#scopes.delete(key);
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    return this.#requireClient().request(method, params);
  }

  async #invoke(params: ToolInvokeParams): Promise<unknown> {
    const scope = this.#scopes.get(scopeKey(params.sessionId, params.parentToolCallId));
    if (scope === undefined) throw new Error("nested tool call does not belong to an active cell");
    return scope.broker.invoke(params.tool, params.input, {
      sessionId: params.sessionId,
      cellId: params.cellId,
      parentToolCallId: params.parentToolCallId,
      nestedToolCallId: params.callId,
    });
  }

  #requireClient(): HostClient {
    if (this.#client === undefined) throw new Error("Code Mode host is not running");
    return this.#client;
  }
}

export class CodeModeHostSession {
  readonly #manager: CodeModeHostManager;
  readonly #sessionId: string;
  readonly #cellParents = new Map<string, string>();
  #closed = false;

  constructor(manager: CodeModeHostManager, sessionId: string) {
    this.#manager = manager;
    this.#sessionId = sessionId;
  }

  async exec(
    source: string,
    parentToolCallId: string,
    broker: CodeModeBroker,
    limits: CodeModeLimits,
    signal?: AbortSignal,
  ): Promise<CodeModeCellResult> {
    this.#assertOpen();
    signal?.throwIfAborted();
    const options = parseExecOptions(source, limits);
    const cellId = randomUUID();
    this.#manager.register(this.#sessionId, parentToolCallId, broker);
    const abort = (): void => {
      broker.cancel();
      void this.#manager
        .request("cell/terminate", { sessionId: this.#sessionId, cellId })
        .catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = parseCellResult(
        await this.#manager.request("cell/exec", {
          sessionId: this.#sessionId,
          cellId,
          parentToolCallId,
          source,
          tools: wireTools(broker.descriptors),
          options: executionOptions(limits, options.yieldTimeMs, options.maxOutputBytes),
        }),
      );
      if (result.status === "waiting") {
        this.#cellParents.set(result.cellId, parentToolCallId);
      } else {
        this.#manager.release(this.#sessionId, parentToolCallId);
      }
      return result;
    } catch (error) {
      this.#manager.release(this.#sessionId, parentToolCallId);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async wait(
    cellId: string,
    yieldTimeMs: number,
    maxTokens: number,
    terminate: boolean,
    limits: CodeModeLimits,
    signal?: AbortSignal,
  ): Promise<CodeModeCellResult> {
    this.#assertOpen();
    signal?.throwIfAborted();
    const parent = this.#cellParents.get(cellId);
    if (parent === undefined) throw new Error(`cell does not belong to this session: ${cellId}`);
    const abort = (): void => {
      void this.#manager
        .request("cell/terminate", { sessionId: this.#sessionId, cellId })
        .catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = parseCellResult(
        await this.#manager.request("cell/wait", {
          sessionId: this.#sessionId,
          cellId,
          yieldTimeMs,
          maxOutputBytes: outputTokensToBytes(maxTokens, limits),
          terminate,
        }),
      );
      if (result.status !== "waiting") {
        this.#cellParents.delete(cellId);
        this.#manager.release(this.#sessionId, parent);
      }
      return result;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#manager.request("session/close", { sessionId: this.#sessionId });
    } finally {
      this.#cellParents.clear();
      this.#manager.releaseSession(this.#sessionId);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Code Mode session is closed");
  }
}

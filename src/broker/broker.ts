import { Check } from "typebox/value";
import type { TSchema } from "typebox";

import type { CodeModeMode } from "../core/mode.js";
import type { CodeModeInvocationContext, CodeModeToolDescriptor, ToolEffect } from "./types.js";

const SAFE_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const RESERVED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_REPLAY_ENTRIES = 4_096;

type ReplayEntry = { signature: string; result: Promise<unknown> };

export class CodeModeReplayCache {
  readonly #entries = new Map<string, ReplayEntry>();

  run(key: string, signature: string, invoke: () => Promise<unknown>): Promise<unknown> {
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      if (existing.signature !== signature) {
        throw new Error("replayed nested tool call does not match its original request");
      }
      return existing.result;
    }
    if (this.#entries.size >= MAX_REPLAY_ENTRIES) {
      throw new Error(`Code Mode replay cache is limited to ${String(MAX_REPLAY_ENTRIES)} calls`);
    }
    const result = Promise.resolve().then(invoke);
    this.#entries.set(key, { signature, result });
    return result;
  }

  clear(): void {
    this.#entries.clear();
  }
}

export type CodeModeBrokerOptions = {
  mode?: CodeModeMode;
  allowedEffects?: readonly ToolEffect[];
  replayCache?: CodeModeReplayCache;
};

function pathName(path: readonly string[]): string {
  return path.join(".");
}

function assertDescriptor(descriptor: CodeModeToolDescriptor): void {
  if (descriptor.id.trim().length === 0) throw new Error("Code Mode tool id must not be empty");
  if (descriptor.sdkPath.length === 0) {
    throw new Error(`Code Mode tool path must not be empty: ${descriptor.id}`);
  }
  for (const segment of descriptor.sdkPath) {
    if (!SAFE_SEGMENT.test(segment) || RESERVED_SEGMENTS.has(segment)) {
      throw new Error(`invalid Code Mode tool path segment: ${segment}`);
    }
  }
}

export class CodeModeBroker {
  readonly #byId: ReadonlyMap<string, CodeModeToolDescriptor>;
  readonly #controller = new AbortController();
  readonly #seenCallIds = new Set<string>();
  readonly #replayCache: CodeModeReplayCache;
  readonly #cwd: string;
  readonly #mode: CodeModeMode;

  // Tool admission intentionally checks every independent contract field.
  // eslint-disable-next-line complexity
  constructor(
    cwd: string,
    descriptors: readonly CodeModeToolDescriptor[],
    options: CodeModeBrokerOptions = {},
  ) {
    const mode = options.mode ?? "codex";
    const allowedEffects = new Set<ToolEffect>(
      options.allowedEffects ?? ["read", "write", "execute", "interactive"],
    );
    const byId = new Map<string, CodeModeToolDescriptor>();
    const paths = new Set<string>();
    for (const descriptor of descriptors) {
      assertDescriptor(descriptor);
      if (!descriptor.modes.includes(mode)) continue;
      if (!allowedEffects.has(descriptor.effect)) {
        throw new Error(
          `Code Mode effect is not allowed: ${pathName(descriptor.sdkPath)} has ${descriptor.effect} effect`,
        );
      }
      if (byId.has(descriptor.id)) throw new Error(`duplicate Code Mode tool id: ${descriptor.id}`);
      const path = pathName(descriptor.sdkPath);
      if (
        paths.has(path) ||
        [...paths].some(
          (existing) => existing.startsWith(`${path}.`) || path.startsWith(`${existing}.`),
        )
      ) {
        throw new Error(`colliding Code Mode tool path: ${path}`);
      }
      paths.add(path);
      byId.set(
        descriptor.id,
        Object.freeze({
          ...descriptor,
          sdkPath: Object.freeze([...descriptor.sdkPath]),
          modes: Object.freeze([...descriptor.modes]),
        }),
      );
    }
    this.#cwd = cwd;
    this.#mode = mode;
    this.#byId = byId;
    this.#replayCache = options.replayCache ?? new CodeModeReplayCache();
  }

  get descriptors(): readonly CodeModeToolDescriptor[] {
    return Object.freeze([...this.#byId.values()]);
  }

  cancel(): void {
    this.#controller.abort();
  }

  // Invocation validates both sides of the callback and preserves the abort boundary.
  async invoke(
    tool: string,
    input: unknown,
    context: Omit<CodeModeInvocationContext, "cwd" | "mode">,
  ): Promise<unknown> {
    this.#controller.signal.throwIfAborted();
    const descriptor = this.#byId.get(tool);
    if (descriptor === undefined) throw new Error(`tool is not allowed in this cell: ${tool}`);
    const seen = this.#seenCallIds.has(context.nestedToolCallId);
    if (seen && descriptor.replay === "safe") {
      throw new Error(`nested tool call was already dispatched: ${context.nestedToolCallId}`);
    }
    this.#seenCallIds.add(context.nestedToolCallId);
    if (descriptor.inputSchema !== undefined) {
      let valid = false;
      try {
        valid = Check(descriptor.inputSchema as TSchema, input);
      } catch {
        throw new Error(`tool has an invalid input schema: ${descriptor.id}`);
      }
      if (!valid) throw new Error(`tool input does not match its schema: ${descriptor.id}`);
    }
    const invoke = async (): Promise<unknown> => {
      const result = await descriptor.invoke(
        input,
        { ...context, cwd: this.#cwd, mode: this.#mode },
        this.#controller.signal,
      );
      this.#controller.signal.throwIfAborted();
      const normalized = result === undefined ? null : result;
      if (descriptor.outputSchema !== undefined) {
        let valid = false;
        try {
          valid = Check(descriptor.outputSchema as TSchema, normalized);
        } catch {
          throw new Error(`tool has an invalid output schema: ${descriptor.id}`);
        }
        if (!valid) throw new Error(`tool output does not match its schema: ${descriptor.id}`);
      }
      JSON.stringify(normalized);
      return normalized;
    };
    if (descriptor.replay === "safe") return invoke();
    const signature = `${descriptor.id}\0${JSON.stringify(input)}`;
    const key = `${context.sessionId}\0${context.parentToolCallId}\0${context.nestedToolCallId}`;
    return this.#replayCache.run(key, signature, invoke);
  }
}

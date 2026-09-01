import { Check } from "typebox/value";
import type { TSchema } from "typebox";

import type { CodeModeMode } from "../core/mode.js";
import type { CodeModeInvocationContext, CodeModeToolDescriptor, ToolEffect } from "./types.js";

const SAFE_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const RESERVED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export type CodeModeBrokerOptions = {
  mode?: CodeModeMode;
  allowedEffects?: readonly ToolEffect[];
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
  }

  get descriptors(): readonly CodeModeToolDescriptor[] {
    return Object.freeze([...this.#byId.values()]);
  }

  cancel(): void {
    this.#controller.abort();
  }

  // Invocation validates both sides of the callback and preserves the abort boundary.
  // eslint-disable-next-line complexity
  async invoke(
    tool: string,
    input: unknown,
    context: Omit<CodeModeInvocationContext, "cwd" | "mode">,
  ): Promise<unknown> {
    this.#controller.signal.throwIfAborted();
    const descriptor = this.#byId.get(tool);
    if (descriptor === undefined) throw new Error(`tool is not allowed in this cell: ${tool}`);
    if (this.#seenCallIds.has(context.nestedToolCallId)) {
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
  }
}

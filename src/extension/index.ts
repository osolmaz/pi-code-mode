import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { CodeModeBroker } from "../broker/broker.js";
import { createReadOnlyCatalog } from "../broker/catalog.js";
import { resolveLimits } from "../core/limits.js";
import { CODE_MODE_TOOL_DESCRIPTION, CODE_MODE_WAIT_DESCRIPTION } from "../core/prompt.js";
import type { CodeModeCellResult, CodeModeLimits } from "../core/types.js";
import { assertOpenAICodeMode } from "../provider/capabilities.js";
import { CODE_MODE_EXEC_CONSTRAINED_SAMPLING } from "../provider/exec-grammar.js";
import {
  DEFAULT_CODE_MODE_OUTPUT_TOKENS,
  MAX_CODE_MODE_OUTPUT_TOKENS,
} from "../provider/openai-contract.js";
import type { HostProcessOptions } from "../host/process.js";
import { CodeModeHostManager, CodeModeHostSession } from "../host/session.js";

const DEFAULT_WAIT_MS = 10_000;
const MAX_WAIT_MS = 30 * 60 * 1000;

export type CodeModeExtensionOptions = {
  limits?: Partial<CodeModeLimits>;
  hostProcess?: HostProcessOptions;
};

class RuntimeOwner {
  readonly #hostProcess: HostProcessOptions | undefined;
  #manager: CodeModeHostManager | undefined;
  #session: CodeModeHostSession | undefined;
  #starting: Promise<CodeModeHostSession> | undefined;

  constructor(hostProcess: HostProcessOptions | undefined) {
    this.#hostProcess = hostProcess;
  }

  async session(): Promise<CodeModeHostSession> {
    if (this.#session !== undefined) return this.#session;
    this.#starting ??= this.#start();
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async shutdown(): Promise<void> {
    const session = this.#session;
    const manager = this.#manager;
    this.#session = undefined;
    this.#manager = undefined;
    this.#starting = undefined;
    await session?.close();
    await manager?.close();
  }

  async #start(): Promise<CodeModeHostSession> {
    const manager = await CodeModeHostManager.start(this.#hostProcess);
    try {
      const session = await manager.openSession();
      this.#manager = manager;
      this.#session = session;
      return session;
    } catch (error) {
      manager.kill();
      throw error;
    }
  }
}

function failedResult(message: string): CodeModeCellResult {
  return {
    status: "failed",
    cellId: "",
    output: [],
    truncated: false,
    stats: { toolCalls: 0, outputBytes: 0, wallTimeMs: 0 },
    error: message,
  };
}

function formatResult(result: CodeModeCellResult): string {
  const parts = result.output.map((item) =>
    item.type === "text" ? item.text : `[notification] ${item.message}`,
  );
  if (result.error !== undefined) parts.push(`Execution failed: ${result.error}`);
  if (result.status === "waiting") {
    parts.push(`Cell is still running. Call wait with cell_id ${result.cellId}.`);
  } else if (result.status === "terminated") {
    parts.push("Cell terminated.");
  } else if (parts.length === 0) {
    parts.push("Program completed with no text output.");
  }
  if (result.truncated) parts.push("[output truncated at the Code Mode limit]");
  return parts.join("\n\n");
}

// Registration stays together so exec, wait, and lifecycle share one runtime owner.
// eslint-disable-next-line max-lines-per-function
function installCodeMode(
  pi: ExtensionAPI,
  options: CodeModeExtensionOptions,
  runtime: RuntimeOwner,
): void {
  const limits = resolveLimits(options.limits);
  let baselineTools: string[] | undefined;
  const activate = (): void => {
    baselineTools ??= pi.getActiveTools().filter((name) => name !== "exec" && name !== "wait");
    pi.setActiveTools(["exec", "wait"]);
  };

  pi.registerTool({
    name: "exec",
    label: "Code Mode",
    description: CODE_MODE_TOOL_DESCRIPTION,
    promptSnippet: "Execute JavaScript that composes read-only tools",
    promptGuidelines: [
      "Send raw JavaScript to exec and call text(value) with the useful result.",
      "Use wait only when exec returns a waiting cell identifier.",
    ],
    parameters: Type.Object(
      { code: Type.String({ description: "Raw JavaScript source" }) },
      { additionalProperties: false },
    ),
    constrainedSampling: CODE_MODE_EXEC_CONSTRAINED_SAMPLING,
    executionMode: "parallel",
    async execute(toolCallId, params, signal, _onUpdate, context) {
      const broker = new CodeModeBroker(context.cwd, createReadOnlyCatalog(context.cwd, limits));
      try {
        const result = await (
          await runtime.session()
        ).exec(params.code, toolCallId, broker, limits, signal);
        return {
          content: [{ type: "text", text: formatResult(result) }],
          details: result,
        };
      } catch (error) {
        broker.cancel();
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Execution failed: ${message}` }],
          details: failedResult(message),
        };
      }
    },
  });

  pi.registerTool({
    name: "wait",
    label: "Code Mode wait",
    description: CODE_MODE_WAIT_DESCRIPTION,
    parameters: Type.Object(
      {
        cell_id: Type.String(),
        yield_time_ms: Type.Optional(
          Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS, default: DEFAULT_WAIT_MS }),
        ),
        max_tokens: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_CODE_MODE_OUTPUT_TOKENS,
            default: DEFAULT_CODE_MODE_OUTPUT_TOKENS,
          }),
        ),
        terminate: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    executionMode: "parallel",
    async execute(_toolCallId, params, signal) {
      try {
        signal?.throwIfAborted();
        const result = await (
          await runtime.session()
        ).wait(
          params.cell_id,
          params.yield_time_ms ?? DEFAULT_WAIT_MS,
          params.max_tokens ?? DEFAULT_CODE_MODE_OUTPUT_TOKENS,
          params.terminate ?? false,
          limits,
          signal,
        );
        signal?.throwIfAborted();
        return {
          content: [{ type: "text", text: formatResult(result) }],
          details: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Wait failed: ${message}` }],
          details: failedResult(message),
        };
      }
    },
  });

  pi.on("session_start", async () => {
    activate();
    await runtime.session();
  });
  pi.on("before_agent_start", async (_event, context) => {
    assertOpenAICodeMode(context.model);
    activate();
    await runtime.session();
  });
  pi.on("session_shutdown", async () => {
    await runtime.shutdown();
    if (baselineTools !== undefined) pi.setActiveTools(baselineTools);
  });
}

export function createCodeModeExtension(options: CodeModeExtensionOptions = {}): ExtensionFactory {
  return (pi) => {
    installCodeMode(pi, options, new RuntimeOwner(options.hostProcess));
  };
}

export type ManagedCodeModeExtension = {
  extension: ExtensionFactory;
  shutdown: () => Promise<void>;
};

export function createManagedCodeModeExtension(
  options: CodeModeExtensionOptions = {},
): ManagedCodeModeExtension {
  const runtime = new RuntimeOwner(options.hostProcess);
  return {
    extension: (pi) => {
      installCodeMode(pi, options, runtime);
    },
    shutdown: async () => runtime.shutdown(),
  };
}

export default createCodeModeExtension();

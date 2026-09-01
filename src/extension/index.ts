/* eslint-disable max-lines -- lifecycle, registration, and session ownership stay in one extension module. */
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { CodeModeBroker } from "../broker/broker.js";
import type { CodeModeToolDescriptor, CodeModeToolRegistration } from "../broker/types.js";
import { resolveLimits } from "../core/limits.js";
import {
  CODE_MODE_CONTRACT_VERSION,
  CODE_MODE_SESSION_ENTRY,
  DEFAULT_CODE_MODE_MODE,
  DEFAULT_PI_BUILTINS,
  createSessionContract,
  normalizePiBuiltins,
  parseCodeModeMode,
  parseSessionContract,
  type CodeModeMode,
  type CodeModeSessionContract,
} from "../core/mode.js";
import {
  CODE_MODE_WAIT_DESCRIPTION,
  codeModeSystemPrompt,
  codeModeToolDescription,
} from "../core/prompt.js";
import type { CodeModeCellResult, CodeModeLimits } from "../core/types.js";
import { loadCodeModeConfig, saveCodeModeConfig } from "../harness/config.js";
import type { HostProcessOptions } from "../host/process.js";
import { CodeModeHostManager, CodeModeHostSession } from "../host/session.js";
import { createCodexTools } from "../modes/codex/tools.js";
import { createPiTools } from "../modes/pi/tools.js";
import { assertOpenAICodeMode } from "../provider/capabilities.js";
import { CODE_MODE_EXEC_CONSTRAINED_SAMPLING } from "../provider/exec-grammar.js";
import {
  DEFAULT_CODE_MODE_OUTPUT_TOKENS,
  MAX_CODE_MODE_OUTPUT_TOKENS,
} from "../provider/openai-contract.js";
import { SandboxedProcessManager } from "../sandbox/process-manager.js";
import { WorkspaceSandbox } from "../sandbox/workspace.js";

const DEFAULT_WAIT_MS = 10_000;
const MAX_WAIT_MS = 30 * 60 * 1000;
export const CODE_MODE_REGISTER_EVENT = "pi-code-mode:register";
export const CODE_MODE_COLLECT_EVENT = "pi-code-mode:collect";

export type CodeModeExtensionOptions = {
  mode?: CodeModeMode;
  piBuiltins?: readonly string[];
  configPath?: string;
  limits?: Partial<CodeModeLimits>;
  hostProcess?: HostProcessOptions;
};

class RuntimeOwner {
  readonly #hostProcess: HostProcessOptions | undefined;
  #hostManager: CodeModeHostManager | undefined;
  #hostSession: CodeModeHostSession | undefined;
  #starting: Promise<CodeModeHostSession> | undefined;
  #workspace: WorkspaceSandbox | undefined;
  #processes: SandboxedProcessManager | undefined;
  #contract: CodeModeSessionContract | undefined;
  #descriptors: readonly CodeModeToolDescriptor[] = [];

  constructor(hostProcess: HostProcessOptions | undefined) {
    this.#hostProcess = hostProcess;
  }

  get descriptors(): readonly CodeModeToolDescriptor[] {
    return this.#descriptors;
  }

  get contract(): CodeModeSessionContract {
    if (this.#contract === undefined) throw new Error("Code Mode session is not configured");
    return this.#contract;
  }

  async configure(
    cwd: string,
    contract: CodeModeSessionContract,
    registrations: readonly CodeModeToolRegistration[],
  ): Promise<void> {
    await this.shutdown();
    const workspace = new WorkspaceSandbox(cwd);
    try {
      const processes = new SandboxedProcessManager(workspace, {
        ...(this.#hostProcess?.binaryPath === undefined
          ? {}
          : { hostBinary: this.#hostProcess.binaryPath }),
      });
      const builtins =
        contract.mode === "codex"
          ? createCodexTools(workspace, processes)
          : createPiTools(contract.piBuiltins, workspace, processes);
      const descriptors = new CodeModeBroker(workspace.root, [...builtins, ...registrations], {
        mode: contract.mode,
      }).descriptors;
      this.#workspace = workspace;
      this.#processes = processes;
      this.#contract = contract;
      this.#descriptors = descriptors;
      await this.session();
    } catch (error) {
      await this.shutdown();
      workspace.close();
      throw error;
    }
  }

  broker(
    trace: (
      descriptor: CodeModeToolDescriptor,
      status: "started" | "completed" | "failed",
      wallTimeMs?: number,
      input?: unknown,
      callId?: string,
    ) => void,
  ): CodeModeBroker {
    const contract = this.contract;
    const wrapped = this.#descriptors.map((descriptor) => ({
      ...descriptor,
      async invoke(
        input: unknown,
        context: Parameters<CodeModeToolDescriptor["invoke"]>[1],
        signal: AbortSignal,
      ) {
        const started = Date.now();
        trace(descriptor, "started", undefined, input, context.nestedToolCallId);
        try {
          const result = await descriptor.invoke(input, context, signal);
          trace(descriptor, "completed", Date.now() - started, undefined, context.nestedToolCallId);
          return result;
        } catch (error) {
          trace(descriptor, "failed", Date.now() - started, undefined, context.nestedToolCallId);
          throw error;
        }
      },
    }));
    return new CodeModeBroker(this.#workspace?.root ?? ".", wrapped, { mode: contract.mode });
  }

  async session(): Promise<CodeModeHostSession> {
    if (this.#hostSession !== undefined) return this.#hostSession;
    this.#starting ??= this.#start();
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async shutdown(): Promise<void> {
    const session = this.#hostSession;
    const manager = this.#hostManager;
    const processes = this.#processes;
    const workspace = this.#workspace;
    this.#hostSession = undefined;
    this.#hostManager = undefined;
    this.#starting = undefined;
    this.#processes = undefined;
    this.#workspace = undefined;
    this.#contract = undefined;
    this.#descriptors = [];
    processes?.close();
    await session?.close();
    await manager?.close();
    workspace?.close();
  }

  async #start(): Promise<CodeModeHostSession> {
    const manager = await CodeModeHostManager.start(this.#hostProcess);
    try {
      const session = await manager.openSession();
      this.#hostManager = manager;
      this.#hostSession = session;
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

function sessionContract(context: ExtensionContext): CodeModeSessionContract | undefined {
  const entries = context.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "custom" && entry.customType === CODE_MODE_SESSION_ENTRY) {
      const parsed = parseSessionContract(entry.data);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function activePiBuiltins(
  pi: ExtensionAPI,
  options: CodeModeExtensionOptions,
  activeToolNames?: readonly string[],
): readonly string[] {
  if (options.piBuiltins !== undefined) return normalizePiBuiltins(options.piBuiltins);
  const active = new Set(activeToolNames ?? pi.getActiveTools());
  const all = typeof pi.getAllTools === "function" ? pi.getAllTools() : ([] as ToolInfo[]);
  if (all.length === 0) return DEFAULT_PI_BUILTINS;
  const builtins = all
    .filter((tool) => tool.sourceInfo.source === "builtin" && active.has(tool.name))
    .map((tool) => tool.name);
  return normalizePiBuiltins(builtins);
}

function configuredMode(options: CodeModeExtensionOptions): CodeModeMode {
  if (options.mode !== undefined) return options.mode;
  return loadCodeModeConfig(options.configPath)?.mode ?? DEFAULT_CODE_MODE_MODE;
}

function saveDefaultMode(mode: CodeModeMode, options: CodeModeExtensionOptions): void {
  const current = loadCodeModeConfig(options.configPath) ?? {};
  saveCodeModeConfig({ ...current, mode }, options.configPath);
}

function hasConversation(context: ExtensionContext): boolean {
  return context.sessionManager
    .getBranch()
    .some((entry) => entry.type === "message" || entry.type === "custom_message");
}

type NestedToolTrace = {
  callId: string;
  name: string;
  effect: CodeModeToolDescriptor["effect"];
  status: "started" | "completed" | "failed";
  input?: { path?: string; workdir?: string; commandBytes?: number };
  wallTimeMs?: number;
};

// Trace summaries check each optional field without retaining full tool input.
// eslint-disable-next-line complexity
function traceInput(input: unknown): NestedToolTrace["input"] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const path = typeof record["path"] === "string" ? record["path"].slice(0, 512) : undefined;
  const workdir =
    typeof record["workdir"] === "string" ? record["workdir"].slice(0, 512) : undefined;
  const commandBytes =
    typeof record["cmd"] === "string" ? Buffer.byteLength(record["cmd"]) : undefined;
  if (path === undefined && workdir === undefined && commandBytes === undefined) return undefined;
  return {
    ...(path === undefined ? {} : { path }),
    ...(workdir === undefined ? {} : { workdir }),
    ...(commandBytes === undefined ? {} : { commandBytes }),
  };
}

// Registration stays together so the two provider tools and lifecycle hooks share one owner.
// eslint-disable-next-line max-lines-per-function
function installCodeMode(
  pi: ExtensionAPI,
  options: CodeModeExtensionOptions,
  runtime: RuntimeOwner,
): void {
  const limits = resolveLimits(options.limits);
  let baselineTools: string[] | undefined;
  let contract: CodeModeSessionContract | undefined;
  let registrations: CodeModeToolRegistration[] = [];
  let collecting = false;
  let toolContext: ExtensionContext | undefined;
  const cellTraces = new Map<string, NestedToolTrace[]>();

  const eventBus = "events" in pi ? pi.events : undefined;
  eventBus?.on(CODE_MODE_REGISTER_EVENT, (value) => {
    if (!collecting) return;
    if (typeof value !== "object" || value === null)
      throw new Error("invalid Code Mode registration");
    registrations.push(value as CodeModeToolRegistration);
  });

  const activate = (): void => {
    baselineTools ??= pi.getActiveTools().filter((name) => name !== "exec" && name !== "wait");
    pi.setActiveTools(["exec", "wait"]);
  };

  // A trace independently records persistence, UI notices, summaries, and timing.
  const trace = (
    descriptor: CodeModeToolDescriptor,
    status: "started" | "completed" | "failed",
    wallTimeMs?: number,
    input?: unknown,
    callId = "unknown",
    // eslint-disable-next-line complexity -- Trace records conditionally include timing, safe input, and UI state.
  ): NestedToolTrace => {
    const name = `tools.${descriptor.sdkPath.join(".")}`;
    const inputSummary = input === undefined ? undefined : traceInput(input);
    const record: NestedToolTrace = {
      callId,
      name,
      effect: descriptor.effect,
      status,
      ...(inputSummary === undefined ? {} : { input: inputSummary }),
      ...(wallTimeMs === undefined ? {} : { wallTimeMs }),
    };
    pi.appendEntry("pi-code-mode/tool-call", record);
    if (status === "started" && descriptor.effect !== "read" && toolContext?.hasUI === true) {
      toolContext.ui.notify(`Code Mode: ${name}`, "info");
    }
    return record;
  };

  // Both tools share mode state, trace storage, and one runtime owner.
  // eslint-disable-next-line max-lines-per-function
  const registerTools = (): void => {
    const currentContract = contract ?? createSessionContract(configuredMode(options));
    const descriptors = runtime.descriptors;
    pi.registerTool({
      name: "exec",
      label: "Code Mode",
      description: codeModeToolDescription(currentContract, descriptors),
      promptSnippet: `Execute JavaScript that composes ${currentContract.mode} mode tools`,
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
        toolContext = context;
        const nestedToolTraces: NestedToolTrace[] = [];
        const broker = runtime.broker((descriptor, status, wallTimeMs, input, callId) => {
          const record = trace(descriptor, status, wallTimeMs, input, callId);
          const index = nestedToolTraces.findIndex((item) => item.callId === record.callId);
          if (index === -1) nestedToolTraces.push(record);
          else nestedToolTraces[index] = { ...nestedToolTraces[index], ...record };
        });
        try {
          const result = await (
            await runtime.session()
          ).exec(params.code, toolCallId, broker, limits, signal);
          if (result.status === "waiting") cellTraces.set(result.cellId, nestedToolTraces);
          return {
            content: [{ type: "text", text: formatResult(result) }],
            details: { ...result, mode: runtime.contract.mode, nestedToolTraces },
          };
        } catch (error) {
          broker.cancel();
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: `Code Mode failed: ${message}` }],
            details: {
              ...failedResult(message),
              mode: runtime.contract.mode,
              nestedToolTraces,
            },
          };
        } finally {
          toolContext = undefined;
        }
      },
    });

    pi.registerTool({
      name: "wait",
      label: "Wait",
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
      // Waiting handles observation, completion, trace retention, cancellation, and errors.
      // eslint-disable-next-line complexity
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
          const nestedToolTraces = cellTraces.get(params.cell_id) ?? [];
          if (result.status !== "waiting") cellTraces.delete(params.cell_id);
          return {
            content: [{ type: "text", text: formatResult(result) }],
            details: { ...result, mode: runtime.contract.mode, nestedToolTraces },
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
  };

  registerTools();

  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("code-mode", {
      description: "Select Codex or Pi Code Mode for a new session",
      getArgumentCompletions: (prefix) =>
        ["codex", "pi"]
          .filter((mode) => mode.startsWith(prefix.trim()))
          .map((mode) => ({ value: mode, label: mode })),
      handler: async (args, context) => {
        const argument = args.trim();
        const selectedValue =
          argument.length === 0 ? await context.ui.select("Code Mode", ["codex", "pi"]) : argument;
        if (selectedValue === undefined) return;
        const selected = parseCodeModeMode(selectedValue);
        saveDefaultMode(selected, options);
        const next = createSessionContract(
          selected,
          selected === "pi" ? activePiBuiltins(pi, options, baselineTools) : [],
        );
        if (!hasConversation(context)) {
          contract = next;
          pi.appendEntry(CODE_MODE_SESSION_ENTRY, next);
          await runtime.configure(context.cwd, next, registrations);
          registerTools();
          activate();
          context.ui.notify(`Code Mode changed to ${selected}.`, "info");
          return;
        }
        const start = await context.ui.confirm(
          "Start a new session?",
          `Code Mode ${selected} is saved as the default. Existing sessions keep their recorded mode.`,
        );
        if (!start) return;
        await context.newSession({
          setup: (sessionManager) => {
            sessionManager.appendCustomEntry(CODE_MODE_SESSION_ENTRY, next);
            return Promise.resolve();
          },
        });
      },
    });
  }

  pi.on("session_start", async (_event, context) => {
    collecting = true;
    registrations = [];
    try {
      eventBus?.emit(CODE_MODE_COLLECT_EVENT, {
        contractVersion: CODE_MODE_CONTRACT_VERSION,
      });
    } finally {
      collecting = false;
    }
    contract =
      sessionContract(context) ??
      createSessionContract(
        configuredMode(options),
        configuredMode(options) === "pi" ? activePiBuiltins(pi, options, baselineTools) : [],
      );
    if (sessionContract(context) === undefined) pi.appendEntry(CODE_MODE_SESSION_ENTRY, contract);
    await runtime.configure(context.cwd, contract, registrations);
    registerTools();
    activate();
  });

  pi.on("before_agent_start", async (event, context) => {
    assertOpenAICodeMode(context.model);
    activate();
    await runtime.session();
    return {
      systemPrompt: `${event.systemPrompt}\n\n${codeModeSystemPrompt(runtime.contract, runtime.descriptors)}`,
    };
  });

  pi.on("session_shutdown", async () => {
    cellTraces.clear();
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
    shutdown: () => runtime.shutdown(),
  };
}

export default createCodeModeExtension();

import type { CodeModeMode } from "../core/mode.js";

export type ToolEffect = "read" | "write" | "execute" | "network" | "interactive";
export type ToolReplay = "safe" | "unsafe";

export type CodeModeInvocationContext = {
  mode: CodeModeMode;
  sessionId: string;
  cellId: string;
  parentToolCallId: string;
  nestedToolCallId: string;
  cwd: string;
};

export type CodeModeToolDescriptor = {
  id: string;
  sdkPath: readonly string[];
  modes: readonly CodeModeMode[];
  description: string;
  usage?: string;
  kind: "function" | "freeform";
  inputSchema?: unknown;
  outputSchema?: unknown;
  deferred?: boolean;
  effect: ToolEffect;
  replay: ToolReplay;
  invoke: (
    input: unknown,
    context: CodeModeInvocationContext,
    signal: AbortSignal,
  ) => Promise<unknown>;
};

export type CodeModeToolRegistration = CodeModeToolDescriptor;

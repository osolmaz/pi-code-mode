export type ToolEffect = "read" | "write" | "execute" | "network" | "interactive";
export type ToolReplay = "safe" | "unsafe";

export type CodeModeInvocationContext = {
  sessionId: string;
  cellId: string;
  parentToolCallId: string;
  nestedToolCallId: string;
  cwd: string;
};

export type CodeModeToolDescriptor = {
  name: string;
  codeModeName: string;
  description: string;
  usage?: string;
  kind: "function" | "freeform";
  inputSchema?: unknown;
  outputSchema?: unknown;
  deferred?: boolean;
  effect: ToolEffect;
  replay: ToolReplay;
  directOnly?: boolean;
  invoke: (
    input: unknown,
    context: CodeModeInvocationContext,
    signal: AbortSignal,
  ) => Promise<unknown>;
};

import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createPowerShellTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CodeModeInvocationContext, CodeModeToolDescriptor } from "../../broker/types.js";
import type { VanillaPiBuiltin } from "../../core/mode.js";

type PiToolResult = { content: unknown[]; details?: unknown };

type PiTool = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (
    callId: string,
    params: never,
    signal?: AbortSignal,
    onUpdate?: (result: PiToolResult) => void,
    context?: ExtensionContext,
  ) => Promise<PiToolResult>;
};

function descriptor(
  tool: PiTool,
  effect: "read" | "write" | "execute",
  extensionContext: ExtensionContext,
): CodeModeToolDescriptor {
  return Object.freeze({
    id: `pi.${tool.name}`,
    sdkPath: [tool.name],
    modes: ["pi"] as const,
    description: tool.description,
    usage: `await tools.${tool.name}({ ... })`,
    kind: "function" as const,
    inputSchema: tool.parameters,
    effect,
    replay: effect === "read" ? ("safe" as const) : ("unsafe" as const),
    invoke(input: unknown, context: CodeModeInvocationContext, signal: AbortSignal) {
      return tool.execute(
        context.nestedToolCallId,
        input as never,
        signal,
        undefined,
        extensionContext,
      );
    },
  });
}

function effect(name: VanillaPiBuiltin): "read" | "write" | "execute" {
  if (name === "bash" || name === "powershell") return "execute";
  if (name === "edit" || name === "write") return "write";
  return "read";
}

export function createPiTools(
  builtins: readonly VanillaPiBuiltin[],
  cwd: string,
  extensionContext: ExtensionContext,
): readonly CodeModeToolDescriptor[] {
  const tools = new Map<VanillaPiBuiltin, PiTool>([
    ["read", createReadTool(cwd) as PiTool],
    ["bash", createBashTool(cwd) as PiTool],
    ["powershell", createPowerShellTool(cwd) as PiTool],
    ["edit", createEditTool(cwd) as PiTool],
    ["write", createWriteTool(cwd) as PiTool],
    ["grep", createGrepTool(cwd) as PiTool],
    ["find", createFindTool(cwd) as PiTool],
    ["ls", createLsTool(cwd) as PiTool],
  ]);

  return Object.freeze(
    builtins.map((name) => {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error(`unsupported Pi built-in tool: ${name}`);
      return descriptor(tool, effect(name), extensionContext);
    }),
  );
}

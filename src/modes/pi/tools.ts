import { join, matchesGlob, relative, sep } from "node:path";

import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

import type { CodeModeInvocationContext, CodeModeToolDescriptor } from "../../broker/types.js";
import type { VanillaPiBuiltin } from "../../core/mode.js";
import type { SandboxedProcessManager } from "../../sandbox/process-manager.js";
import type { WorkspaceSandbox } from "../../sandbox/workspace.js";

const MAX_WALK_ENTRIES = 20_000;

type PiTool = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (
    callId: string,
    params: never,
    signal?: AbortSignal,
  ) => Promise<{ content: unknown[]; details?: unknown }>;
};

function descriptor(tool: PiTool, effect: "read" | "write" | "execute"): CodeModeToolDescriptor {
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
      return tool.execute(context.nestedToolCallId, input as never, signal);
    },
  });
}

function textResult(text: string, details?: unknown): { content: unknown[]; details?: unknown } {
  return {
    content: [{ type: "text", text }],
    ...(details === undefined ? {} : { details }),
  };
}

function positiveLimit(value: unknown, fallback = 1_000): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000) {
    throw new Error("limit must be an integer from 1 to 10000");
  }
  return value as number;
}

function stringInput(input: Record<string, unknown>, name: string, fallback?: string): string {
  const value = input[name] ?? fallback;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a string`);
  return value;
}

function recordInput(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("tool input must be an object");
  }
  return input as Record<string, unknown>;
}

function walkFiles(workspace: WorkspaceSandbox, start: string): string[] {
  const root = workspace.resolve(start);
  const files: string[] = [];
  const pending = [root.absolute];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    for (const name of workspace.readdir(directory)) {
      visited += 1;
      if (visited > MAX_WALK_ENTRIES) throw new Error("workspace scan limit exceeded");
      const path = join(directory, name);
      const stats = workspace.stat(path);
      if (stats.isDirectory()) {
        if (!new Set(["node_modules", "dist", "coverage"]).has(name)) pending.push(path);
      } else if (stats.isFile()) {
        files.push(path);
      }
    }
  }
  return files;
}

// Optional built-ins keep separate schemas and result formatting in one selector.
// eslint-disable-next-line max-lines-per-function
function optionalTool(
  name: "grep" | "find" | "ls" | "powershell",
  workspace: WorkspaceSandbox,
): PiTool {
  if (name === "powershell") {
    return {
      name,
      description: "Execute PowerShell commands.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, timeout: { type: "number" } },
        required: ["command"],
        additionalProperties: false,
      },
      execute: () =>
        Promise.reject(new Error("PowerShell is not available in this Code Mode host")),
    };
  }
  if (name === "ls") {
    return {
      name,
      description: "List directory contents.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "number" } },
        additionalProperties: false,
      },
      execute: (_callId, value) => {
        const input = recordInput(value);
        const path = stringInput(input, "path", ".");
        const limit = positiveLimit(input["limit"]);
        const entries = workspace.readdir(path).slice(0, limit);
        const lines = entries.map((entry) =>
          workspace.stat(join(workspace.resolve(path).absolute, entry)).isDirectory()
            ? `${entry}/`
            : entry,
        );
        return Promise.resolve(
          textResult(lines.join("\n"), {
            entryLimitReached: entries.length === limit ? limit : undefined,
          }),
        );
      },
    };
  }
  if (name === "find") {
    return {
      name,
      description: "Find files by glob pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          limit: { type: "number" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      execute: (_callId, value) => {
        const input = recordInput(value);
        const path = stringInput(input, "path", ".");
        const pattern = stringInput(input, "pattern");
        const limit = positiveLimit(input["limit"]);
        const base = workspace.resolve(path).absolute;
        const matches = walkFiles(workspace, path)
          .map((file) => relative(base, file).split(sep).join("/"))
          .filter((file) => matchesGlob(file, pattern))
          .slice(0, limit);
        return Promise.resolve(
          textResult(matches.join("\n"), {
            resultLimitReached: matches.length === limit ? limit : undefined,
          }),
        );
      },
    };
  }
  return {
    name,
    description: "Search file contents for patterns.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        ignoreCase: { type: "boolean" },
        literal: { type: "boolean" },
        context: { type: "number" },
        limit: { type: "number" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    // Regex compilation, traversal, binary filtering, and output limits are independent cases.
    // eslint-disable-next-line complexity
    execute: (_callId, value) => {
      const input = recordInput(value);
      const path = stringInput(input, "path", ".");
      const pattern = stringInput(input, "pattern");
      const limit = positiveLimit(input["limit"]);
      const flags = input["ignoreCase"] === true ? "iu" : "u";
      const expression =
        input["literal"] === true
          ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), flags)
          : new RegExp(pattern, flags);
      const base = workspace.resolve(path).absolute;
      const files = workspace.stat(path).isFile() ? [base] : walkFiles(workspace, path);
      const matches: string[] = [];
      for (const file of files) {
        const content = workspace.readFile(file);
        if (content.includes(0)) continue;
        for (const [index, line] of content.toString("utf8").split(/\r?\n/u).entries()) {
          expression.lastIndex = 0;
          if (expression.test(line)) {
            matches.push(
              `${relative(base, file).split(sep).join("/")}:${String(index + 1)}:${line}`,
            );
          }
          if (matches.length >= limit) break;
        }
        if (matches.length >= limit) break;
      }
      return Promise.resolve(
        textResult(matches.join("\n"), {
          matchLimitReached: matches.length === limit ? limit : undefined,
        }),
      );
    },
  };
}

export function createPiTools(
  builtins: readonly VanillaPiBuiltin[],
  workspace: WorkspaceSandbox,
  processes: SandboxedProcessManager,
): readonly CodeModeToolDescriptor[] {
  const fileOperations = {
    readFile: (path: string): Promise<Buffer> => Promise.resolve(workspace.readFile(path)),
    access: (path: string): Promise<void> => {
      workspace.access(path);
      return Promise.resolve();
    },
  };
  const tools = new Map<string, PiTool>([
    [
      "read",
      createReadTool(workspace.root, {
        autoResizeImages: false,
        operations: fileOperations,
      }) as PiTool,
    ],
    [
      "bash",
      createBashTool(workspace.root, {
        exposeSessionEnvironment: false,
        operations: {
          exec: (command, cwd, options) => processes.runOneShot(command, cwd, options),
        },
      }) as PiTool,
    ],
    [
      "edit",
      createEditTool(workspace.root, {
        operations: {
          ...fileOperations,
          writeFile: (path, content) => workspace.writeFile(path, content),
          access: (path) => {
            workspace.access(path, true);
            return Promise.resolve();
          },
        },
      }) as PiTool,
    ],
    [
      "write",
      createWriteTool(workspace.root, {
        operations: {
          writeFile: (path, content) => workspace.writeFile(path, content),
          mkdir: (path) => workspace.mkdir(path),
        },
      }) as PiTool,
    ],
  ]);
  for (const name of ["grep", "find", "ls", "powershell"] as const) {
    tools.set(name, optionalTool(name, workspace));
  }
  return Object.freeze(
    builtins.map((name) => {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error(`unsupported Pi built-in tool: ${name}`);
      return descriptor(
        tool,
        name === "bash" || name === "powershell"
          ? "execute"
          : name === "read" || name === "grep" || name === "find" || name === "ls"
            ? "read"
            : "write",
      );
    }),
  );
}

import { basename, join, matchesGlob, relative, sep } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  createEditTool,
  createReadTool,
  createWriteTool,
  detectSupportedImageMimeTypeFromFile,
  formatSize,
  truncateHead,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { CodeModeInvocationContext, CodeModeToolDescriptor } from "../../broker/types.js";
import type { VanillaPiBuiltin } from "../../core/mode.js";
import type { SandboxedProcessManager } from "../../sandbox/process-manager.js";
import type { WorkspaceSandbox } from "../../sandbox/workspace.js";

const MAX_WALK_ENTRIES = 20_000;
const MAX_BASH_ROLLING_BYTES = DEFAULT_MAX_BYTES * 2;
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1_000;
const MAX_GREP_CAPTURE_BYTES = DEFAULT_MAX_BYTES * 4;

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

class BoundedBashOutput {
  #tail = Buffer.alloc(0);
  #totalBytes = 0;
  #newlines = 0;
  #lastByte: number | undefined;

  // eslint-disable-next-line complexity -- Streaming byte, line, and UTF-8 tail bounds are one update.
  append(data: Buffer): void {
    this.#totalBytes += data.length;
    for (const byte of data) if (byte === 0x0a) this.#newlines += 1;
    if (data.length > 0) this.#lastByte = data[data.length - 1];
    this.#tail = Buffer.concat([this.#tail, data]);
    if (this.#tail.length <= MAX_BASH_ROLLING_BYTES) return;
    let start = this.#tail.length - MAX_BASH_ROLLING_BYTES;
    while (
      start < this.#tail.length &&
      (this.#tail[start] ?? 0) >= 0x80 &&
      (this.#tail[start] ?? 0) < 0xc0
    ) {
      start += 1;
    }
    this.#tail = this.#tail.subarray(start);
  }

  snapshot(): { text: string; details?: unknown } {
    const truncation = truncateTail(this.#tail.toString("utf8"));
    const totalLines =
      this.#totalBytes === 0 ? 0 : this.#newlines + (this.#lastByte === 0x0a ? 0 : 1);
    const truncated =
      this.#totalBytes > truncation.outputBytes || totalLines > truncation.outputLines;
    if (!truncated) return { text: truncation.content || "(no output)" };
    const fullTruncation = {
      ...truncation,
      truncated: true,
      truncatedBy: totalLines > DEFAULT_MAX_LINES ? ("lines" as const) : ("bytes" as const),
      totalLines,
      totalBytes: this.#totalBytes,
    };
    const startLine = totalLines - truncation.outputLines + 1;
    const text = `${truncation.content}\n\n[Showing lines ${String(startLine)}-${String(totalLines)} (${formatSize(truncation.outputBytes)} shown). Earlier output was discarded inside the session sandbox.]`;
    return { text, details: { truncation: fullTruncation } };
  }
}

function appendCommandStatus(text: string, status: string): string {
  return `${text.length > 0 ? `${text}\n\n` : ""}${status}`;
}

function createSandboxedBashTool(
  workspace: WorkspaceSandbox,
  processes: SandboxedProcessManager,
): PiTool {
  return {
    name: "bash",
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${String(DEFAULT_MAX_LINES)} lines or ${String(DEFAULT_MAX_BYTES / 1_024)}KB (whichever is hit first). Earlier output is discarded inside the session sandbox. Optionally provide a timeout in seconds.`,
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
      ),
    }),
    // eslint-disable-next-line complexity -- Pi-compatible timeout, cancellation, and exit errors share one command path.
    async execute(_callId, rawInput, signal) {
      const input = rawInput as unknown as { command: string; timeout?: number };
      if (input.timeout !== undefined) {
        if (!Number.isFinite(input.timeout) || input.timeout <= 0) {
          throw new Error("Invalid timeout: must be a finite number of seconds");
        }
        if (input.timeout > MAX_TIMEOUT_SECONDS) {
          throw new Error(`Invalid timeout: maximum is ${String(MAX_TIMEOUT_SECONDS)} seconds`);
        }
      }
      const output = new BoundedBashOutput();
      let result: { exitCode: number | null };
      try {
        result = await processes.runOneShot(input.command, workspace.root, {
          onData: (data) => {
            output.append(data);
          },
          ...(signal === undefined ? {} : { signal }),
          ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
        });
      } catch (error) {
        const snapshot = output.snapshot();
        if (error instanceof Error && error.message === "aborted") {
          throw new Error(appendCommandStatus(snapshot.text, "Command aborted"));
        }
        if (error instanceof Error && error.message.startsWith("timeout:")) {
          throw new Error(
            appendCommandStatus(
              snapshot.text,
              `Command timed out after ${String(input.timeout)} seconds`,
            ),
          );
        }
        throw error;
      }
      const snapshot = output.snapshot();
      if (result.exitCode !== 0 && result.exitCode !== null) {
        throw new Error(
          appendCommandStatus(snapshot.text, `Command exited with code ${String(result.exitCode)}`),
        );
      }
      return textResult(snapshot.text, snapshot.details);
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function createSandboxedPowerShellTool(
  workspace: WorkspaceSandbox,
  processes: SandboxedProcessManager,
): PiTool {
  const bash = createSandboxedBashTool(workspace, processes);
  return {
    ...bash,
    name: "powershell",
    description: "Execute a PowerShell command in the current working directory.",
    execute(callId, rawInput, signal) {
      const input = rawInput as unknown as { command: string; timeout?: number };
      const command = `command -v pwsh >/dev/null || { printf '%s\\n' 'PowerShell is not installed' >&2; exit 127; }
pwsh -NoProfile -NonInteractive -Command ${shellQuote(input.command)} || { status=$?; if [ "$status" -eq 126 ]; then printf '%s\\n' 'PowerShell is not installed or is unavailable in the sandbox' >&2; exit 127; fi; exit "$status"; }`;
      return bash.execute(callId, { ...input, command } as never, signal);
    },
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

class BoundedGrepOutput {
  readonly #chunks: Buffer[] = [];
  #storedBytes = 0;
  #totalBytes = 0;

  append(data: Buffer): void {
    this.#totalBytes += data.length;
    const remaining = MAX_GREP_CAPTURE_BYTES - this.#storedBytes;
    if (remaining <= 0) return;
    const stored = data.subarray(0, remaining);
    this.#chunks.push(stored);
    this.#storedBytes += stored.length;
  }

  text(): string {
    return Buffer.concat(this.#chunks, this.#storedBytes).toString("utf8");
  }

  get truncated(): boolean {
    return this.#totalBytes > this.#storedBytes;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }
}

type SandboxedGrepInput = {
  pattern: string;
  path: string;
  glob?: string;
  ignoreCase: boolean;
  literal: boolean;
  context: number;
  limit: number;
};

// eslint-disable-next-line complexity -- Sandboxed rg options, bounded capture, exit handling, and Pi result details share one call.
async function runSandboxedGrep(
  input: SandboxedGrepInput,
  workspace: WorkspaceSandbox,
  processes: SandboxedProcessManager,
  signal?: AbortSignal,
): Promise<{ content: unknown[]; details?: unknown }> {
  const target = workspace.resolve(input.path).absolute;
  const args = [
    "rg",
    "--line-number",
    "--with-filename",
    "--no-heading",
    "--color=never",
    "--hidden",
    "--max-count",
    String(input.limit),
  ];
  if (input.ignoreCase) args.push("--ignore-case");
  if (input.literal) args.push("--fixed-strings");
  if (input.context > 0) args.push("--context", String(input.context));
  if (input.glob !== undefined) args.push("--glob", input.glob);
  args.push(
    "--glob",
    "!node_modules/**",
    "--glob",
    "!dist/**",
    "--glob",
    "!coverage/**",
    "--",
    input.pattern,
    target,
  );

  const capture = new BoundedGrepOutput();
  const result = await processes.runOneShot(args.map(shellQuote).join(" "), workspace.root, {
    onData: (data) => {
      capture.append(data);
    },
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.exitCode !== 0 && result.exitCode !== 1 && result.exitCode !== null) {
    throw new Error(
      appendCommandStatus(capture.text(), `grep exited with code ${String(result.exitCode)}`),
    );
  }

  const rootPrefix = `${workspace.root}${sep}`;
  const lines = capture.text().replaceAll(rootPrefix, "").split(/\r?\n/u);
  const selected: string[] = [];
  let matchCount = 0;
  for (const line of lines) {
    const isMatch = /:\d+:/u.test(line);
    if (isMatch && matchCount >= input.limit) break;
    if (isMatch) matchCount += 1;
    if (line.length > 0) selected.push(line.replace(/([:-]\d+[:-])(?=\S)/u, "$1 "));
  }
  const truncation = truncateHead(selected.join("\n"), {
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  const details = {
    ...(matchCount >= input.limit ? { matchLimitReached: input.limit } : {}),
    ...(truncation.truncated || capture.truncated
      ? {
          truncation: {
            ...truncation,
            truncated: true,
            totalBytes: Math.max(truncation.totalBytes, capture.totalBytes),
          },
        }
      : {}),
  };
  return textResult(truncation.content, Object.keys(details).length === 0 ? undefined : details);
}

type WalkEntry = { path: string; directory: boolean };

function walkEntries(workspace: WorkspaceSandbox, start: string): WalkEntry[] {
  const root = workspace.resolve(start);
  const entries: WalkEntry[] = [];
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
        if (!new Set(["node_modules", "dist", "coverage"]).has(name)) {
          entries.push({ path, directory: true });
          pending.push(path);
        }
      } else if (stats.isFile()) {
        entries.push({ path, directory: false });
      }
    }
  }
  return entries;
}

function findMatches(
  workspace: WorkspaceSandbox,
  path: string,
  pattern: string,
  limit: number,
): string[] {
  const base = workspace.resolve(path).absolute;
  return walkEntries(workspace, path)
    .map((entry) => {
      const matchPath = relative(base, entry.path).split(sep).join("/");
      return { matchPath, display: entry.directory ? `${matchPath}/` : matchPath };
    })
    .filter(({ matchPath }) =>
      matchesGlob(pattern.includes("/") ? matchPath : basename(matchPath), pattern),
    )
    .slice(0, limit)
    .map(({ display }) => display);
}

// Optional built-ins keep separate schemas and result formatting in one selector.
function optionalTool(
  name: "grep" | "find" | "ls" | "powershell",
  workspace: WorkspaceSandbox,
  processes: SandboxedProcessManager,
): PiTool {
  if (name === "powershell") return createSandboxedPowerShellTool(workspace, processes);
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
        const limit = positiveLimit(input["limit"], 500);
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
        const matches = findMatches(workspace, path, pattern, limit);
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
        glob: { type: "string" },
        ignoreCase: { type: "boolean" },
        literal: { type: "boolean" },
        context: { type: "number" },
        limit: { type: "number" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    execute: (_callId, value, signal) => {
      const input = recordInput(value);
      const grepInput: SandboxedGrepInput = {
        path: stringInput(input, "path", "."),
        pattern: stringInput(input, "pattern"),
        limit: positiveLimit(input["limit"], 100),
        context:
          typeof input["context"] === "number" && input["context"] > 0
            ? Math.min(100, Math.floor(input["context"]))
            : 0,
        ignoreCase: input["ignoreCase"] === true,
        literal: input["literal"] === true,
        ...(input["glob"] === undefined ? {} : { glob: stringInput(input, "glob") }),
      };
      return runSandboxedGrep(grepInput, workspace, processes, signal);
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
    detectImageMimeType: (path: string): Promise<string | null> =>
      workspace.withReadableFile(path, detectSupportedImageMimeTypeFromFile),
  };
  const tools = new Map<string, PiTool>([
    [
      "read",
      createReadTool(workspace.root, {
        autoResizeImages: false,
        operations: fileOperations,
      }) as PiTool,
    ],
    ["bash", createSandboxedBashTool(workspace, processes)],
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
    tools.set(name, optionalTool(name, workspace, processes));
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

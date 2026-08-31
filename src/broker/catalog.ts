import { ReadOnlyCapabilityHost } from "../core/capabilities.js";
import type { CodeModeLimits, CodeModeToolName } from "../core/types.js";
import type { CodeModeToolDescriptor } from "./types.js";

const TOOL_DETAILS: readonly {
  name: CodeModeToolName;
  description: string;
  usage: string;
  inputSchema: Record<string, unknown>;
}[] = [
  {
    name: "read",
    description: "Read a UTF-8 text file inside the working directory.",
    usage: "await tools.read({ path, offset?, limit? })",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "grep",
    description: "Find text in files inside the working directory.",
    usage: "await tools.grep({ path?, pattern, caseSensitive?, maxResults? })",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        pattern: { type: "string" },
        caseSensitive: { type: "boolean" },
        maxResults: { type: "integer", minimum: 1 },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "find",
    description: "List matching paths inside the working directory.",
    usage: "await tools.find({ path?, pattern?, maxResults? })",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        pattern: { type: "string" },
        maxResults: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ls",
    description: "List one directory inside the working directory.",
    usage: "await tools.ls({ path?, maxResults? })",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxResults: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
];

export function createReadOnlyCatalog(
  rootDir: string,
  limits: CodeModeLimits,
): readonly CodeModeToolDescriptor[] {
  const capabilities = new ReadOnlyCapabilityHost(rootDir, limits);
  return Object.freeze(
    TOOL_DETAILS.map(({ name, description, usage, inputSchema }) =>
      Object.freeze({
        name,
        codeModeName: name,
        description,
        usage,
        kind: "function" as const,
        inputSchema,
        effect: "read" as const,
        replay: "safe" as const,
        invoke(input: unknown, _context: unknown, signal: AbortSignal) {
          signal.throwIfAborted();
          const result = capabilities.invoke(name, input);
          signal.throwIfAborted();
          return Promise.resolve(result);
        },
      }),
    ),
  );
}

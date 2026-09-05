import type { CodeModeToolDescriptor } from "../../broker/types.js";
import { applyPatch } from "./apply-patch.js";
import type { ExecCommandInput, ProcessManager, WriteStdinInput } from "../../process-manager.js";
import type { Workspace } from "../../workspace.js";

const COMMAND_RESULT_SCHEMA = {
  type: "object",
  properties: {
    chunk_id: { type: "string" },
    wall_time_seconds: { type: "number" },
    exit_code: { type: "integer" },
    session_id: { type: "integer" },
    original_token_count: { type: "integer" },
    output: { type: "string" },
  },
  required: ["wall_time_seconds", "output"],
  additionalProperties: false,
} as const;

export function createCodexTools(
  workspace: Workspace,
  processes: ProcessManager,
): readonly CodeModeToolDescriptor[] {
  return Object.freeze([
    Object.freeze({
      id: "codex.exec_command",
      sdkPath: ["exec_command"],
      modes: ["codex"] as const,
      description:
        "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
      usage:
        "await tools.exec_command({ cmd, workdir?, tty?, yield_time_ms?, max_output_tokens? })",
      kind: "function" as const,
      inputSchema: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          workdir: { type: "string" },
          tty: { type: "boolean" },
          yield_time_ms: { type: "integer", minimum: 250, maximum: 30_000 },
          max_output_tokens: { type: "integer", minimum: 1, maximum: 100_000 },
          shell: { type: "string", enum: ["bash"] },
          login: { type: "boolean" },
        },
        required: ["cmd"],
        additionalProperties: false,
      },
      outputSchema: COMMAND_RESULT_SCHEMA,
      effect: "execute" as const,
      replay: "unsafe" as const,
      invoke(input: unknown, _context: unknown, signal: AbortSignal) {
        return processes.exec(input as ExecCommandInput, signal);
      },
    }),
    Object.freeze({
      id: "codex.write_stdin",
      sdkPath: ["write_stdin"],
      modes: ["codex"] as const,
      description:
        "Writes characters to an existing unified exec session and returns recent output.",
      usage: "await tools.write_stdin({ session_id, chars?, yield_time_ms?, max_output_tokens? })",
      kind: "function" as const,
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "integer", minimum: 1 },
          chars: { type: "string", default: "" },
          yield_time_ms: { type: "integer", minimum: 250, maximum: 30_000 },
          max_output_tokens: { type: "integer", minimum: 1, maximum: 100_000 },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      outputSchema: COMMAND_RESULT_SCHEMA,
      effect: "interactive" as const,
      replay: "unsafe" as const,
      invoke(input: unknown, _context: unknown, signal: AbortSignal) {
        return processes.write(input as WriteStdinInput, signal);
      },
    }),
    Object.freeze({
      id: "codex.apply_patch",
      sdkPath: ["apply_patch"],
      modes: ["codex"] as const,
      description: "Applies a Codex patch to files in the workspace.",
      usage: 'await tools.apply_patch("*** Begin Patch\\n...\\n*** End Patch")',
      kind: "freeform" as const,
      inputSchema: { type: "string" },
      outputSchema: { type: "string" },
      effect: "write" as const,
      replay: "unsafe" as const,
      invoke(input: unknown) {
        if (typeof input !== "string") throw new Error("apply_patch input must be a string");
        return applyPatch(workspace, input);
      },
    }),
  ]);
}

import type { CodeModeToolDescriptor } from "../broker/types.js";
import type { CodeModeSessionContract } from "./mode.js";

export const CODE_MODE_WAIT_DESCRIPTION = `Observe an existing Code Mode cell. Returns only output produced since the previous observation. Use terminate=true to stop it.`;

function toolLines(descriptors: readonly CodeModeToolDescriptor[]): string {
  return descriptors
    .map((tool) => `- ${tool.usage ?? `await tools.${tool.sdkPath.join(".")}({ ... })`}`)
    .join("\n");
}

export function codeModeToolDescription(
  contract: CodeModeSessionContract,
  descriptors: readonly CodeModeToolDescriptor[],
): string {
  return `Execute JavaScript in an isolated V8 cell and compose the ${contract.mode} mode tools from code.

Send raw JavaScript without JSON wrapping or Markdown fences. The source runs as the body of an async function. It has no Node.js, Deno, direct shell, file-system, network, environment, console, WebAssembly, or module capability. Use only the functions under tools.

Available globals:
- tools: frozen async tool functions
- ALL_TOOLS: frozen tool metadata
- text(value): emit useful model-visible output
- notify(message): emit a progress notification
- store(key, value) and load(key): session-scoped JSON values
- yield_control(): pause until a later wait call
- setTimeout(callback, delay) and clearTimeout(id): bounded timers
- exit(): finish early

Available tool functions:
${toolLines(descriptors)}

Use sequential statements, conditions, loops, Promise.all, filtering, and aggregation when useful. Keep intermediate data inside the cell and call text(value) only with the result needed by the model. If exec returns a cell_id with waiting status, call wait to observe or terminate that cell.`;
}

export function codeModeSystemPrompt(
  contract: CodeModeSessionContract,
  descriptors: readonly CodeModeToolDescriptor[],
): string {
  const behavior =
    contract.mode === "codex"
      ? "Use exec_command for sandboxed workspace commands, write_stdin for a running command, and apply_patch for precise file changes."
      : "Use the active vanilla Pi built-ins through tools. Their names, inputs, and results follow Pi's normal tool contracts.";
  return `You are working in Code Mode (${contract.mode} mode). The only model-visible tools are exec and wait.

Use exec to write a JavaScript program that calls the available functions under tools. ${behavior} Send raw JavaScript, compose tool calls inside the program, and emit the useful final result with text(value). Use wait only when exec returns a waiting cell. Commands have no network or credential access and can access only the workspace and the private session /tmp.

Available functions:
${toolLines(descriptors)}`;
}

// Static exports remain useful to provider-contract tests and documentation generators.
export const CODE_MODE_TOOL_DESCRIPTION = `Execute JavaScript in an isolated V8 cell and compose the configured Code Mode tools from code.`;
export const CODE_MODE_SYSTEM_PROMPT = `You are working in Code Mode. The only model-visible tools are exec and wait.`;

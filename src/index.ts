export { escapeApprovalText } from "./core/approval-display.js";
export { digestProgram } from "./core/approval.js";
export { DEFAULT_SANDBOX_LIMITS, resolveLimits } from "./core/limits.js";
export { CODE_MODE_SYSTEM_PROMPT, CODE_MODE_TOOL_DESCRIPTION } from "./core/prompt.js";
export { executeApprovedProgram } from "./core/sandbox.js";
export type {
  ApprovalCallback,
  ApprovalRequest,
  CodeModeExecution,
  ExecuteProgramOptions,
  ExecutionStats,
  SandboxLimits,
} from "./core/types.js";
export { createCodeModeExtension } from "./extension/index.js";
export {
  createCodeModeHarness,
  createCodeModeResourceLoader,
  runCodeModePrompt,
} from "./harness/index.js";

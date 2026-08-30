import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { CODE_MODE_TOOL_DESCRIPTION } from "../core/prompt.js";
import { executeApprovedProgram } from "../core/sandbox.js";
import type { ApprovalCallback, SandboxLimits } from "../core/types.js";

export type CodeModeExtensionOptions = {
  approve?: ApprovalCallback;
  limits?: Partial<SandboxLimits>;
};

function installCodeMode(pi: ExtensionAPI, options: CodeModeExtensionOptions): void {
  let baselineTools: string[] | undefined;
  const activate = (): void => {
    baselineTools ??= pi.getActiveTools().filter((name) => name !== "exec");
    pi.setActiveTools(["exec"]);
  };

  pi.registerTool({
    name: "exec",
    label: "Code Mode",
    description: CODE_MODE_TOOL_DESCRIPTION,
    promptSnippet: "Run approved JavaScript that composes read-only file tools",
    promptGuidelines: [
      "Use exec for working-directory inspection, compose only its read-only tools, and call text(value) with the useful result.",
      "Keep exec programs small and bounded. Use relative paths and never request secrets or credentials.",
    ],
    parameters: Type.Object(
      {
        code: Type.String({ description: "Raw JavaScript source without Markdown fences" }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const approve: ApprovalCallback =
        options.approve ??
        (async (request) => {
          if (!context.hasUI) return false;
          return context.ui.confirm(
            `Run Code Mode program ${request.digest.slice(0, 12)}?`,
            `Working directory: ${request.rootDir}\n\n${request.code}`,
          );
        });
      const result = await executeApprovedProgram({
        code: params.code,
        rootDir: context.cwd,
        approve,
        ...(signal === undefined ? {} : { signal }),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      });

      if (result.status === "denied") {
        return {
          content: [
            {
              type: "text",
              text: "Execution denied. Do not retry the same program unchanged.",
            },
          ],
          details: result,
        };
      }
      if (result.status === "failed") {
        return {
          content: [{ type: "text", text: `Execution failed: ${result.error}` }],
          details: result,
        };
      }

      const suffix = result.truncated ? "\n\n[output truncated at the sandbox limit]" : "";
      return {
        content: [
          {
            type: "text",
            text: `${result.output || "Program completed with no text output."}${suffix}`,
          },
        ],
        details: result,
      };
    },
  });

  pi.on("session_start", () => {
    activate();
  });
  pi.on("before_agent_start", () => {
    activate();
  });
  pi.on("session_shutdown", () => {
    if (baselineTools !== undefined) pi.setActiveTools(baselineTools);
  });
}

export function createCodeModeExtension(options: CodeModeExtensionOptions = {}): ExtensionFactory {
  return (pi) => {
    installCodeMode(pi, options);
  };
}

export default createCodeModeExtension();

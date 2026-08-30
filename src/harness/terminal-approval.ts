import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";

import { escapeApprovalText } from "../core/approval-display.js";
import type { ApprovalCallback } from "../core/types.js";

export type TerminalApprovalOptions = {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
};

export function createTerminalApproval(options: TerminalApprovalOptions = {}): ApprovalCallback {
  const input = options.input ?? stdin;
  const output = options.output ?? stderr;
  return async (request) => {
    if (!input.isTTY || !output.isTTY) return false;

    const displayedCode = escapeApprovalText(request.code);
    output.write(`\nCode Mode program ${request.digest.slice(0, 12)}\n`);
    output.write(`Working directory: ${escapeApprovalText(request.rootDir)}\n`);
    output.write("----- BEGIN SOURCE (CONTROLS AND BACKSLASHES ESCAPED) -----\n");
    output.write(displayedCode);
    if (!displayedCode.endsWith("\n")) output.write("\n");
    output.write("----- END SOURCE -----\n");

    const interface_ = createInterface({ input, output, terminal: true });
    try {
      const answer = await interface_.question("Run this program? [y/N] ");
      return answer.trim().toLocaleLowerCase() === "y";
    } finally {
      interface_.close();
    }
  };
}

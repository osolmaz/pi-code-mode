import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";

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

    output.write(`\nCode Mode program ${request.digest.slice(0, 12)}\n`);
    output.write(`Working directory: ${request.rootDir}\n`);
    output.write("----- BEGIN EXACT SOURCE -----\n");
    output.write(request.code);
    if (!request.code.endsWith("\n")) output.write("\n");
    output.write("----- END EXACT SOURCE -----\n");

    const interface_ = createInterface({ input, output, terminal: true });
    try {
      const answer = await interface_.question("Run this program? [y/N] ");
      return answer.trim().toLocaleLowerCase() === "y";
    } finally {
      interface_.close();
    }
  };
}

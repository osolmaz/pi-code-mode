import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { resolveHostBinary } from "./binary.js";

export type HostProcessOptions = {
  binaryPath?: string;
  environment?: NodeJS.ProcessEnv;
};

export function launchHostProcess(
  options: HostProcessOptions = {},
): ChildProcessWithoutNullStreams {
  if (process.platform !== "linux") {
    throw new Error(`Code Mode process isolation is not implemented for ${process.platform}`);
  }
  const binary = options.binaryPath ?? resolveHostBinary(options.environment);
  return spawn(binary, [], {
    cwd: "/",
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

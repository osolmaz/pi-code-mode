import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import type { Writable } from "node:stream";

import { resolveHostBinary } from "../host/binary.js";
import type { WorkspaceSandbox } from "./workspace.js";

const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_WRITE_YIELD_MS = 250;
const MIN_YIELD_MS = 250;
const MAX_YIELD_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const MAX_MAX_OUTPUT_TOKENS = 100_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const DEFAULT_WALL_TIME_LIMIT_MS = 30 * 60 * 1_000;
const MAX_WALL_TIME_LIMIT_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ACTIVE_PROCESSES = 8;
const MAX_ACTIVE_PROCESSES = 64;
const COMPLETED_PROCESS_RETENTION_MS = 60_000;
const MAX_COMPLETED_PROCESSES = 16;
const MAX_COMPLETED_OUTPUT_BYTES = 32 * 1024 * 1024;

export type ExecCommandInput = {
  cmd: string;
  workdir?: string;
  tty?: boolean;
  yield_time_ms?: number;
  max_output_tokens?: number;
  shell?: string;
  login?: boolean;
};

export type WriteStdinInput = {
  session_id: number;
  chars?: string;
  yield_time_ms?: number;
  max_output_tokens?: number;
};

export type CommandResult = {
  wall_time_seconds: number;
  output: string;
  exit_code?: number;
  session_id?: number;
  original_token_count?: number;
};

type ManagedProcess = {
  id: number;
  child: ChildProcess;
  stdin: Writable;
  startedAt: number;
  output: string;
  outputBytes: number;
  cursor: number;
  exitCode?: number;
  closed: boolean;
  lifetimeTimer?: NodeJS.Timeout;
  terminationTimer?: NodeJS.Timeout;
  evictionTimer?: NodeJS.Timeout;
  outputListeners: Set<(data: Buffer) => void>;
};

export type SandboxedProcessManagerOptions = {
  hostBinary?: string;
  cpuLimitSeconds?: number;
  memoryLimitBytes?: number;
  fileSizeLimitBytes?: number;
  openFileLimit?: number;
  processLimit?: number;
  wallTimeLimitMs?: number;
  maxActiveProcesses?: number;
};

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }
  return value as number;
}

// Linux counts every user thread against RLIMIT_NPROC, including threads outside this process.
// eslint-disable-next-line complexity
function currentUserProcessLimit(headroom = 64): number {
  if (process.platform !== "linux" || process.getuid === undefined) return 512;
  const uid = process.getuid();
  let count = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      const match = /^Uid:\s+(\d+)/mu.exec(status);
      if (match?.[1] !== undefined && Number(match[1]) === uid) {
        count += readdirSync(`/proc/${entry}/task`).length;
      }
    } catch {
      continue;
    }
  }
  return Math.max(128, count + headroom);
}

function tokenLimit(value: number | undefined): number {
  return boundedInteger(
    value,
    DEFAULT_MAX_OUTPUT_TOKENS,
    1,
    MAX_MAX_OUTPUT_TOKENS,
    "max_output_tokens",
  );
}

function outputSlice(
  process: ManagedProcess,
  maxTokens: number,
): {
  text: string;
  originalTokenCount?: number;
} {
  const fresh = process.output.slice(process.cursor);
  process.cursor = process.output.length;
  const maxBytes = maxTokens * 4;
  if (Buffer.byteLength(fresh) <= maxBytes) return { text: fresh };
  const bytes = Buffer.from(fresh);
  const text = bytes.subarray(bytes.length - maxBytes).toString("utf8");
  return {
    text: `[output truncated; showing the last ${String(maxBytes)} bytes]\n${text}`,
    originalTokenCount: Math.ceil(bytes.length / 4),
  };
}

export class SandboxedProcessManager {
  readonly #workspace: WorkspaceSandbox;
  readonly #options: Required<SandboxedProcessManagerOptions>;
  readonly #processes = new Map<number, ManagedProcess>();
  #nextId = 1;
  #closed = false;

  constructor(workspace: WorkspaceSandbox, options: SandboxedProcessManagerOptions = {}) {
    this.#workspace = workspace;
    this.#options = {
      hostBinary: options.hostBinary ?? resolveHostBinary(),
      cpuLimitSeconds: options.cpuLimitSeconds ?? 300,
      memoryLimitBytes: options.memoryLimitBytes ?? 2 * 1024 * 1024 * 1024,
      fileSizeLimitBytes: options.fileSizeLimitBytes ?? 1024 * 1024 * 1024,
      openFileLimit: options.openFileLimit ?? 256,
      processLimit: options.processLimit ?? currentUserProcessLimit(),
      wallTimeLimitMs: boundedInteger(
        options.wallTimeLimitMs,
        DEFAULT_WALL_TIME_LIMIT_MS,
        MIN_YIELD_MS,
        MAX_WALL_TIME_LIMIT_MS,
        "wallTimeLimitMs",
      ),
      maxActiveProcesses: boundedInteger(
        options.maxActiveProcesses,
        DEFAULT_MAX_ACTIVE_PROCESSES,
        1,
        MAX_ACTIVE_PROCESSES,
        "maxActiveProcesses",
      ),
    };
  }

  async exec(input: ExecCommandInput, signal?: AbortSignal): Promise<CommandResult> {
    return this.#exec(input, signal);
  }

  // Command validation keeps each option and sandbox preflight independent.
  // eslint-disable-next-line complexity
  async #exec(
    input: ExecCommandInput,
    signal?: AbortSignal,
    onData?: (data: Buffer) => void,
  ): Promise<CommandResult> {
    this.#assertOpen();
    signal?.throwIfAborted();
    if (typeof input.cmd !== "string" || input.cmd.length === 0) {
      throw new Error("cmd must be a non-empty string");
    }
    if (Buffer.byteLength(input.cmd) > MAX_INPUT_BYTES) throw new Error("cmd is too large");
    if (input.shell !== undefined && input.shell !== "bash") {
      throw new Error("only the bash shell is available");
    }
    if (input.login === true) throw new Error("login shells are not available");
    this.#workspace.assertCommandSafe();
    const workdir = this.#workspace.resolve(input.workdir ?? ".");
    if (!this.#workspace.stat(workdir.absolute).isDirectory()) {
      throw new Error("workdir must be a directory");
    }
    const managed = this.#spawn(input.cmd, workdir.absolute, input.tty ?? false, onData);
    const onAbort = (): void => {
      this.#terminate(managed);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      const waitMs = boundedInteger(
        input.yield_time_ms,
        DEFAULT_EXEC_YIELD_MS,
        MIN_YIELD_MS,
        MAX_YIELD_MS,
        "yield_time_ms",
      );
      await this.#wait(managed, waitMs);
      signal?.throwIfAborted();
      return this.#result(managed, tokenLimit(input.max_output_tokens));
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  // Pi one-shot commands combine timeout conversion, streaming polls, and Pi error mapping.
  // eslint-disable-next-line complexity
  async runOneShot(
    command: string,
    cwd: string,
    options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
  ): Promise<{ exitCode: number | null }> {
    const timeoutSignal =
      options.timeout === undefined
        ? undefined
        : AbortSignal.timeout(Math.max(1, options.timeout * 1_000));
    const signals = [options.signal, timeoutSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const signal = signals.length === 0 ? undefined : AbortSignal.any(signals);
    try {
      let result = await this.#exec(
        { cmd: command, workdir: cwd, tty: false, yield_time_ms: MAX_YIELD_MS },
        signal,
        options.onData,
      );
      while (result.session_id !== undefined) {
        result = await this.write(
          { session_id: result.session_id, chars: "", yield_time_ms: MAX_YIELD_MS },
          signal,
        );
      }
      return { exitCode: result.exit_code ?? null };
    } catch (error) {
      if (options.signal?.aborted === true) throw new Error("aborted");
      if (timeoutSignal?.aborted === true) throw new Error(`timeout:${String(options.timeout)}`);
      throw error;
    }
  }

  // Polling, input writes, aborts, and output bounds have separate control paths.
  // eslint-disable-next-line complexity
  async write(input: WriteStdinInput, signal?: AbortSignal): Promise<CommandResult> {
    this.#assertOpen();
    const managed = this.#processes.get(input.session_id);
    if (managed === undefined)
      throw new Error(`unknown command session: ${String(input.session_id)}`);
    const chars = input.chars ?? "";
    if (Buffer.byteLength(chars) > MAX_INPUT_BYTES) throw new Error("chars is too large");
    const onAbort = (): void => {
      this.#terminate(managed);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      if (chars.length > 0) {
        if (managed.closed) throw new Error("command session has already exited");
        await new Promise<void>((resolve, reject) => {
          managed.stdin.write(chars, (error) => {
            if (error === null || error === undefined) resolve();
            else reject(error);
          });
        });
      }
      const waitMs = boundedInteger(
        input.yield_time_ms,
        chars.length === 0 ? DEFAULT_POLL_MS : DEFAULT_WRITE_YIELD_MS,
        MIN_YIELD_MS,
        MAX_YIELD_MS,
        "yield_time_ms",
      );
      await this.#wait(managed, waitMs);
      signal?.throwIfAborted();
      return this.#result(managed, tokenLimit(input.max_output_tokens));
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const process of this.#processes.values()) {
      if (process.evictionTimer !== undefined) clearTimeout(process.evictionTimer);
      this.#terminate(process);
    }
    this.#processes.clear();
  }

  #spawn(
    command: string,
    cwd: string,
    tty: boolean,
    onData?: (data: Buffer) => void,
  ): ManagedProcess {
    const activeProcesses = [...this.#processes.values()].filter(
      (process) => !process.closed,
    ).length;
    if (activeProcesses >= this.#options.maxActiveProcesses) {
      throw new Error(
        `command sandbox allows at most ${String(this.#options.maxActiveProcesses)} active processes`,
      );
    }
    const id = this.#nextId++;
    const config = JSON.stringify({
      command,
      cwd,
      workspace: this.#workspace.root,
      scratch: this.#workspace.scratch,
      tty,
      cpuLimitSeconds: this.#options.cpuLimitSeconds,
      memoryLimitBytes: this.#options.memoryLimitBytes,
      fileSizeLimitBytes: this.#options.fileSizeLimitBytes,
      openFileLimit: this.#options.openFileLimit,
      processLimit: this.#options.processLimit,
    });
    const child = spawn(this.#options.hostBinary, ["--command-worker"], {
      cwd: "/",
      env: {},
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const managed: ManagedProcess = {
      id,
      child,
      stdin: child.stdin,
      startedAt: Date.now(),
      output: "",
      outputBytes: 0,
      cursor: 0,
      closed: false,
      outputListeners: new Set(onData === undefined ? [] : [onData]),
    };
    this.#processes.set(id, managed);
    managed.lifetimeTimer = setTimeout(() => {
      this.#terminate(managed);
    }, this.#options.wallTimeLimitMs);
    const append = (chunk: Buffer): void => {
      this.#append(managed, chunk);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      this.#append(managed, Buffer.from(`command worker failed: ${error.message}\n`));
    });
    child.once("close", (code, signal) => {
      managed.closed = true;
      managed.exitCode = code ?? (signal === null ? 1 : 128);
      if (managed.lifetimeTimer !== undefined) clearTimeout(managed.lifetimeTimer);
      managed.outputListeners.clear();
      this.#retainCompleted(managed);
    });
    child.stdin.write(`${config}\n`, (error) => {
      if (error !== null && error !== undefined) {
        this.#append(managed, Buffer.from(`command configuration failed: ${error.message}\n`));
        this.#terminate(managed);
      }
    });
    return managed;
  }

  #append(process: ManagedProcess, chunk: Buffer): void {
    for (const listener of process.outputListeners) listener(chunk);
    const text = chunk.toString("utf8");
    process.output += text;
    process.outputBytes += chunk.length;
    if (Buffer.byteLength(process.output) > MAX_BUFFER_BYTES) {
      const previousLength = process.output.length;
      const bytes = Buffer.from(process.output);
      process.output = bytes.subarray(bytes.length - MAX_BUFFER_BYTES).toString("utf8");
      const removedCharacters = previousLength - process.output.length;
      process.cursor = Math.max(0, process.cursor - removedCharacters);
    }
  }

  async #wait(process: ManagedProcess, milliseconds: number): Promise<void> {
    if (process.closed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, milliseconds);
      const onClose = (): void => {
        done();
      };
      process.child.once("close", onClose);
      function done(): void {
        clearTimeout(timer);
        process.child.removeListener("close", onClose);
        resolve();
      }
    });
  }

  #result(process: ManagedProcess, maxTokens: number): CommandResult {
    const { text, originalTokenCount } = outputSlice(process, maxTokens);
    const result: CommandResult = {
      wall_time_seconds: (Date.now() - process.startedAt) / 1000,
      output: text,
      ...(process.closed ? { exit_code: process.exitCode ?? 1 } : { session_id: process.id }),
      ...(originalTokenCount === undefined ? {} : { original_token_count: originalTokenCount }),
    };
    if (process.closed) this.#remove(process.id);
    return result;
  }

  #retainCompleted(process: ManagedProcess): void {
    if (this.#processes.get(process.id) !== process) return;
    process.evictionTimer = setTimeout(() => {
      this.#remove(process.id);
    }, COMPLETED_PROCESS_RETENTION_MS);
    process.evictionTimer.unref();

    const completed = [...this.#processes.values()]
      .filter((candidate) => candidate.closed)
      .sort((left, right) => left.startedAt - right.startedAt);
    let retainedBytes = completed.reduce(
      (total, candidate) => total + Buffer.byteLength(candidate.output),
      0,
    );
    while (
      completed.length > MAX_COMPLETED_PROCESSES ||
      retainedBytes > MAX_COMPLETED_OUTPUT_BYTES
    ) {
      const oldest = completed.shift();
      if (oldest === undefined) break;
      retainedBytes -= Buffer.byteLength(oldest.output);
      this.#remove(oldest.id);
    }
  }

  #remove(id: number): void {
    const process = this.#processes.get(id);
    if (process?.evictionTimer !== undefined) clearTimeout(process.evictionTimer);
    this.#processes.delete(id);
  }

  #terminate(process: ManagedProcess): void {
    if (process.closed || process.terminationTimer !== undefined) return;
    const pid = process.child.pid;
    if (pid === undefined) {
      process.child.kill("SIGTERM");
    } else {
      try {
        globalThis.process.kill(-pid, "SIGTERM");
      } catch {
        process.child.kill("SIGTERM");
      }
    }
    // Keep this timer referenced and kill the group even if its original leader exits first.
    // Descendants can otherwise survive after inheriting or closing the leader's pipes.
    process.terminationTimer = setTimeout(() => {
      if (pid === undefined) {
        process.child.kill("SIGKILL");
      } else {
        try {
          globalThis.process.kill(-pid, "SIGKILL");
        } catch {
          process.child.kill("SIGKILL");
        }
      }
    }, 2_000);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("command sandbox is closed");
  }
}

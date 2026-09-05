import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { resolveHostBinary } from "./host/binary.js";

const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_WRITE_YIELD_MS = 250;
const MIN_YIELD_MS = 250;
const MAX_YIELD_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const MAX_MAX_OUTPUT_TOKENS = 100_000;
const MAX_TOTAL_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_WALL_TIME_LIMIT_MS = 24 * 60 * 60 * 1_000;
const EXIT_STDIO_GRACE_MS = 100;
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
  outputLimitExceeded: boolean;
  outputDecodersFlushed: boolean;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  cursor: number;
  exitCode?: number;
  exited: boolean;
  stdoutEnded: boolean;
  stderrEnded: boolean;
  closed: boolean;
  lifetimeTimer?: NodeJS.Timeout;
  terminationTimer?: NodeJS.Timeout;
  evictionTimer?: NodeJS.Timeout;
  postExitTimer?: NodeJS.Timeout;
  finishListeners: Set<() => void>;
};

export type ProcessManagerOptions = {
  hostBinary?: string;
  wallTimeLimitMs?: number;
  maxActiveProcesses?: number;
};

type ResolvedProcessManagerOptions = {
  hostBinary: string;
  wallTimeLimitMs?: number;
  maxActiveProcesses?: number;
};

type Unrefable = { unref: () => void };

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

export class ProcessManager {
  readonly #root: string;
  readonly #options: ResolvedProcessManagerOptions;
  readonly #processes = new Map<number, ManagedProcess>();
  #nextId = 1;
  #closed = false;

  constructor(root: string, options: ProcessManagerOptions = {}) {
    this.#root = resolve(root);
    if (!statSync(this.#root).isDirectory())
      throw new Error("working directory must be a directory");
    this.#options = {
      hostBinary: options.hostBinary ?? resolveHostBinary(),
      ...(options.wallTimeLimitMs === undefined
        ? {}
        : {
            wallTimeLimitMs: boundedInteger(
              options.wallTimeLimitMs,
              options.wallTimeLimitMs,
              MIN_YIELD_MS,
              MAX_WALL_TIME_LIMIT_MS,
              "wallTimeLimitMs",
            ),
          }),
      ...(options.maxActiveProcesses === undefined
        ? {}
        : {
            maxActiveProcesses: boundedInteger(
              options.maxActiveProcesses,
              options.maxActiveProcesses,
              1,
              Number.MAX_SAFE_INTEGER,
              "maxActiveProcesses",
            ),
          }),
    };
  }

  async exec(input: ExecCommandInput, signal?: AbortSignal): Promise<CommandResult> {
    return this.#exec(input, signal);
  }

  // Command validation keeps each option and working-directory check independent.
  // eslint-disable-next-line complexity
  async #exec(input: ExecCommandInput, signal?: AbortSignal): Promise<CommandResult> {
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
    const requestedWorkdir = input.workdir ?? ".";
    const workdir = isAbsolute(requestedWorkdir)
      ? resolve(requestedWorkdir)
      : resolve(this.#root, requestedWorkdir);
    if (!statSync(workdir).isDirectory()) throw new Error("workdir must be a directory");
    const managed = this.#spawn(input.cmd, workdir, input.tty ?? false);
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

  // Shutdown releases ownership without changing the managed commands' lifecycle.
  // eslint-disable-next-line complexity
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const process of this.#processes.values()) {
      if (process.evictionTimer !== undefined) clearTimeout(process.evictionTimer);
      if (process.lifetimeTimer !== undefined) clearTimeout(process.lifetimeTimer);
      if (process.postExitTimer !== undefined) clearTimeout(process.postExitTimer);
      process.finishListeners.clear();
      if (process.exited) this.#finalize(process, process.exitCode ?? 1);
      process.child.unref();
      for (const stream of [process.child.stdin, process.child.stdout, process.child.stderr]) {
        (stream as unknown as Unrefable).unref();
      }
    }
    this.#processes.clear();
  }

  #spawn(command: string, cwd: string, tty: boolean): ManagedProcess {
    const activeProcesses = [...this.#processes.values()].filter(
      (process) => !process.closed,
    ).length;
    if (
      this.#options.maxActiveProcesses !== undefined &&
      activeProcesses >= this.#options.maxActiveProcesses
    ) {
      throw new Error(
        `Code Mode allows at most ${String(this.#options.maxActiveProcesses)} active processes`,
      );
    }
    const id = this.#nextId++;
    const config = JSON.stringify({ command, cwd, tty });
    const child = spawn(this.#options.hostBinary, ["--command-worker"], {
      cwd: "/",
      env: process.env,
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
      outputLimitExceeded: false,
      outputDecodersFlushed: false,
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      cursor: 0,
      exited: false,
      stdoutEnded: false,
      stderrEnded: false,
      closed: false,
      finishListeners: new Set(),
    };
    this.#processes.set(id, managed);
    if (this.#options.wallTimeLimitMs !== undefined) {
      managed.lifetimeTimer = setTimeout(() => {
        this.#terminate(managed);
      }, this.#options.wallTimeLimitMs);
    }
    child.stdout.on("data", (chunk: Buffer) => {
      this.#append(managed, chunk, managed.stdoutDecoder);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.#append(managed, chunk, managed.stderrDecoder);
    });
    child.stdout.once("end", () => {
      managed.stdoutEnded = true;
      this.#maybeFinalizeAfterExit(managed);
    });
    child.stderr.once("end", () => {
      managed.stderrEnded = true;
      this.#maybeFinalizeAfterExit(managed);
    });
    child.once("error", (error) => {
      this.#append(managed, Buffer.from(`command worker failed: ${error.message}\n`));
    });
    child.once("exit", (code, signal) => {
      managed.exited = true;
      managed.exitCode = code ?? (signal === null ? 1 : 128);
      this.#maybeFinalizeAfterExit(managed);
      if (!managed.closed) this.#armPostExitTimer(managed);
    });
    child.once("close", (code, signal) => {
      this.#finalize(managed, code ?? managed.exitCode ?? (signal === null ? 1 : 128));
    });
    child.stdin.write(`${config}\n`, (error) => {
      if (error !== null && error !== undefined) {
        this.#append(managed, Buffer.from(`command configuration failed: ${error.message}\n`));
        this.#terminate(managed);
      }
    });
    return managed;
  }

  // Output collection combines streaming, idle-drain, and retained-output bounds.
  #append(process: ManagedProcess, chunk: Buffer, decoder?: StringDecoder): void {
    if (process.closed) return;
    if (process.exited) this.#armPostExitTimer(process);
    const remaining = Math.max(0, MAX_TOTAL_OUTPUT_BYTES - process.outputBytes);
    const accepted = chunk.subarray(0, remaining);
    if (accepted.length > 0) {
      process.output += decoder?.write(accepted) ?? accepted.toString("utf8");
    }
    process.outputBytes += chunk.length;
    if (accepted.length === chunk.length || process.outputLimitExceeded) return;

    process.outputLimitExceeded = true;
    this.#flushOutputDecoders(process);
    const notice = Buffer.from(
      `\n[further command output discarded after the ${String(MAX_TOTAL_OUTPUT_BYTES)}-byte retention limit]\n`,
    );
    process.output += notice.toString("utf8");
  }

  #armPostExitTimer(process: ManagedProcess): void {
    if (process.postExitTimer !== undefined) clearTimeout(process.postExitTimer);
    process.postExitTimer = setTimeout(() => {
      this.#finalize(process, process.exitCode ?? 1);
    }, EXIT_STDIO_GRACE_MS);
  }

  #maybeFinalizeAfterExit(process: ManagedProcess): void {
    if (process.exited && process.stdoutEnded && process.stderrEnded) {
      this.#finalize(process, process.exitCode ?? 1);
    }
  }

  #finalize(process: ManagedProcess, exitCode: number): void {
    if (process.closed) return;
    process.closed = true;
    process.exitCode = exitCode;
    if (process.postExitTimer !== undefined) clearTimeout(process.postExitTimer);
    if (process.lifetimeTimer !== undefined) clearTimeout(process.lifetimeTimer);
    this.#flushOutputDecoders(process);
    process.child.stdout?.destroy();
    process.child.stderr?.destroy();
    for (const listener of process.finishListeners) listener();
    process.finishListeners.clear();
    this.#retainCompleted(process);
  }

  #flushOutputDecoders(process: ManagedProcess): void {
    if (process.outputDecodersFlushed) return;
    process.outputDecodersFlushed = true;
    process.output += process.stdoutDecoder.end();
    process.output += process.stderrDecoder.end();
  }

  async #wait(process: ManagedProcess, milliseconds: number): Promise<void> {
    if (process.closed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, milliseconds);
      process.finishListeners.add(done);
      function done(): void {
        clearTimeout(timer);
        process.finishListeners.delete(done);
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
    if (this.#closed || this.#processes.get(process.id) !== process) return;
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

  #signalGroup(process: ManagedProcess, signal: NodeJS.Signals): void {
    const pid = process.child.pid;
    if (pid === undefined) {
      process.child.kill(signal);
      return;
    }
    try {
      globalThis.process.kill(-pid, signal);
    } catch {
      if (!process.closed) process.child.kill(signal);
    }
  }

  #terminate(process: ManagedProcess): void {
    if (process.closed || process.terminationTimer !== undefined) return;
    this.#signalGroup(process, "SIGTERM");
    // Keep this timer referenced and kill the group even if its original leader exits first.
    // Descendants can otherwise survive after inheriting or closing the leader's pipes.
    process.terminationTimer = setTimeout(() => {
      this.#signalGroup(process, "SIGKILL");
    }, 2_000);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("process manager is closed");
  }
}

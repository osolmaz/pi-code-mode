import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { digestProgram } from "./approval.js";
import { resolveLimits } from "./limits.js";
import { truncateUtf8 } from "./output.js";
import type {
  CodeModeExecution,
  ExecuteProgramOptions,
  ExecutionStats,
  WorkerRequest,
  WorkerResponse,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStats(value: unknown): value is ExecutionStats {
  return (
    isRecord(value) &&
    typeof value["toolCalls"] === "number" &&
    typeof value["scannedBytes"] === "number" &&
    typeof value["scannedEntries"] === "number"
  );
}

function parseSuccessfulResponse(value: Record<string, unknown>): WorkerResponse | undefined {
  if (
    value["ok"] !== true ||
    typeof value["output"] !== "string" ||
    typeof value["truncated"] !== "boolean" ||
    !isStats(value["stats"])
  ) {
    return undefined;
  }
  return {
    ok: true,
    output: value["output"],
    truncated: value["truncated"],
    stats: value["stats"],
  };
}

function parseFailedResponse(value: Record<string, unknown>): WorkerResponse | undefined {
  if (value["ok"] !== false || typeof value["error"] !== "string") return undefined;
  const stats = value["stats"];
  if (stats === undefined) return { ok: false, error: value["error"] };
  if (isStats(stats)) return { ok: false, error: value["error"], stats };
  return undefined;
}

function parseWorkerResponse(value: unknown): WorkerResponse {
  if (!isRecord(value)) throw new Error("sandbox worker returned an invalid response");
  const response = parseSuccessfulResponse(value) ?? parseFailedResponse(value);
  if (response === undefined) throw new Error("sandbox worker returned an invalid response");
  return response;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error("execution aborted");
}

function sandboxWorkerUrl(): URL {
  const adjacentBuild = new URL("./sandbox-worker.js", import.meta.url);
  if (existsSync(fileURLToPath(adjacentBuild))) return adjacentBuild;
  return new URL("../../dist/core/sandbox-worker.js", import.meta.url);
}

function runWorker(request: WorkerRequest, signal?: AbortSignal): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(sandboxWorkerUrl(), {
      workerData: request,
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 },
    });
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => {
        void worker.terminate();
        reject(new Error("execution aborted"));
      });
    };
    const timeout = setTimeout(() => {
      finish(() => {
        void worker.terminate();
        reject(new Error(`execution timed out after ${String(request.limits.timeoutMs)} ms`));
      });
    }, request.limits.timeoutMs + 250);

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();

    worker.once("message", (value: unknown) => {
      finish(() => {
        void worker.terminate();
        try {
          resolve(parseWorkerResponse(value));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    worker.once("error", (error) => {
      finish(() => {
        reject(error);
      });
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        finish(() => {
          reject(new Error(`sandbox worker exited with code ${String(code)}`));
        });
      }
    });
  });
}

export async function executeApprovedProgram(
  options: ExecuteProgramOptions,
): Promise<CodeModeExecution> {
  const digest = digestProgram(options.code);
  try {
    const limits = resolveLimits(options.limits);
    const sourceBytes = Buffer.byteLength(options.code, "utf8");
    if (sourceBytes === 0) throw new Error("program source is empty");
    if (sourceBytes > limits.maxSourceBytes) {
      throw new Error(`program source exceeds ${String(limits.maxSourceBytes)} bytes`);
    }
    throwIfAborted(options.signal);

    const approved = await options.approve({
      code: options.code,
      digest,
      rootDir: options.rootDir,
      limits,
    });
    if (!approved) return { status: "denied", digest };
    throwIfAborted(options.signal);

    const response = await runWorker(
      { code: options.code, rootDir: options.rootDir, limits },
      options.signal,
    );
    if (!response.ok) {
      return {
        status: "failed",
        digest,
        error: truncateUtf8(response.error, limits.maxOutputBytes).text,
        ...(response.stats === undefined ? {} : { stats: response.stats }),
      };
    }

    const output = truncateUtf8(response.output, limits.maxOutputBytes);
    return {
      status: "completed",
      digest,
      output: output.text,
      truncated: response.truncated || output.truncated,
      stats: response.stats,
    };
  } catch (error) {
    return { status: "failed", digest, error: errorMessage(error) };
  }
}

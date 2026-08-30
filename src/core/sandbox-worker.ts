import { parentPort, workerData } from "node:worker_threads";

import { getQuickJS } from "quickjs-emscripten";

import { ReadOnlyCapabilityHost } from "./capabilities.js";
import { truncateUtf8 } from "./output.js";
import {
  CODE_MODE_TOOL_NAMES,
  type CodeModeToolName,
  type WorkerRequest,
  type WorkerResponse,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequest(value: unknown): WorkerRequest {
  if (
    !isRecord(value) ||
    typeof value["code"] !== "string" ||
    typeof value["rootDir"] !== "string"
  ) {
    throw new Error("invalid sandbox worker request");
  }
  const limits = value["limits"];
  if (!isRecord(limits)) throw new Error("invalid sandbox limits");
  return value as WorkerRequest;
}

function isToolName(value: string): value is CodeModeToolName {
  return CODE_MODE_TOOL_NAMES.some((name) => name === value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function stringifyDump(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseProgramResult(value: unknown): { output: string; truncated: boolean } {
  if (
    !isRecord(value) ||
    typeof value["output"] !== "string" ||
    typeof value["truncated"] !== "boolean"
  ) {
    throw new Error("sandbox returned an invalid result");
  }
  return { output: value["output"], truncated: value["truncated"] };
}

function buildSource(code: string, maxOutputBytes: number): string {
  return `(async (__hostCall) => {
  "use strict";
  const call = (name, input = {}) => {
    const response = JSON.parse(__hostCall(name, JSON.stringify(input)));
    if (!response.ok) throw new Error(response.error);
    return response.value;
  };
  const tools = Object.freeze({
    read: (input) => call("read", input),
    grep: (input) => call("grep", input),
    find: (input) => call("find", input),
    ls: (input) => call("ls", input),
  });
  const maxOutputBytes = ${String(maxOutputBytes)};
  let output = "";
  let outputBytes = 0;
  let hasOutput = false;
  let outputTruncated = false;
  const utf8Width = (codePoint) => {
    if (codePoint <= 0x7f) return 1;
    if (codePoint <= 0x7ff) return 2;
    if (codePoint <= 0xffff) return 3;
    return 4;
  };
  const takeUtf8Prefix = (value, maxBytes) => {
    let bytes = 0;
    let end = 0;
    for (const character of value) {
      const width = utf8Width(character.codePointAt(0));
      if (bytes + width > maxBytes) break;
      bytes += width;
      end += character.length;
    }
    return { text: value.slice(0, end), bytes, truncated: end < value.length };
  };
  const append = (value) => {
    const bounded = takeUtf8Prefix(value, maxOutputBytes - outputBytes);
    output += bounded.text;
    outputBytes += bounded.bytes;
    outputTruncated ||= bounded.truncated;
  };
  const text = (value) => {
    if (hasOutput) append("\\n");
    hasOutput = true;
    if (outputBytes >= maxOutputBytes) {
      outputTruncated = true;
      return;
    }
    if (typeof value === "string") {
      append(value);
      return;
    }
    if (value === undefined) {
      append("undefined");
      return;
    }
    try {
      append(JSON.stringify(value));
    } catch {
      append(String(value));
    }
  };
  await (async () => {
${code}
  })();
  return JSON.stringify({ output, truncated: outputTruncated });
})(globalThis.__piCodeModeHostCall)`;
}

async function run(request: WorkerRequest): Promise<WorkerResponse> {
  const host = new ReadOnlyCapabilityHost(request.rootDir, request.limits);
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(request.limits.memoryBytes);
  runtime.setMaxStackSize(request.limits.stackBytes);
  const deadline = Date.now() + request.limits.timeoutMs;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const context = runtime.newContext();

  try {
    const hostCall = context.newFunction("__piCodeModeHostCall", (nameHandle, inputHandle) => {
      try {
        const name = context.getString(nameHandle);
        if (!isToolName(name)) throw new Error(`unknown tool: ${name}`);
        const inputText = context.getString(inputHandle);
        const input = JSON.parse(inputText) as unknown;
        const value = host.invoke(name, input);
        return context.newString(JSON.stringify({ ok: true, value }));
      } catch (error) {
        return context.newString(JSON.stringify({ ok: false, error: errorMessage(error) }));
      }
    });
    context.setProp(context.global, "__piCodeModeHostCall", hostCall);
    hostCall.dispose();

    const evaluation = context.evalCode(
      buildSource(request.code, request.limits.maxOutputBytes),
      "code-mode.js",
    );
    if (evaluation.error) {
      const dumped: unknown = context.dump(evaluation.error);
      evaluation.error.dispose();
      throw new Error(stringifyDump(dumped));
    }

    const promiseHandle = evaluation.value;
    const jobs = runtime.executePendingJobs();
    if (jobs.error) {
      const dumped: unknown = jobs.error.context.dump(jobs.error);
      jobs.error.dispose();
      promiseHandle.dispose();
      throw new Error(stringifyDump(dumped));
    }

    const state = context.getPromiseState(promiseHandle);
    promiseHandle.dispose();
    if (state.type === "pending") throw new Error("program left a pending promise");
    if (state.type === "rejected") {
      const dumped: unknown = context.dump(state.error);
      state.error.dispose();
      throw new Error(stringifyDump(dumped));
    }

    const resultText = context.getString(state.value);
    state.value.dispose();
    const parsed = parseProgramResult(JSON.parse(resultText) as unknown);
    const bounded = truncateUtf8(parsed.output, request.limits.maxOutputBytes);
    return {
      ok: true,
      output: bounded.text,
      truncated: parsed.truncated || bounded.truncated,
      stats: host.stats,
    };
  } catch (error) {
    const boundedError = truncateUtf8(errorMessage(error), request.limits.maxOutputBytes);
    return { ok: false, error: boundedError.text, stats: host.stats };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

const port = parentPort;
if (port === null) throw new Error("sandbox worker requires a parent port");

void run(parseRequest(workerData as unknown))
  .then((response) => {
    port.postMessage(response);
  })
  .catch((error: unknown) => {
    const response: WorkerResponse = { ok: false, error: errorMessage(error) };
    port.postMessage(response);
  });

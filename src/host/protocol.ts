import type { CodeModeCellResult, CodeModeLimits } from "../core/types.js";
import type { CodeModeToolDescriptor } from "../broker/types.js";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export type ProtocolError = { code: string; message: string };
export type ProtocolRequest = {
  type: "request";
  id: string;
  method: string;
  params: unknown;
};
export type ProtocolResponse = {
  type: "response";
  id: string;
  result?: unknown;
  error?: ProtocolError;
};
export type ProtocolEvent = { type: "event"; method: string; params: unknown };
export type ProtocolEnvelope = ProtocolRequest | ProtocolResponse | ProtocolEvent;

export type ToolInvokeParams = {
  sessionId: string;
  cellId: string;
  parentToolCallId: string;
  callId: string;
  tool: string;
  input: unknown;
};

export type HostHello = {
  protocolVersion: number;
  host: { name: string; version: string; runtime: string; v8: string };
  capabilities: {
    wait: boolean;
    images: boolean;
    notifications: boolean;
    sessionStore: boolean;
  };
};

export type ExecutionOptions = {
  yieldTimeMs: number;
  maxOutputBytes: number;
  maxSourceBytes: number;
  maxHeapBytes: number;
  maxToolCalls: number;
  maxConcurrentToolCalls: number;
  maxToolInputBytes: number;
  maxToolResultBytes: number;
  maxTotalToolResultBytes: number;
  maxStoreBytes: number;
  maxTimerMs: number;
  maxTimers: number;
  cpuLimitMs: number;
  wallTimeMs: number;
};

export function executionOptions(
  limits: CodeModeLimits,
  yieldTimeMs: number,
  maxOutputBytes: number,
): ExecutionOptions {
  return {
    yieldTimeMs,
    maxOutputBytes,
    maxSourceBytes: limits.maxSourceBytes,
    maxHeapBytes: limits.maxHeapBytes,
    maxToolCalls: limits.maxToolCalls,
    maxConcurrentToolCalls: limits.maxConcurrentToolCalls,
    maxToolInputBytes: limits.maxToolInputBytes,
    maxToolResultBytes: limits.maxToolResultBytes,
    maxTotalToolResultBytes: limits.maxTotalToolResultBytes,
    maxStoreBytes: limits.maxStoreBytes,
    maxTimerMs: limits.maxTimerMs,
    maxTimers: limits.maxTimers,
    cpuLimitMs: limits.cpuLimitMs,
    wallTimeMs: limits.wallTimeMs,
  };
}

export function wireTools(descriptors: readonly CodeModeToolDescriptor[]): unknown[] {
  return descriptors.map((descriptor) => ({
    id: descriptor.id,
    sdkPath: descriptor.sdkPath,
    description: descriptor.description,
    ...(descriptor.usage === undefined ? {} : { usage: descriptor.usage }),
    kind: descriptor.kind,
    ...(descriptor.inputSchema === undefined ? {} : { inputSchema: descriptor.inputSchema }),
    ...(descriptor.outputSchema === undefined ? {} : { outputSchema: descriptor.outputSchema }),
    deferred: descriptor.deferred === true,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`protocol ${key} must be a string`);
  return field;
}

// Protocol decoding must distinguish all three envelope variants.
// eslint-disable-next-line complexity
export function parseEnvelope(value: unknown): ProtocolEnvelope {
  if (!isRecord(value)) throw new Error("protocol message must be an object");
  const type = value["type"];
  if (type === "request") {
    return {
      type,
      id: stringField(value, "id"),
      method: stringField(value, "method"),
      params: value["params"],
    };
  }
  if (type === "event") {
    return { type, method: stringField(value, "method"), params: value["params"] };
  }
  if (type === "response") {
    const errorValue = value["error"];
    const error =
      errorValue === undefined
        ? undefined
        : isRecord(errorValue)
          ? { code: stringField(errorValue, "code"), message: stringField(errorValue, "message") }
          : (() => {
              throw new Error("protocol error must be an object");
            })();
    return {
      type,
      id: stringField(value, "id"),
      ...(value["result"] === undefined ? {} : { result: value["result"] }),
      ...(error === undefined ? {} : { error }),
    };
  }
  throw new Error("unknown protocol message type");
}

export function parseToolInvoke(value: unknown): ToolInvokeParams {
  if (!isRecord(value)) throw new Error("tool invocation must be an object");
  return {
    sessionId: stringField(value, "sessionId"),
    cellId: stringField(value, "cellId"),
    parentToolCallId: stringField(value, "parentToolCallId"),
    callId: stringField(value, "callId"),
    tool: stringField(value, "tool"),
    input: value["input"],
  };
}

export function parseSessionId(value: unknown): string {
  if (!isRecord(value)) throw new Error("session response must be an object");
  return stringField(value, "sessionId");
}

// Cell results contain tagged output and bounded metrics that need independent validation.
// eslint-disable-next-line complexity
export function parseCellResult(value: unknown): CodeModeCellResult {
  if (!isRecord(value)) throw new Error("cell result must be an object");
  const status = stringField(value, "status");
  if (
    status !== "completed" &&
    status !== "failed" &&
    status !== "waiting" &&
    status !== "terminated"
  ) {
    throw new Error(`unknown cell status: ${status}`);
  }
  if (!Array.isArray(value["output"]) || !isRecord(value["stats"])) {
    throw new Error("cell result has invalid output or stats");
  }
  const output = value["output"].map((item) => {
    if (!isRecord(item)) throw new Error("cell output must be an object");
    if (item["type"] === "text") return { type: "text" as const, text: stringField(item, "text") };
    if (item["type"] === "notification") {
      return { type: "notification" as const, message: stringField(item, "message") };
    }
    throw new Error("unknown cell output type");
  });
  const stats = value["stats"];
  const toolCalls = stats["toolCalls"];
  const outputBytes = stats["outputBytes"];
  const wallTimeMs = stats["wallTimeMs"];
  if (![toolCalls, outputBytes, wallTimeMs].every((field) => Number.isSafeInteger(field))) {
    throw new Error("cell stats must contain safe integers");
  }
  if (typeof value["truncated"] !== "boolean") throw new Error("cell truncated must be boolean");
  const error = value["error"];
  if (error !== undefined && typeof error !== "string")
    throw new Error("cell error must be a string");
  return {
    status,
    cellId: stringField(value, "cellId"),
    output,
    truncated: value["truncated"],
    stats: {
      toolCalls: toolCalls as number,
      outputBytes: outputBytes as number,
      wallTimeMs: wallTimeMs as number,
    },
    ...(error === undefined ? {} : { error }),
  };
}

export function parseHostHello(value: unknown): HostHello {
  if (!isRecord(value) || !isRecord(value["host"]) || !isRecord(value["capabilities"])) {
    throw new Error("host hello is invalid");
  }
  const version = value["protocolVersion"];
  if (!Number.isSafeInteger(version)) throw new Error("host protocol version is invalid");
  const host = value["host"];
  const capabilities = value["capabilities"];
  for (const key of ["wait", "images", "notifications", "sessionStore"]) {
    if (typeof capabilities[key] !== "boolean")
      throw new Error(`host capability is invalid: ${key}`);
  }
  return {
    protocolVersion: version as number,
    host: {
      name: stringField(host, "name"),
      version: stringField(host, "version"),
      runtime: stringField(host, "runtime"),
      v8: stringField(host, "v8"),
    },
    capabilities: capabilities as HostHello["capabilities"],
  };
}

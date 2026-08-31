import { Buffer } from "node:buffer";

import type { CodeModeLimits } from "../core/types.js";

export const DEFAULT_CODE_MODE_OUTPUT_TOKENS = 10_000;
export const MAX_CODE_MODE_OUTPUT_TOKENS = 32_000;

export type ExecOptions = {
  yieldTimeMs: number;
  maxOutputBytes: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(
      `${name} must be an integer from ${String(minimum)} through ${String(maximum)}`,
    );
  }
  return value as number;
}

export function outputTokensToBytes(tokens: number, limits: CodeModeLimits): number {
  const approximateBytes = tokens * 4;
  return Math.min(approximateBytes, limits.maxOutputBytes);
}

// The pragma has two optional fields with separate bounds and defaults.
// eslint-disable-next-line complexity
export function parseExecOptions(source: string, limits: CodeModeLimits): ExecOptions {
  if (Buffer.byteLength(source, "utf8") === 0) throw new Error("program source is empty");
  if (Buffer.byteLength(source, "utf8") > limits.maxSourceBytes) {
    throw new Error(`program source exceeds ${String(limits.maxSourceBytes)} bytes`);
  }
  const firstLine = source.split(/\r?\n/u, 1)[0] ?? "";
  const match = /^\s*\/\/ @exec:(.*)$/u.exec(firstLine);
  if (match === null) {
    return {
      yieldTimeMs: limits.initialYieldTimeMs,
      maxOutputBytes: outputTokensToBytes(DEFAULT_CODE_MODE_OUTPUT_TOKENS, limits),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1] ?? "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid @exec pragma JSON: ${message}`);
  }
  if (!isRecord(parsed)) throw new Error("@exec pragma must be a JSON object");
  for (const key of Object.keys(parsed)) {
    if (key !== "yield_time_ms" && key !== "max_output_tokens") {
      throw new Error(`unknown @exec option: ${key}`);
    }
  }
  const yieldTimeMs =
    parsed["yield_time_ms"] === undefined
      ? limits.initialYieldTimeMs
      : boundedInteger(parsed["yield_time_ms"], "yield_time_ms", 0, 30 * 60 * 1000);
  const outputTokens =
    parsed["max_output_tokens"] === undefined
      ? DEFAULT_CODE_MODE_OUTPUT_TOKENS
      : boundedInteger(
          parsed["max_output_tokens"],
          "max_output_tokens",
          1,
          MAX_CODE_MODE_OUTPUT_TOKENS,
        );
  return {
    yieldTimeMs,
    maxOutputBytes: outputTokensToBytes(outputTokens, limits),
  };
}

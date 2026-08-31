import type { CodeModeLimits } from "./types.js";

export const DEFAULT_CODE_MODE_LIMITS: Readonly<CodeModeLimits> = Object.freeze({
  maxSourceBytes: 64 * 1024,
  maxHeapBytes: 64 * 1024 * 1024,
  maxOutputBytes: 128 * 1024,
  maxToolCalls: 64,
  maxConcurrentToolCalls: 8,
  maxToolInputBytes: 256 * 1024,
  maxToolResultBytes: 1024 * 1024,
  maxTotalToolResultBytes: 8 * 1024 * 1024,
  maxStoreBytes: 1024 * 1024,
  maxTimerMs: 5 * 60 * 1000,
  maxTimers: 64,
  cpuLimitMs: 5_000,
  wallTimeMs: 5 * 60 * 1000,
  initialYieldTimeMs: 10_000,
  maxReadBytes: 256 * 1024,
  maxScannedBytes: 2 * 1024 * 1024,
  maxScannedEntries: 1_000,
  maxResults: 100,
});

const LIMIT_KEYS = Object.keys(DEFAULT_CODE_MODE_LIMITS) as (keyof CodeModeLimits)[];

export function resolveLimits(overrides: Partial<CodeModeLimits> = {}): CodeModeLimits {
  const limits = { ...DEFAULT_CODE_MODE_LIMITS, ...overrides };
  for (const key of LIMIT_KEYS) {
    const value = limits[key];
    const maximum = DEFAULT_CODE_MODE_LIMITS[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new Error(`${key} must be a positive safe integer no greater than ${String(maximum)}`);
    }
  }
  return limits;
}

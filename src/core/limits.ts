import type { SandboxLimits } from "./types.js";

export const DEFAULT_SANDBOX_LIMITS: Readonly<SandboxLimits> = Object.freeze({
  maxSourceBytes: 64 * 1024,
  timeoutMs: 5_000,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 512 * 1024,
  maxToolCalls: 32,
  maxReadBytes: 256 * 1024,
  maxScannedBytes: 2 * 1024 * 1024,
  maxScannedEntries: 1_000,
  maxResults: 100,
  maxOutputBytes: 128 * 1024,
});

const POSITIVE_INTEGER_KEYS = Object.keys(DEFAULT_SANDBOX_LIMITS) as (keyof SandboxLimits)[];

export function resolveLimits(overrides: Partial<SandboxLimits> = {}): SandboxLimits {
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...overrides };
  for (const key of POSITIVE_INTEGER_KEYS) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive safe integer`);
    }
  }
  return limits;
}

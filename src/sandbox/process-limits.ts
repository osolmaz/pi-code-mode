import { readFileSync, readdirSync } from "node:fs";

const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const MAX_MAX_OUTPUT_TOKENS = 100_000;

export function boundedInteger(
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
export function currentUserProcessLimit(headroom = 64): number {
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

export function tokenLimit(value: number | undefined): number {
  return boundedInteger(
    value,
    DEFAULT_MAX_OUTPUT_TOKENS,
    1,
    MAX_MAX_OUTPUT_TOKENS,
    "max_output_tokens",
  );
}

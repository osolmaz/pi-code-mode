import { lstatSync, opendirSync, type Dir, type Stats } from "node:fs";
import { join } from "node:path";

export const DEFAULT_MAX_SCRATCH_BYTES = 256 * 1024 * 1024;
export const MAX_SCRATCH_BYTES = 64 * 1024 * 1024 * 1024;
export const MAX_SCRATCH_ENTRIES = 50_000;

export type ScratchUsage = { bytes: number; entries: number };

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function openDirectory(path: string): Dir | undefined {
  try {
    return opendirSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function entryStats(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export function allocatedBytes(stats: Stats): number {
  return Math.max(stats.size, stats.blocks * 512);
}

export function validateScratchLimit(maxScratchBytes: number): void {
  if (
    !Number.isSafeInteger(maxScratchBytes) ||
    maxScratchBytes < 1 ||
    maxScratchBytes > MAX_SCRATCH_BYTES
  ) {
    throw new Error(`maxScratchBytes must be an integer from 1 to ${String(MAX_SCRATCH_BYTES)}`);
  }
}

// Directory races, entry bounds, byte bounds, and recursion share one fail-closed scan.
// eslint-disable-next-line complexity
export function measureScratchUsage(root: string, maxBytes = MAX_SCRATCH_BYTES): ScratchUsage {
  const pending = [root];
  let bytes = 0;
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    const handle = openDirectory(directory);
    if (handle === undefined) continue;
    try {
      let entry = handle.readSync();
      while (entry !== null) {
        const path = join(directory, entry.name);
        const stats = entryStats(path);
        if (stats !== undefined) {
          entries += 1;
          bytes += allocatedBytes(stats);
          if (bytes > maxBytes || entries > MAX_SCRATCH_ENTRIES) return { bytes, entries };
          if (stats.isDirectory() && !stats.isSymbolicLink()) pending.push(path);
        }
        entry = handle.readSync();
      }
    } finally {
      handle.closeSync();
    }
  }
  return { bytes, entries };
}

export function assertScratchUsage(usage: ScratchUsage, maxScratchBytes: number): void {
  if (usage.bytes > maxScratchBytes) {
    throw new Error(`session scratch exceeds the ${String(maxScratchBytes)}-byte limit`);
  }
  if (usage.entries > MAX_SCRATCH_ENTRIES) {
    throw new Error(`session scratch exceeds the ${String(MAX_SCRATCH_ENTRIES)}-entry limit`);
  }
}

export function assertProjectedScratchWrite(
  usage: ScratchUsage,
  maxScratchBytes: number,
  replacedBytes: number,
  createsEntry: boolean,
  contentBytes: number,
): void {
  const allocatedContentBytes = contentBytes === 0 ? 0 : Math.ceil(contentBytes / 4_096) * 4_096;
  assertScratchUsage(
    {
      bytes: usage.bytes - replacedBytes + allocatedContentBytes,
      entries: usage.entries + (createsEntry ? 1 : 0),
    },
    maxScratchBytes,
  );
}

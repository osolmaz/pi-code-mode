import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { CodeModeToolName, ExecutionStats, SandboxLimits } from "./types.js";

const RECURSIVE_SKIP_DIRECTORIES = new Set([".git", "coverage", "dist", "node_modules"]);
const SENSITIVE_NAMES = new Set([
  ".aws",
  ".azure",
  ".docker",
  ".env",
  ".git-credentials",
  ".gnupg",
  ".kube",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".ssh",
  "auth.json",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ed25519",
  "id_ecdsa",
  "id_rsa",
  "secrets",
  "secrets.json",
  "service-account.json",
  "token",
  "tokens.json",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toInput(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { path: value };
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error("tool input must be an object or path string");
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function optionalInteger(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${key} must be a positive safe integer`);
  }
  return value as number;
}

function slashPath(value: string): string {
  return value.split(sep).join("/");
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertNotSensitive(relPath: string): void {
  for (const segment of slashPath(relPath).split("/")) {
    const lower = segment.toLowerCase();
    if (
      SENSITIVE_NAMES.has(lower) ||
      lower.startsWith(".env.") ||
      lower.endsWith(".key") ||
      lower.endsWith(".p12") ||
      lower.endsWith(".pem") ||
      lower.endsWith(".pfx")
    ) {
      throw new Error(`access to sensitive path is blocked: ${relPath}`);
    }
  }
}

function globToRegExp(glob: string): RegExp {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === "*" && next === "*") {
      if (glob[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char !== undefined) {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "u");
}

function entryType(path: string): "directory" | "file" | "symlink" | "other" {
  const item = lstatSync(path);
  if (item.isSymbolicLink()) return "symlink";
  if (item.isDirectory()) return "directory";
  if (item.isFile()) return "file";
  return "other";
}

function countNewlines(buffer: Buffer): number {
  let count = 0;
  for (const byte of buffer) count += Number(byte === 10);
  return count;
}

function shouldContinueLineScan(
  position: number,
  size: number,
  budget: number,
  newlineCount: number,
  lastLine: number,
): boolean {
  return position < size && position < budget && newlineCount < lastLine;
}

export class ReadOnlyCapabilityHost {
  readonly #limits: SandboxLimits;
  readonly #root: string;
  readonly #visitedDirectories = new Set<string>();
  readonly #stats: ExecutionStats = { toolCalls: 0, scannedBytes: 0, scannedEntries: 0 };

  constructor(rootDir: string, limits: SandboxLimits) {
    this.#root = realpathSync(rootDir);
    if (!statSync(this.#root).isDirectory()) throw new Error("rootDir must be a directory");
    this.#limits = limits;
  }

  get stats(): ExecutionStats {
    return { ...this.#stats };
  }

  invoke(name: CodeModeToolName, rawInput: unknown): unknown {
    this.#stats.toolCalls += 1;
    if (this.#stats.toolCalls > this.#limits.maxToolCalls) {
      throw new Error(`tool call limit exceeded (${String(this.#limits.maxToolCalls)})`);
    }

    const input = toInput(rawInput);
    switch (name) {
      case "read":
        return this.#read(input);
      case "grep":
        return this.#grep(input);
      case "find":
        return this.#find(input);
      case "ls":
        return this.#ls(input);
    }
  }

  #resolve(requested = "."): { absolute: string; relative: string } {
    if (requested.includes("\0")) throw new Error("path contains a null byte");
    if (isAbsolute(requested)) throw new Error("absolute paths are not allowed");

    const lexical = resolve(this.#root, requested);
    if (!isInside(this.#root, lexical)) throw new Error("path escapes the working directory");
    assertNotSensitive(slashPath(relative(this.#root, lexical)) || ".");
    const absolute = realpathSync(lexical);
    if (!isInside(this.#root, absolute)) throw new Error("symlink escapes the working directory");

    const relPath = slashPath(relative(this.#root, absolute)) || ".";
    assertNotSensitive(relPath);
    return { absolute, relative: relPath };
  }

  #resultLimit(input: Record<string, unknown>): number {
    return Math.min(
      optionalInteger(input, "maxResults") ?? this.#limits.maxResults,
      this.#limits.maxResults,
    );
  }

  #scanEntry(): void {
    this.#stats.scannedEntries += 1;
    if (this.#stats.scannedEntries > this.#limits.maxScannedEntries) {
      throw new Error(`scanned entry limit exceeded (${String(this.#limits.maxScannedEntries)})`);
    }
  }

  #readBytes(path: string, maxBytes: number): Buffer {
    const remaining = this.#limits.maxScannedBytes - this.#stats.scannedBytes;
    if (remaining <= 0)
      throw new Error(`scanned byte limit exceeded (${String(this.#limits.maxScannedBytes)})`);
    const budget = Math.max(1, Math.min(maxBytes, remaining));
    const descriptor = openSync(path, "r");
    try {
      const size = fstatSync(descriptor).size;
      const buffer = Buffer.alloc(Math.min(size, budget));
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
      this.#stats.scannedBytes += bytesRead;
      return buffer.subarray(0, bytesRead);
    } finally {
      closeSync(descriptor);
    }
  }

  #scanLinePrefix(path: string, lastLine: number, budget: number): Buffer {
    const descriptor = openSync(path, "r");
    try {
      const size = fstatSync(descriptor).size;
      const chunks: Buffer[] = [];
      let newlineCount = 0;
      let position = 0;

      while (shouldContinueLineScan(position, size, budget, newlineCount, lastLine)) {
        const length = Math.min(64 * 1024, size - position, budget - position);
        const buffer = Buffer.allocUnsafe(length);
        const bytesRead = readSync(descriptor, buffer, 0, length, position);
        if (bytesRead === 0) break;

        const chunk = buffer.subarray(0, bytesRead);
        chunks.push(chunk);
        position += bytesRead;
        this.#stats.scannedBytes += bytesRead;
        if (chunk.includes(0)) throw new Error("binary files are not supported");
        newlineCount += countNewlines(chunk);
      }

      if (position < size && newlineCount < lastLine) {
        throw new Error(
          `requested line range exceeds the scanned byte limit (${String(this.#limits.maxScannedBytes)})`,
        );
      }
      return Buffer.concat(chunks);
    } finally {
      closeSync(descriptor);
    }
  }

  #readLineRange(path: string, offset: number, limit: number): string {
    const lastLine = offset + limit - 1;
    if (!Number.isSafeInteger(lastLine)) throw new Error("requested line range is too large");

    const remaining = this.#limits.maxScannedBytes - this.#stats.scannedBytes;
    if (remaining <= 0)
      throw new Error(`scanned byte limit exceeded (${String(this.#limits.maxScannedBytes)})`);

    const allLines = this.#scanLinePrefix(path, lastLine, remaining)
      .toString("utf8")
      .split(/\r?\n/u);
    const output = allLines.slice(offset - 1, lastLine).join("\n");
    if (Buffer.byteLength(output, "utf8") > this.#limits.maxReadBytes) {
      throw new Error(
        `requested line range exceeds the read byte limit (${String(this.#limits.maxReadBytes)})`,
      );
    }
    return output;
  }

  #resolveWalkEntry(
    realStart: string,
    name: string,
  ): { absolute: string; kind: string; relPath: string } | undefined {
    if (RECURSIVE_SKIP_DIRECTORIES.has(name)) return undefined;
    try {
      const lexical = resolve(realStart, name);
      assertNotSensitive(slashPath(relative(this.#root, lexical)));
      const absolute = realpathSync(lexical);
      if (!isInside(this.#root, absolute)) return undefined;
      const relPath = slashPath(relative(this.#root, absolute));
      assertNotSensitive(relPath);
      return { absolute, kind: entryType(lexical), relPath };
    } catch {
      return undefined;
    }
  }

  #isWalkDirectory(kind: string, absolute: string): boolean {
    if (kind === "directory") return true;
    return kind === "symlink" && statSync(absolute).isDirectory();
  }

  #walk(
    start: string,
    visit: (absolute: string, relativePath: string, kind: string) => boolean,
  ): boolean {
    const realStart = realpathSync(start);
    if (this.#visitedDirectories.has(realStart)) return true;
    this.#visitedDirectories.add(realStart);

    const entries = readdirSync(realStart, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      this.#scanEntry();
      const resolvedEntry = this.#resolveWalkEntry(realStart, entry.name);
      if (resolvedEntry === undefined) continue;
      const { absolute, kind, relPath } = resolvedEntry;
      if (!visit(absolute, relPath, kind)) return false;
      if (
        this.#isWalkDirectory(kind, absolute) &&
        !this.#visitedDirectories.has(absolute) &&
        !this.#walk(absolute, visit)
      ) {
        return false;
      }
    }
    return true;
  }

  #read(input: Record<string, unknown>): unknown {
    const requested = optionalString(input, "path");
    if (requested === undefined) throw new Error("path is required");
    const target = this.#resolve(requested);
    if (!statSync(target.absolute).isFile()) throw new Error("read path must be a file");

    const offset = optionalInteger(input, "offset") ?? 1;
    const limit = optionalInteger(input, "limit") ?? 2_000;
    return this.#readLineRange(target.absolute, offset, limit);
  }

  #ls(input: Record<string, unknown>): unknown {
    const target = this.#resolve(optionalString(input, "path") ?? ".");
    if (!statSync(target.absolute).isDirectory()) throw new Error("ls path must be a directory");
    const maxResults = this.#resultLimit(input);
    const entries: { name: string; type: string }[] = [];

    for (const item of readdirSync(target.absolute, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      this.#scanEntry();
      const relPath = slashPath(relative(this.#root, resolve(target.absolute, item.name)));
      try {
        assertNotSensitive(relPath);
      } catch {
        continue;
      }
      const absolute = realpathSync(resolve(target.absolute, item.name));
      if (!isInside(this.#root, absolute)) continue;
      entries.push({ name: item.name, type: entryType(resolve(target.absolute, item.name)) });
      if (entries.length >= maxResults) break;
    }
    return entries;
  }

  #find(input: Record<string, unknown>): unknown {
    const target = this.#resolve(optionalString(input, "path") ?? ".");
    if (!statSync(target.absolute).isDirectory()) throw new Error("find path must be a directory");
    const pattern = globToRegExp(optionalString(input, "pattern") ?? "**/*");
    const maxResults = this.#resultLimit(input);
    const paths: string[] = [];
    this.#visitedDirectories.clear();
    this.#walk(target.absolute, (_absolute, relPath) => {
      if (pattern.test(relPath)) paths.push(relPath);
      return paths.length < maxResults;
    });
    return paths;
  }

  #grep(input: Record<string, unknown>): unknown {
    const pattern = optionalString(input, "pattern");
    if (pattern === undefined || pattern.length === 0) throw new Error("pattern is required");
    const target = this.#resolve(optionalString(input, "path") ?? ".");
    const caseSensitive = optionalBoolean(input, "caseSensitive") ?? true;
    const needle = caseSensitive ? pattern : pattern.toLocaleLowerCase();
    const maxResults = this.#resultLimit(input);
    const matches: { path: string; line: number; text: string }[] = [];

    const inspect = (absolute: string, relPath: string): boolean => {
      if (!statSync(absolute).isFile()) return true;
      const buffer = this.#readBytes(absolute, this.#limits.maxReadBytes);
      if (buffer.includes(0)) return true;
      for (const [index, line] of buffer.toString("utf8").split(/\r?\n/u).entries()) {
        const comparable = caseSensitive ? line : line.toLocaleLowerCase();
        if (comparable.includes(needle))
          matches.push({ path: relPath, line: index + 1, text: line });
        if (matches.length >= maxResults) return false;
      }
      return true;
    };

    if (statSync(target.absolute).isFile()) {
      inspect(target.absolute, target.relative);
    } else {
      this.#visitedDirectories.clear();
      this.#walk(target.absolute, (absolute, relPath, kind) =>
        kind === "file" ? inspect(absolute, relPath) : true,
      );
    }
    return matches;
  }
}

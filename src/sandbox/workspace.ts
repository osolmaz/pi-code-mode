import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  MAX_GIT_CONFIG_BYTES,
  assertSafeGitConfig,
  assertSafePathParts,
  isGitCredentialConfigPath,
} from "./sensitive-path.js";
import {
  DEFAULT_MAX_SCRATCH_BYTES,
  allocatedBytes,
  assertProjectedScratchDirectories,
  assertProjectedScratchWrite,
  assertScratchUsage,
  measureScratchUsage,
  validateScratchLimit,
  type ScratchUsage,
} from "./scratch-quota.js";

const MAX_PATH_BYTES = 16 * 1024;
const DEFAULT_MAX_READ_BYTES = 16 * 1024 * 1024;
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export type ResolvedSandboxPath = {
  absolute: string;
  display: string;
  area: "workspace" | "scratch";
};

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function nearestExisting(path: string): string {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}

export class WorkspaceSandbox {
  readonly #root: string;
  readonly #rootFd: number;
  readonly #scratch: string;
  readonly #scratchFd: number;
  readonly #maxScratchBytes: number;
  #closed = false;
  #mutationQueue = Promise.resolve();
  readonly #mutationContext = new AsyncLocalStorage<boolean>();

  constructor(
    rootDir: string,
    scratchParent = tmpdir(),
    maxScratchBytes = DEFAULT_MAX_SCRATCH_BYTES,
  ) {
    validateScratchLimit(maxScratchBytes);
    this.#root = realpathSync(rootDir);
    if (!statSync(this.#root).isDirectory()) throw new Error("workspace root must be a directory");
    this.#rootFd = openSync(this.#root, DIRECTORY_OPEN_FLAGS);
    this.#scratch = realpathSync(mkdtempSync(join(scratchParent, "pi-code-mode-")));
    chmodSync(this.#scratch, 0o700);
    this.#scratchFd = openSync(this.#scratch, DIRECTORY_OPEN_FLAGS);
    this.#maxScratchBytes = maxScratchBytes;
  }

  get root(): string {
    return this.#root;
  }

  get scratch(): string {
    return this.#scratch;
  }

  get maxScratchBytes(): number {
    return this.#maxScratchBytes;
  }

  scratchUsage(): ScratchUsage {
    this.#assertOpen();
    return measureScratchUsage(this.#scratch, this.#maxScratchBytes);
  }

  assertScratchWithinLimit(): void {
    assertScratchUsage(this.scratchUsage(), this.#maxScratchBytes);
  }

  // Resolution checks virtual paths, lexical containment, sensitivity, and symlink containment.
  // eslint-disable-next-line complexity
  resolve(input: string, options: { write?: boolean } = {}): ResolvedSandboxPath {
    this.#assertOpen();
    if (typeof input !== "string" || input.length === 0) throw new Error("path must not be empty");
    if (Buffer.byteLength(input) > MAX_PATH_BYTES || input.includes("\0")) {
      throw new Error("path is invalid or too long");
    }

    const absoluteInput = isAbsolute(input) ? resolve(input) : undefined;
    const absoluteWorkspaceInput =
      absoluteInput !== undefined && isInside(this.#root, absoluteInput);
    const absoluteScratchInput =
      absoluteInput !== undefined && isInside(this.#scratch, absoluteInput);
    const virtualScratch =
      !absoluteWorkspaceInput &&
      !absoluteScratchInput &&
      (input === "/tmp" || input.startsWith("/tmp/"));
    const area = absoluteScratchInput || virtualScratch ? "scratch" : "workspace";
    const base = area === "scratch" ? this.#scratch : this.#root;
    const relativeInput = virtualScratch ? input.slice(5) : input;
    const absolute =
      absoluteInput !== undefined && (absoluteWorkspaceInput || absoluteScratchInput)
        ? absoluteInput
        : virtualScratch
          ? resolve(base, relativeInput)
          : isAbsolute(input)
            ? resolve(input)
            : resolve(base, input);
    if (!isInside(base, absolute)) throw new Error("path escapes the Code Mode sandbox");
    if (area === "workspace") assertSafePathParts(relative(base, absolute));

    const existing = nearestExisting(absolute);
    const realExisting = realpathSync(existing);
    if (!isInside(base, realExisting))
      throw new Error("path resolves outside the Code Mode sandbox");
    if (existsSync(absolute)) {
      if (lstatSync(absolute).isSymbolicLink()) {
        throw new Error(
          options.write === true
            ? "writes through symbolic links are not allowed"
            : "symbolic links are not available in Code Mode",
        );
      }
      const real = realpathSync(absolute);
      if (!isInside(base, real)) throw new Error("path resolves outside the Code Mode sandbox");
    }
    return {
      absolute,
      display:
        area === "scratch"
          ? absolute === this.#scratch
            ? "/tmp"
            : `/tmp/${relative(this.#scratch, absolute).split(sep).join("/")}`
          : relative(this.#root, absolute).split(sep).join("/") || ".",
      area,
    };
  }

  readFile(path: string, maxBytes = DEFAULT_MAX_READ_BYTES): Buffer {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_READ_BYTES) {
      throw new Error(`maxBytes must be an integer from 1 to ${String(DEFAULT_MAX_READ_BYTES)}`);
    }
    const target = this.resolve(path);
    return this.#withParent(target, false, (parentFd, name) => {
      const fd = openSync(this.#descriptorPath(parentFd, name), FILE_READ_FLAGS);
      try {
        const stats = fstatSync(fd);
        if (!stats.isFile()) throw new Error("path must be a file");
        if (stats.size > maxBytes) {
          throw new Error(`file exceeds the ${String(maxBytes)}-byte Code Mode read limit`);
        }
        const content = readFileSync(fd);
        if (target.area === "workspace") assertSafeGitConfig(target.display, content);
        return content;
      } finally {
        closeSync(fd);
      }
    });
  }

  async withReadableFile<T>(
    path: string,
    operation: (descriptorPath: string) => Promise<T>,
  ): Promise<T> {
    const target = this.resolve(path);
    const fd = this.#withParent(target, false, (parentFd, name) =>
      openSync(this.#descriptorPath(parentFd, name), FILE_READ_FLAGS),
    );
    try {
      if (!fstatSync(fd).isFile()) throw new Error("path must be a file");
      return await operation(this.#descriptorPath(fd));
    } finally {
      closeSync(fd);
    }
  }

  access(path: string, write = false): void {
    const target = this.resolve(path, { write });
    this.#withParent(target, false, (parentFd, name) => {
      const descriptorPath = this.#descriptorPath(parentFd, name);
      if (lstatSync(descriptorPath).isSymbolicLink()) {
        throw new Error("symbolic links are not available in Code Mode");
      }
      accessSync(descriptorPath, write ? constants.R_OK | constants.W_OK : constants.R_OK);
    });
  }

  exists(path: string): boolean {
    try {
      const target = this.resolve(path);
      return this.#withParent(target, false, (parentFd, name) => {
        const stats = lstatSync(this.#descriptorPath(parentFd, name));
        return !stats.isSymbolicLink();
      });
    } catch {
      return false;
    }
  }

  stat(path: string): Stats {
    const target = this.resolve(path);
    return this.#withParent(target, false, (parentFd, name) => {
      const stats = lstatSync(this.#descriptorPath(parentFd, name));
      if (stats.isSymbolicLink()) throw new Error("symbolic links are not available in Code Mode");
      return stats;
    });
  }

  readdir(path: string): string[] {
    const target = this.resolve(path);
    return this.#withDirectory(target, false, (directoryFd) =>
      readdirSync(this.#descriptorPath(directoryFd))
        .filter((name) => {
          try {
            this.resolve(join(target.absolute, name));
            return true;
          } catch {
            return false;
          }
        })
        .sort((left, right) => left.localeCompare(right)),
    );
  }

  // The command scan fails closed across path, size, type, and traversal checks.
  // eslint-disable-next-line complexity
  assertCommandSafe(maxEntries = 50_000): void {
    this.#assertOpen();
    const pending = [this.#root];
    let scanned = 0;
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) continue;
      for (const name of readdirSync(directory)) {
        scanned += 1;
        if (scanned > maxEntries) throw new Error("workspace is too large for command safety scan");
        const rel = relative(this.#root, join(directory, name));
        try {
          assertSafePathParts(rel);
        } catch {
          throw new Error(`sandboxed commands are disabled while a sensitive path exists: ${rel}`);
        }
        const path = join(directory, name);
        let stats: ReturnType<typeof lstatSync>;
        try {
          stats = lstatSync(path);
        } catch {
          continue;
        }
        if (stats.isDirectory() && !stats.isSymbolicLink()) {
          pending.push(path);
        } else if (stats.isFile() && isGitCredentialConfigPath(rel)) {
          try {
            this.readFile(rel, MAX_GIT_CONFIG_BYTES);
          } catch {
            throw new Error(
              `sandboxed commands are disabled while credential-bearing Git configuration exists: ${rel}`,
            );
          }
        }
      }
    }
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    await this.mutate(() => {
      const target = this.resolve(path, { write: true });
      if (target.area === "scratch") {
        const usage = this.scratchUsage();
        assertScratchUsage(usage, this.#maxScratchBytes);
        const parentParts = this.#parts(target);
        parentParts.pop();
        assertProjectedScratchDirectories(
          usage,
          this.#maxScratchBytes,
          this.#missingDirectoryCount(target.area, parentParts),
        );
      }
      this.#withParent(target, true, (parentFd, name) => {
        const scratchUsage = target.area === "scratch" ? this.scratchUsage() : undefined;
        const targetPath = this.#descriptorPath(parentFd, name);
        const temporaryName = `.${name}.${randomUUID()}.tmp`;
        const temporaryPath = this.#descriptorPath(parentFd, temporaryName);
        let mode = 0o600;
        let replacedBytes = 0;
        let createsEntry = true;
        try {
          const stats = lstatSync(targetPath);
          if (stats.isSymbolicLink()) {
            throw new Error("symbolic links are not available in Code Mode");
          }
          mode = stats.mode & 0o777;
          replacedBytes = allocatedBytes(stats);
          createsEntry = false;
        } catch (error) {
          if (!isFileSystemError(error, "ENOENT")) throw error;
        }
        if (scratchUsage !== undefined) {
          assertProjectedScratchWrite(
            scratchUsage,
            this.#maxScratchBytes,
            replacedBytes,
            createsEntry,
            Buffer.byteLength(content),
          );
        }
        try {
          writeFileSync(temporaryPath, content, { flag: "wx", mode });
          renameSync(temporaryPath, targetPath);
        } catch (error) {
          rmSync(temporaryPath, { force: true });
          throw error;
        }
      });
    });
  }

  async mkdir(path: string): Promise<void> {
    await this.mutate(() => {
      const target = this.resolve(path, { write: true });
      if (target.area === "scratch") {
        const usage = this.scratchUsage();
        assertScratchUsage(usage, this.#maxScratchBytes);
        assertProjectedScratchDirectories(
          usage,
          this.#maxScratchBytes,
          this.#missingDirectoryCount(target.area, this.#parts(target)),
        );
      }
      this.#withDirectory(target, true, () => undefined);
      if (target.area === "scratch") this.assertScratchWithinLimit();
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.mutate(() => {
      const target = this.resolve(path, { write: true });
      this.#withParent(target, false, (parentFd, name) => {
        const fd = openSync(this.#descriptorPath(parentFd, name), FILE_READ_FLAGS);
        try {
          fchmodSync(fd, mode);
        } finally {
          closeSync(fd);
        }
      });
    });
  }

  async remove(path: string, recursive = false): Promise<void> {
    await this.mutate(() => {
      const target = this.resolve(path, { write: true });
      if (target.absolute === this.#root || target.absolute === this.#scratch) {
        throw new Error("cannot remove a sandbox root");
      }
      this.#withParent(target, false, (parentFd, name) => {
        const descriptorPath = this.#descriptorPath(parentFd, name);
        if (!recursive && lstatSync(descriptorPath).isDirectory()) {
          rmdirSync(descriptorPath);
        } else {
          rmSync(descriptorPath, { recursive, force: false });
        }
      });
    });
  }

  async move(from: string, to: string): Promise<void> {
    await this.mutate(() => {
      const source = this.resolve(from, { write: true });
      const target = this.resolve(to, { write: true });
      if (source.area !== target.area) throw new Error("moves cannot cross sandbox areas");
      this.#withParent(source, false, (sourceParentFd, sourceName) => {
        this.#withParent(target, true, (targetParentFd, targetName) => {
          renameSync(
            this.#descriptorPath(sourceParentFd, sourceName),
            this.#descriptorPath(targetParentFd, targetName),
          );
        });
      });
    });
  }

  async mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.#mutationContext.getStore() === true) return operation();
    const guarded = (): Promise<T> => this.#mutationContext.run(true, async () => operation());
    const run = this.#mutationQueue.then(guarded, guarded);
    this.#mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    closeSync(this.#rootFd);
    closeSync(this.#scratchFd);
    rmSync(this.#scratch, { recursive: true, force: true });
  }

  #descriptorPath(fd: number, name?: string): string {
    const base = `/proc/self/fd/${String(fd)}`;
    return name === undefined ? base : `${base}/${name}`;
  }

  #baseFd(area: ResolvedSandboxPath["area"]): number {
    return area === "scratch" ? this.#scratchFd : this.#rootFd;
  }

  #parts(target: ResolvedSandboxPath): string[] {
    const base = target.area === "scratch" ? this.#scratch : this.#root;
    return relative(base, target.absolute).split(sep).filter(Boolean);
  }

  #missingDirectoryCount(area: ResolvedSandboxPath["area"], parts: readonly string[]): number {
    let currentFd = this.#baseFd(area);
    let ownsCurrent = false;
    try {
      for (let index = 0; index < parts.length; index += 1) {
        let nextFd: number;
        try {
          nextFd = openSync(this.#descriptorPath(currentFd, parts[index]), DIRECTORY_OPEN_FLAGS);
        } catch (error) {
          if (isFileSystemError(error, "ENOENT")) return parts.length - index;
          throw error;
        }
        if (ownsCurrent) closeSync(currentFd);
        currentFd = nextFd;
        ownsCurrent = true;
      }
      return 0;
    } finally {
      if (ownsCurrent) closeSync(currentFd);
    }
  }

  #withParent<T>(
    target: ResolvedSandboxPath,
    createParents: boolean,
    operation: (parentFd: number, name: string) => T,
  ): T {
    const parts = this.#parts(target);
    const name = parts.pop() ?? ".";
    return this.#walkDirectories(target.area, parts, createParents, (parentFd) =>
      operation(parentFd, name),
    );
  }

  #withDirectory<T>(
    target: ResolvedSandboxPath,
    create: boolean,
    operation: (directoryFd: number) => T,
  ): T {
    return this.#walkDirectories(target.area, this.#parts(target), create, operation);
  }

  #walkDirectories<T>(
    area: ResolvedSandboxPath["area"],
    parts: readonly string[],
    create: boolean,
    operation: (directoryFd: number) => T,
  ): T {
    let currentFd = this.#baseFd(area);
    let ownsCurrent = false;
    try {
      for (const part of parts) {
        const path = this.#descriptorPath(currentFd, part);
        if (create) {
          try {
            mkdirSync(path, { mode: 0o700 });
          } catch (error) {
            if (!isFileSystemError(error, "EEXIST")) throw error;
          }
        }
        const nextFd = openSync(path, DIRECTORY_OPEN_FLAGS);
        if (ownsCurrent) closeSync(currentFd);
        currentFd = nextFd;
        ownsCurrent = true;
      }
      return operation(currentFd);
    } finally {
      if (ownsCurrent) closeSync(currentFd);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("workspace sandbox is closed");
  }
}

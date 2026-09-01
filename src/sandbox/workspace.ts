import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const SENSITIVE_NAMES = new Set([
  ".aws",
  ".azure",
  ".direnv",
  ".docker",
  ".env",
  ".envrc",
  ".git-credentials",
  ".gnupg",
  ".kube",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".ssh",
  "application_default_credentials.json",
  "auth.json",
  "credentials",
  "credentials.json",
  "gcloud",
  "secrets",
  "secrets.json",
  "service-account.json",
  "token",
  "tokens.json",
]);
const SENSITIVE_PREFIXES = [".env.", "id_dsa", "id_ed25519", "id_ecdsa", "id_rsa"];
const MAX_PATH_BYTES = 16 * 1024;
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export type ResolvedSandboxPath = {
  absolute: string;
  display: string;
  area: "workspace" | "scratch";
};

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertSafeParts(path: string): void {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  for (const part of parts) {
    const normalized = part.toLocaleLowerCase();
    if (
      SENSITIVE_NAMES.has(normalized) ||
      SENSITIVE_PREFIXES.some(
        (prefix) => normalized === prefix || normalized.startsWith(`${prefix}.`),
      )
    ) {
      throw new Error(`sensitive path is not available in Code Mode: ${part}`);
    }
  }
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
  #closed = false;
  #mutationQueue = Promise.resolve();
  readonly #mutationContext = new AsyncLocalStorage<boolean>();

  constructor(rootDir: string, scratchParent = tmpdir()) {
    this.#root = realpathSync(rootDir);
    if (!statSync(this.#root).isDirectory()) throw new Error("workspace root must be a directory");
    this.#rootFd = openSync(this.#root, DIRECTORY_OPEN_FLAGS);
    this.#scratch = realpathSync(mkdtempSync(join(scratchParent, "pi-code-mode-")));
    chmodSync(this.#scratch, 0o700);
    this.#scratchFd = openSync(this.#scratch, DIRECTORY_OPEN_FLAGS);
  }

  get root(): string {
    return this.#root;
  }

  get scratch(): string {
    return this.#scratch;
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
    if (area === "workspace") assertSafeParts(relative(base, absolute));

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

  readFile(path: string): Buffer {
    const target = this.resolve(path);
    return this.#withParent(target, false, (parentFd, name) => {
      const fd = openSync(
        this.#descriptorPath(parentFd, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        if (!fstatSync(fd).isFile()) throw new Error("path must be a file");
        return readFileSync(fd);
      } finally {
        closeSync(fd);
      }
    });
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
          assertSafeParts(rel);
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
        if (stats.isDirectory() && !stats.isSymbolicLink()) pending.push(path);
      }
    }
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    await this.mutate(() => {
      const target = this.resolve(path, { write: true });
      this.#withParent(target, true, (parentFd, name) => {
        const targetPath = this.#descriptorPath(parentFd, name);
        const temporaryName = `.${name}.${randomUUID()}.tmp`;
        const temporaryPath = this.#descriptorPath(parentFd, temporaryName);
        let mode = 0o600;
        try {
          const stats = lstatSync(targetPath);
          if (stats.isSymbolicLink()) {
            throw new Error("symbolic links are not available in Code Mode");
          }
          mode = stats.mode & 0o777;
        } catch (error) {
          if (!isFileSystemError(error, "ENOENT")) throw error;
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
      this.#withDirectory(target, true, () => undefined);
    });
  }

  async remove(path: string, recursive = false): Promise<void> {
    await this.mutate(() => {
      const target = this.resolve(path, { write: true });
      if (target.absolute === this.#root || target.absolute === this.#scratch) {
        throw new Error("cannot remove a sandbox root");
      }
      this.#withParent(target, false, (parentFd, name) => {
        rmSync(this.#descriptorPath(parentFd, name), { recursive, force: false });
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

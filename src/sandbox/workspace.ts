import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  readonly #scratch: string;
  #closed = false;
  #mutationQueue = Promise.resolve();
  readonly #mutationContext = new AsyncLocalStorage<boolean>();

  constructor(rootDir: string, scratchParent = tmpdir()) {
    this.#root = realpathSync(rootDir);
    if (!statSync(this.#root).isDirectory()) throw new Error("workspace root must be a directory");
    this.#scratch = realpathSync(mkdtempSync(join(scratchParent, "pi-code-mode-")));
    chmodSync(this.#scratch, 0o700);
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

    const absoluteWorkspaceInput = isAbsolute(input) && isInside(this.#root, resolve(input));
    const virtualScratch =
      !absoluteWorkspaceInput && (input === "/tmp" || input.startsWith("/tmp/"));
    const area = virtualScratch ? "scratch" : "workspace";
    const base = area === "scratch" ? this.#scratch : this.#root;
    const relativeInput = virtualScratch ? input.slice(5) : input;
    const absolute = virtualScratch
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
      const real = realpathSync(absolute);
      if (!isInside(base, real)) throw new Error("path resolves outside the Code Mode sandbox");
      if (options.write === true && lstatSync(absolute).isSymbolicLink()) {
        throw new Error("writes through symbolic links are not allowed");
      }
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
    if (!statSync(target.absolute).isFile()) throw new Error("path must be a file");
    return readFileSync(target.absolute);
  }

  access(path: string, write = false): void {
    const target = this.resolve(path, { write });
    accessSync(target.absolute, write ? constants.R_OK | constants.W_OK : constants.R_OK);
  }

  exists(path: string): boolean {
    try {
      return existsSync(this.resolve(path).absolute);
    } catch {
      return false;
    }
  }

  stat(path: string): Stats {
    return statSync(this.resolve(path).absolute);
  }

  readdir(path: string): string[] {
    const target = this.resolve(path);
    return readdirSync(target.absolute)
      .filter((name) => {
        try {
          this.resolve(join(target.absolute, name));
          return true;
        } catch {
          return false;
        }
      })
      .sort((left, right) => left.localeCompare(right));
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
        const slashRelative = rel.split(sep).join("/");
        const skippedDirectory =
          slashRelative === "node_modules" ||
          slashRelative === ".git/objects" ||
          slashRelative === "dist" ||
          slashRelative === "coverage";
        if (stats.isDirectory() && !stats.isSymbolicLink() && !skippedDirectory) pending.push(path);
      }
    }
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    await this.mutate(() => {
      const target = this.resolve(path, { write: true });
      mkdirSync(dirname(target.absolute), { recursive: true, mode: 0o700 });
      const temporary = join(
        dirname(target.absolute),
        `.${basename(target.absolute)}.${randomUUID()}.tmp`,
      );
      const mode = existsSync(target.absolute) ? statSync(target.absolute).mode & 0o777 : 0o600;
      try {
        writeFileSync(temporary, content, { flag: "wx", mode });
        renameSync(temporary, target.absolute);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
    });
  }

  async mkdir(path: string): Promise<void> {
    await this.mutate(() => {
      mkdirSync(this.resolve(path, { write: true }).absolute, { recursive: true, mode: 0o700 });
    });
  }

  async remove(path: string, recursive = false): Promise<void> {
    await this.mutate(() => {
      const target = this.resolve(path, { write: true });
      if (target.absolute === this.#root || target.absolute === this.#scratch) {
        throw new Error("cannot remove a sandbox root");
      }
      rmSync(target.absolute, { recursive, force: false });
    });
  }

  async move(from: string, to: string): Promise<void> {
    await this.mutate(() => {
      const source = this.resolve(from, { write: true });
      const target = this.resolve(to, { write: true });
      if (source.area !== target.area) throw new Error("moves cannot cross sandbox areas");
      mkdirSync(dirname(target.absolute), { recursive: true, mode: 0o700 });
      renameSync(source.absolute, target.absolute);
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
    rmSync(this.#scratch, { recursive: true, force: true });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("workspace sandbox is closed");
  }
}

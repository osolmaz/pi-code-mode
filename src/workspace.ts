import { AsyncLocalStorage } from "node:async_hooks";
import {
  accessSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type ResolvedWorkspacePath = {
  absolute: string;
  display: string;
};

export class Workspace {
  readonly #root: string;
  #closed = false;
  #mutationQueue = Promise.resolve();
  readonly #mutationContext = new AsyncLocalStorage<boolean>();

  constructor(rootDir: string) {
    this.#root = realpathSync(rootDir);
    if (!statSync(this.#root).isDirectory()) throw new Error("workspace root must be a directory");
  }

  get root(): string {
    return this.#root;
  }

  resolve(input: string): ResolvedWorkspacePath {
    this.#assertOpen();
    if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
      throw new Error("path is invalid or empty");
    }
    const absolute = isAbsolute(input) ? resolve(input) : resolve(this.#root, input);
    return { absolute, display: input };
  }

  access(path: string): void {
    accessSync(this.resolve(path).absolute);
  }

  readFile(path: string): Buffer {
    return readFileSync(this.resolve(path).absolute);
  }

  stat(path: string): Stats {
    return statSync(this.resolve(path).absolute);
  }

  exists(path: string): boolean {
    return existsSync(this.resolve(path).absolute);
  }

  async mutate<T>(operation: () => Promise<T> | T): Promise<T> {
    this.#assertOpen();
    if (this.#mutationContext.getStore() === true) return operation();

    const previous = this.#mutationQueue;
    let release = (): void => undefined;
    this.#mutationQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      return await this.#mutationContext.run(true, operation);
    } finally {
      release();
    }
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    await this.mutate(() => {
      const target = this.resolve(path).absolute;
      mkdirSync(dirname(target), { recursive: true });
      const temporary = `${target}.pi-code-mode-${randomUUID()}.tmp`;
      const mode = existsSync(target) ? lstatSync(target).mode & 0o777 : 0o644;
      try {
        writeFileSync(temporary, content, { flag: "wx", mode });
        renameSync(temporary, target);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
    });
  }

  async mkdir(path: string): Promise<void> {
    await this.mutate(() => {
      mkdirSync(this.resolve(path).absolute, { recursive: true });
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.mutate(() => {
      chmodSync(this.resolve(path).absolute, mode);
    });
  }

  async remove(path: string, recursive = false): Promise<void> {
    await this.mutate(() => {
      const target = this.resolve(path).absolute;
      if (target === this.#root) throw new Error("cannot remove the workspace root");
      if (!recursive && lstatSync(target).isDirectory()) rmdirSync(target);
      else rmSync(target, { recursive, force: false });
    });
  }

  async move(from: string, to: string): Promise<void> {
    await this.mutate(() => {
      const source = this.resolve(from).absolute;
      const target = this.resolve(to).absolute;
      mkdirSync(dirname(target), { recursive: true });
      renameSync(source, target);
    });
  }

  close(): void {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("workspace is closed");
  }
}

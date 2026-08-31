import type { CodeModeInvocationContext, CodeModeToolDescriptor } from "./types.js";

export class CodeModeBroker {
  readonly #byName: ReadonlyMap<string, CodeModeToolDescriptor>;
  readonly #controller = new AbortController();
  readonly #cwd: string;

  constructor(cwd: string, descriptors: readonly CodeModeToolDescriptor[]) {
    const byName = new Map<string, CodeModeToolDescriptor>();
    for (const descriptor of descriptors) {
      if (descriptor.effect !== "read") {
        throw new Error(
          `Code Mode only accepts read-only tools: ${descriptor.codeModeName} has ${descriptor.effect} effect`,
        );
      }
      if (descriptor.directOnly === true) continue;
      if (byName.has(descriptor.codeModeName)) {
        throw new Error(`duplicate Code Mode tool name: ${descriptor.codeModeName}`);
      }
      byName.set(descriptor.codeModeName, Object.freeze({ ...descriptor }));
    }
    this.#cwd = cwd;
    this.#byName = byName;
  }

  get descriptors(): readonly CodeModeToolDescriptor[] {
    return Object.freeze([...this.#byName.values()]);
  }

  cancel(): void {
    this.#controller.abort();
  }

  async invoke(
    tool: string,
    input: unknown,
    context: Omit<CodeModeInvocationContext, "cwd">,
  ): Promise<unknown> {
    this.#controller.signal.throwIfAborted();
    const descriptor = this.#byName.get(tool);
    if (descriptor === undefined) throw new Error(`tool is not allowed in this cell: ${tool}`);
    const result = await descriptor.invoke(
      input,
      { ...context, cwd: this.#cwd },
      this.#controller.signal,
    );
    this.#controller.signal.throwIfAborted();
    if (result === undefined) return null;
    JSON.stringify(result);
    return result;
  }
}

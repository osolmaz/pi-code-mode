import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CodeModeBroker,
  CodeModeHostManager,
  createReadOnlyCatalog,
  resolveLimits,
} from "../src/index.ts";

let callNumber;
let manager;
let root;
let session;

beforeEach(async () => {
  callNumber = 0;
  root = mkdtempSync(join(tmpdir(), "pi-code-mode-test-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "a.txt"), "alpha\nbeta\nalpha\n");
  writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n");
  manager = await CodeModeHostManager.start();
  session = await manager.openSession();
});

afterEach(async () => {
  await session?.close();
  await manager?.close();
  rmSync(root, { recursive: true, force: true });
});

function outputText(result) {
  return result.output
    .filter((output) => output.type === "text")
    .map((output) => output.text)
    .join("\n");
}

async function run(source, limitOverrides = {}) {
  callNumber += 1;
  const limits = resolveLimits(limitOverrides);
  const broker = new CodeModeBroker(root, createReadOnlyCatalog(root, limits));
  return session.exec(source, `test-${String(callNumber)}`, broker, limits);
}

describe("Deno Core execution host", () => {
  it("composes all read-only tools", async () => {
    const result = await run(`
const [listed, found, matches, read] = await Promise.all([
  tools.ls({ path: "." }),
  tools.find({ path: ".", pattern: "**/*.ts" }),
  tools.grep({ path: ".", pattern: "alpha" }),
  tools.read({ path: "src/x.ts" }),
]);
text({ listed, found, matches, read });`);

    expect(result.status).toBe("completed");
    const output = JSON.parse(outputText(result));
    expect(output.listed.map((entry) => entry.name)).toEqual(["a.txt", "src"]);
    expect(output.found).toEqual(["src/x.ts"]);
    expect(output.matches).toHaveLength(2);
    expect(output.read).toContain("export const x");
    expect(result.stats.toolCalls).toBe(4);
  });

  it("keeps Node, Deno, network, and module globals unavailable", async () => {
    const result = await run(`text([
      typeof process,
      typeof require,
      typeof Deno,
      typeof fetch,
      typeof WebSocket,
      typeof console,
      typeof WebAssembly,
      typeof SharedArrayBuffer,
      typeof Atomics,
    ]);`);

    expect(result.status).toBe("completed");
    expect(JSON.parse(outputText(result))).toEqual(Array(9).fill("undefined"));
  });

  it("blocks absolute paths, parent traversal, sensitive paths, and escaping symlinks", async () => {
    symlinkSync("/etc/passwd", join(root, "outside-link"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "secret\n");

    for (const source of [
      'text(await tools.read({ path: "/etc/passwd" }));',
      'text(await tools.read({ path: "../outside" }));',
      'text(await tools.read({ path: ".git/config" }));',
      'text(await tools.read({ path: "outside-link" }));',
    ]) {
      const result = await run(source);
      expect(result.status).toBe("failed");
      expect(result.error).toBeTruthy();
    }
  });

  it("enforces source and nested tool-call limits", async () => {
    await expect(run("x".repeat(101), { maxSourceBytes: 100 })).rejects.toThrow(
      "program source exceeds 100 bytes",
    );
    const calls = await run(
      'for (let i = 0; i < 3; i += 1) await tools.ls({ path: "." }); text("done");',
      { maxToolCalls: 2 },
    );
    expect(calls.status).toBe("failed");
    expect(calls.error).toContain("tool call limit");
  });

  it("propagates the Pi abort signal into an active V8 cell", async () => {
    const limits = resolveLimits();
    const broker = new CodeModeBroker(root, createReadOnlyCatalog(root, limits));
    const controller = new AbortController();
    const started = Date.now();
    const execution = session.exec(
      "while (true) {}",
      "abort-test",
      broker,
      limits,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    const result = await execution;

    expect(result.status).toBe("terminated");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("interrupts an infinite loop at the active CPU limit", async () => {
    const started = Date.now();

    const result = await run("while (true) {}", { cpuLimitMs: 100 });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("JavaScript CPU limit exceeded");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("bounds output at a UTF-8 boundary", async () => {
    const ascii = await run('text("x".repeat(5_000));', { maxOutputBytes: 128 });
    const unicode = await run('text("😀");', { maxOutputBytes: 3 });

    expect(ascii).toMatchObject({ status: "completed", truncated: true });
    expect(Buffer.byteLength(outputText(ascii), "utf8")).toBe(128);
    expect(unicode).toMatchObject({ status: "completed", truncated: true });
    expect(outputText(unicode)).toBe("");
  });

  it("yields a long cell and resumes it through wait", async () => {
    const limits = resolveLimits({ initialYieldTimeMs: 10 });
    const broker = new CodeModeBroker(root, createReadOnlyCatalog(root, limits));
    const initial = await session.exec(
      'await yield_control(); await new Promise((resolve) => setTimeout(() => { text("finished"); resolve(); }, 50));',
      "waiting-test",
      broker,
      limits,
    );

    expect(initial.status).toBe("waiting");
    const completed = await session.wait(initial.cellId, 1_000, 1_000, false, limits);
    expect(completed.status).toBe("completed");
    expect(outputText(completed)).toBe("finished");
  });

  it("persists explicit session store values between cells", async () => {
    const stored = await run('store("answer", { value: 42 }); text("stored");');
    const loaded = await run('text(load("answer"));');

    expect(stored.status).toBe("completed");
    expect(loaded.status).toBe("completed");
    expect(JSON.parse(outputText(loaded))).toEqual({ value: 42 });
  });

  it("returns syntax errors without crashing the host", async () => {
    const invalid = await run("this is not valid JavaScript {{{");
    const valid = await run('text("still alive");');

    expect(invalid.status).toBe("failed");
    expect(invalid.error).toContain("JavaScript initialization failed");
    expect(valid.status).toBe("completed");
    expect(outputText(valid)).toBe("still alive");
  });
});

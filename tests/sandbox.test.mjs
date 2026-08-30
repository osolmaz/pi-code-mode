import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeApprovedProgram } from "../src/index.ts";

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-code-mode-test-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "a.txt"), "alpha\nbeta\nalpha\n");
  writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function run(code, extra = {}) {
  return executeApprovedProgram({ code, rootDir: root, approve: () => true, ...extra });
}

describe("approved sandbox execution", () => {
  it("composes all read-only tools", async () => {
    const result = await run(`
const listed = await tools.ls({ path: "." });
const found = await tools.find({ path: ".", pattern: "**/*.ts" });
const matches = await tools.grep({ path: ".", pattern: "alpha" });
const read = await tools.read({ path: "src/x.ts" });
text({ listed, found, matches, read });`);

    expect(result.status).toBe("completed");
    const output = JSON.parse(result.output);
    expect(output.listed.map((entry) => entry.name)).toEqual(["a.txt", "src"]);
    expect(output.found).toEqual(["src/x.ts"]);
    expect(output.matches).toHaveLength(2);
    expect(output.read).toContain("export const x");
    expect(result.stats.toolCalls).toBe(4);
  });

  it("does not expose Node or network globals", async () => {
    const result = await run(
      "text([typeof process, typeof require, typeof fetch, typeof console, typeof WebSocket]);",
    );

    expect(result).toMatchObject({
      status: "completed",
      output: '["undefined","undefined","undefined","undefined","undefined"]',
    });
  });

  it("requires approval before starting a worker", async () => {
    const approve = vi.fn(() => false);
    const result = await executeApprovedProgram({
      code: "while (true) {}",
      rootDir: join(root, "missing"),
      approve,
    });

    expect(result.status).toBe("denied");
    expect(approve).toHaveBeenCalledOnce();
    expect(approve.mock.calls[0][0].code).toBe("while (true) {}");
  });

  it("rejects invalid limits and oversized source before approval", async () => {
    const approve = vi.fn(() => true);
    const oversized = await executeApprovedProgram({
      code: "x".repeat(101),
      rootDir: root,
      approve,
      limits: { maxSourceBytes: 100 },
    });
    const invalidLimit = await executeApprovedProgram({
      code: 'text("safe");',
      rootDir: root,
      approve,
      limits: { maxToolCalls: 0 },
    });

    expect(oversized).toMatchObject({ status: "failed" });
    expect(invalidLimit).toMatchObject({
      status: "failed",
      error: "maxToolCalls must be a positive safe integer",
    });
    expect(approve).not.toHaveBeenCalled();
  });

  it("honors aborts before approval and during execution", async () => {
    const before = new AbortController();
    const approve = vi.fn(() => true);
    before.abort();
    const beforeResult = await executeApprovedProgram({
      code: 'text("safe");',
      rootDir: root,
      approve,
      signal: before.signal,
    });

    const during = new AbortController();
    const duringResultPromise = executeApprovedProgram({
      code: "while (true) {}",
      rootDir: root,
      approve: () => {
        setTimeout(() => during.abort(), 50);
        return true;
      },
      signal: during.signal,
    });
    const duringResult = await duringResultPromise;

    expect(beforeResult).toMatchObject({ status: "failed", error: "execution aborted" });
    expect(approve).not.toHaveBeenCalled();
    expect(duringResult).toMatchObject({ status: "failed", error: "execution aborted" });
  });

  it("reports approval and worker setup failures", async () => {
    const approvalFailure = await executeApprovedProgram({
      code: 'text("safe");',
      rootDir: root,
      approve: () => {
        throw "approval failed";
      },
    });
    const setupFailure = await executeApprovedProgram({
      code: 'text("safe");',
      rootDir: join(root, "missing"),
      approve: () => true,
    });

    expect(approvalFailure).toMatchObject({ status: "failed", error: "approval failed" });
    expect(setupFailure).toMatchObject({ status: "failed" });
  });

  it("blocks absolute paths and parent traversal", async () => {
    const absolute = await run('text(await tools.read({ path: "/etc/passwd" }));');
    const parent = await run('text(await tools.read({ path: "../outside" }));');

    expect(absolute).toMatchObject({ status: "failed" });
    expect(absolute.error).toContain("absolute paths");
    expect(parent).toMatchObject({ status: "failed" });
    expect(parent.error).toContain("escapes");
  });

  it("blocks sensitive paths and symlink escapes", async () => {
    writeFileSync(join(root, ".env"), "TOKEN=secret\n");
    symlinkSync("/etc/hosts", join(root, "outside-link"));

    const sensitive = await run('text(await tools.read({ path: ".env" }));');
    const escaped = await run('text(await tools.read({ path: "outside-link" }));');

    expect(sensitive).toMatchObject({ status: "failed" });
    expect(sensitive.error).toContain("sensitive path");
    expect(escaped).toMatchObject({ status: "failed" });
    expect(escaped.error).toContain("symlink escapes");
  });

  it("interrupts infinite loops", async () => {
    const started = Date.now();
    const result = await run("while (true) {}", { limits: { timeoutMs: 200 } });

    expect(result).toMatchObject({ status: "failed" });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("stops recursive search at the result limit", async () => {
    mkdirSync(join(root, "one"));
    mkdirSync(join(root, "two"));
    writeFileSync(join(root, "one", "first.txt"), "alpha\n");
    writeFileSync(join(root, "one", "second.txt"), "alpha\n");
    writeFileSync(join(root, "two", "third.txt"), "alpha\n");
    const result = await run(`
const found = await tools.find({ path: ".", pattern: "**/*.txt", maxResults: 2 });
const matches = await tools.grep({ path: ".", pattern: "alpha", maxResults: 1 });
text({ found, matches });`);

    expect(result.status).toBe("completed");
    const output = JSON.parse(result.output);
    expect(output.found).toHaveLength(2);
    expect(output.matches).toHaveLength(1);
  });

  it("returns guest syntax errors without running another program", async () => {
    const result = await run("this is not valid JavaScript {{{");

    expect(result).toMatchObject({ status: "failed" });
    expect(result.error.length).toBeGreaterThan(0);
  });

  it("enforces nested tool-call limits", async () => {
    const result = await run(
      'for (let i = 0; i < 3; i += 1) await tools.ls({ path: "." }); text("done");',
      { limits: { maxToolCalls: 2 } },
    );

    expect(result).toMatchObject({ status: "failed" });
    expect(result.error).toContain("tool call limit");
  });

  it("truncates final output at a UTF-8 boundary", async () => {
    const result = await run('text("x".repeat(2_000));', { limits: { maxOutputBytes: 128 } });
    const unicode = await run('text("😀");', { limits: { maxOutputBytes: 3 } });

    expect(result).toMatchObject({ status: "completed", truncated: true });
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(128);
    expect(unicode).toMatchObject({ status: "completed", output: "", truncated: true });
  });
});

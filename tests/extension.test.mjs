import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCodeModeExtension } from "../src/extension/index.ts";

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-code-mode-extension-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function loadExtension(options = {}) {
  const events = new Map();
  const activeChanges = [];
  let tool;
  const api = {
    getActiveTools: () => ["read", "bash", "exec"],
    setActiveTools: (names) => activeChanges.push([...names]),
    registerTool: (definition) => {
      tool = definition;
    },
    on: (name, handler) => events.set(name, handler),
  };
  createCodeModeExtension(options)(api);
  return {
    events,
    activeChanges,
    get tool() {
      return tool;
    },
  };
}

function context(overrides = {}) {
  return {
    cwd: root,
    hasUI: false,
    ui: { confirm: vi.fn(() => false) },
    ...overrides,
  };
}

describe("Pi extension", () => {
  it("activates only exec and restores the prior tools", () => {
    const extension = loadExtension();

    extension.events.get("session_start")({}, context());
    extension.events.get("before_agent_start")({}, context());
    extension.events.get("session_shutdown")({}, context());

    expect(extension.activeChanges).toEqual([["exec"], ["exec"], ["read", "bash"]]);
  });

  it("denies non-interactive execution", async () => {
    const extension = loadExtension();
    const result = await extension.tool.execute(
      "call-1",
      { code: 'text("should not run");' },
      new AbortController().signal,
      undefined,
      context(),
    );

    expect(result.details.status).toBe("denied");
    expect(result.content[0].text).toContain("Execution denied");
  });

  it("returns sandbox failures as tool results", async () => {
    const extension = loadExtension({ approve: () => true });
    const result = await extension.tool.execute(
      "call-failed",
      { code: "invalid JavaScript {{{" },
      new AbortController().signal,
      undefined,
      context(),
    );

    expect(result.details.status).toBe("failed");
    expect(result.content[0].text).toContain("Execution failed");
  });

  it("reports empty and truncated approved output", async () => {
    const extension = loadExtension({ approve: () => true, limits: { maxOutputBytes: 4 } });
    const empty = await extension.tool.execute(
      "call-empty",
      { code: "const value = 1;" },
      undefined,
      undefined,
      context(),
    );
    const truncated = await extension.tool.execute(
      "call-truncated",
      { code: 'text("long output");' },
      undefined,
      undefined,
      context(),
    );

    expect(empty.content[0].text).toBe("Program completed with no text output.");
    expect(truncated.content[0].text).toContain("[output truncated at the sandbox limit]");
  });

  it("lets an interactive user deny the exact source", async () => {
    const confirm = vi.fn(() => false);
    const extension = loadExtension();
    const result = await extension.tool.execute(
      "call-user-denied",
      { code: 'text("safe");' },
      undefined,
      undefined,
      context({ hasUI: true, ui: { confirm } }),
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(result.details.status).toBe("denied");
  });

  it("shows and runs the exact approved source", async () => {
    const confirm = vi.fn(() => true);
    const extension = loadExtension();
    const code = 'text("safe");';
    const result = await extension.tool.execute(
      "call-2",
      { code },
      new AbortController().signal,
      undefined,
      context({ hasUI: true, ui: { confirm } }),
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][1]).toContain(code);
    expect(result).toMatchObject({ details: { status: "completed" } });
    expect(result.content[0].text).toBe("safe");
  });
});

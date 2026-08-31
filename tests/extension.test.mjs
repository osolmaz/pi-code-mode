import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    ...overrides,
  };
}

describe("Pi extension", () => {
  it("activates only exec and restores the prior tools", () => {
    const extension = loadExtension();

    extension.events.get("session_start")({}, context());
    extension.events.get("before_agent_start")({}, context());
    extension.events.get("session_shutdown")({}, context());

    expect(extension.tool.executionMode).toBe("sequential");
    expect(extension.activeChanges).toEqual([["exec"], ["exec"], ["read", "bash"]]);
  });

  it("runs non-interactively without an approval callback", async () => {
    const extension = loadExtension();
    const result = await extension.tool.execute(
      "call-1",
      { code: 'text("ran automatically");' },
      new AbortController().signal,
      undefined,
      context(),
    );

    expect(result.details.status).toBe("completed");
    expect(result.content[0].text).toBe("ran automatically");
  });

  it("returns sandbox failures as tool results", async () => {
    const extension = loadExtension();
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

  it("reports empty and truncated output", async () => {
    const extension = loadExtension({ limits: { maxOutputBytes: 4 } });
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

  it("does not use Pi UI confirmation", async () => {
    const extension = loadExtension();
    const result = await extension.tool.execute(
      "call-2",
      { code: 'text("safe");' },
      new AbortController().signal,
      undefined,
      context({
        hasUI: true,
        ui: {
          confirm: () => {
            throw new Error("confirmation must not be requested");
          },
        },
      }),
    );

    expect(result).toMatchObject({ details: { status: "completed" } });
    expect(result.content[0].text).toBe("safe");
  });
});

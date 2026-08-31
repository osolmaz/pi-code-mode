import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CODE_MODE_EXEC_CONSTRAINED_SAMPLING, createCodeModeExtension } from "../src/index.ts";

const SUPPORTED_MODEL = {
  id: "gpt-test",
  name: "GPT test",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
  compat: { supportsOpenAIGrammarTools: true },
};

let root;
let shutdown;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-code-mode-extension-"));
  shutdown = undefined;
});

afterEach(async () => {
  await shutdown?.();
  rmSync(root, { recursive: true, force: true });
});

function loadExtension(options = {}) {
  const events = new Map();
  const activeChanges = [];
  const tools = new Map();
  const api = {
    getActiveTools: () => ["read", "bash", "exec"],
    setActiveTools: (names) => activeChanges.push([...names]),
    registerTool: (definition) => tools.set(definition.name, definition),
    on: (name, handler) => events.set(name, handler),
  };
  createCodeModeExtension(options)(api);
  shutdown = async () => events.get("session_shutdown")?.({}, context());
  return { events, activeChanges, tools };
}

function context(overrides = {}) {
  return {
    cwd: root,
    model: SUPPORTED_MODEL,
    ...overrides,
  };
}

describe("Pi extension", () => {
  it("registers the OpenAI-shaped exec and wait contract", () => {
    const extension = loadExtension();
    const exec = extension.tools.get("exec");
    const wait = extension.tools.get("wait");

    expect([...extension.tools.keys()]).toEqual(["exec", "wait"]);
    expect(exec.constrainedSampling).toEqual(CODE_MODE_EXEC_CONSTRAINED_SAMPLING);
    expect(exec.executionMode).toBe("parallel");
    expect(wait.executionMode).toBe("parallel");
  });

  it("activates only exec and wait, then restores prior tools", async () => {
    const extension = loadExtension();

    await extension.events.get("session_start")({}, context());
    await extension.events.get("before_agent_start")({}, context());
    await extension.events.get("session_shutdown")({}, context());
    shutdown = undefined;

    expect(extension.activeChanges).toEqual([
      ["exec", "wait"],
      ["exec", "wait"],
      ["read", "bash"],
    ]);
  });

  it("rejects providers that do not advertise OpenAI grammar tools", async () => {
    const extension = loadExtension();
    const unsupported = {
      ...SUPPORTED_MODEL,
      provider: "other",
      api: "openai-completions",
      compat: {},
    };

    await expect(
      extension.events.get("before_agent_start")({}, context({ model: unsupported })),
    ).rejects.toThrow("does not advertise it");
  });

  it("executes raw JavaScript without an approval callback", async () => {
    const extension = loadExtension();
    const result = await extension.tools.get("exec").execute(
      "call-1",
      { code: 'text("ran automatically");' },
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

    expect(result.details.status).toBe("completed");
    expect(result.content[0].text).toBe("ran automatically");
  });

  it("resumes a yielded cell through the wait tool", async () => {
    const extension = loadExtension();
    const exec = await extension.tools
      .get("exec")
      .execute(
        "call-waiting",
        { code: 'await yield_control(); text("resumed");' },
        undefined,
        undefined,
        context(),
      );

    expect(exec.details.status).toBe("waiting");
    const waited = await extension.tools
      .get("wait")
      .execute(
        "wait-1",
        { cell_id: exec.details.cellId, yield_time_ms: 1_000, max_tokens: 1_000 },
        undefined,
        undefined,
        context(),
      );
    expect(waited.details.status).toBe("completed");
    expect(waited.content[0].text).toBe("resumed");
  });

  it("terminates a yielded cell with default wait options", async () => {
    const extension = loadExtension();
    const exec = await extension.tools
      .get("exec")
      .execute(
        "call-terminate",
        { code: "await yield_control();" },
        undefined,
        undefined,
        context(),
      );

    const terminated = await extension.tools
      .get("wait")
      .execute(
        "wait-terminate",
        { cell_id: exec.details.cellId, terminate: true },
        undefined,
        undefined,
        context(),
      );
    expect(terminated.details.status).toBe("terminated");
    expect(terminated.content[0].text).toBe("Cell terminated.");
  });

  it("returns guest failures as bounded tool results", async () => {
    const extension = loadExtension();
    const result = await extension.tools
      .get("exec")
      .execute(
        "call-failed",
        { code: "invalid JavaScript {{{" },
        new AbortController().signal,
        undefined,
        context(),
      );

    expect(result.details.status).toBe("failed");
    expect(result.content[0].text).toContain("Execution failed");
  });
});

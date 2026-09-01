import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CODE_MODE_COLLECT_EVENT,
  CODE_MODE_EXEC_CONSTRAINED_SAMPLING,
  CODE_MODE_REGISTER_EVENT,
  CODE_MODE_SESSION_ENTRY,
  createCodeModeExtension,
} from "../src/index.ts";

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
  const bus = new Map();
  const activeChanges = [];
  const tools = new Map();
  const commands = new Map();
  const entries = [];
  let active = ["read", "bash", "edit", "write"];
  const api = {
    getActiveTools: () => [...active],
    getAllTools: () =>
      ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"].map((name) => ({
        name,
        description: name,
        parameters: {},
        promptGuidelines: [],
        sourceInfo: {
          source: "builtin",
          path: `<builtin:${name}>`,
          scope: "user",
          origin: "top-level",
        },
      })),
    setActiveTools: (names) => {
      active = [...names];
      activeChanges.push([...names]);
    },
    registerTool: (definition) => tools.set(definition.name, definition),
    registerCommand: (name, definition) => commands.set(name, definition),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    events: {
      on: (name, handler) => {
        bus.set(name, handler);
        return () => bus.delete(name);
      },
      emit: (name, value) => bus.get(name)?.(value),
    },
    on: (name, handler) => events.set(name, handler),
  };
  createCodeModeExtension(options)(api);
  const makeContext = (overrides = {}) => ({
    cwd: root,
    model: SUPPORTED_MODEL,
    hasUI: false,
    mode: "tui",
    ui: {
      notify: () => undefined,
      select: async () => undefined,
      confirm: async () => false,
    },
    sessionManager: { getBranch: () => entries },
    ...overrides,
  });
  const start = async (overrides = {}) => {
    await events.get("session_start")({ reason: "startup" }, makeContext(overrides));
  };
  shutdown = async () => events.get("session_shutdown")?.({}, makeContext());
  return { api, bus, events, activeChanges, tools, commands, entries, start, context: makeContext };
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
    expect(extension.commands.has("code-mode")).toBe(true);
  });

  it("records the mode, activates only exec and wait, and restores prior tools", async () => {
    const extension = loadExtension();

    await extension.start();
    const prompt = await extension.events.get("before_agent_start")(
      { systemPrompt: "base" },
      extension.context(),
    );
    await extension.events.get("session_shutdown")({}, extension.context());
    shutdown = undefined;

    expect(extension.entries.some((entry) => entry.customType === CODE_MODE_SESSION_ENTRY)).toBe(
      true,
    );
    expect(prompt.systemPrompt).toContain("Code Mode (codex mode)");
    expect(extension.activeChanges).toEqual([
      ["exec", "wait"],
      ["exec", "wait"],
      ["read", "bash", "edit", "write"],
    ]);
  });

  it("snapshots the current vanilla Pi tools for each new session", async () => {
    const extension = loadExtension({ mode: "pi" });
    await extension.start();
    await extension.events.get("session_shutdown")({}, extension.context());

    extension.api.setActiveTools(["read", "grep"]);
    await extension.start({ sessionManager: { getBranch: () => [] } });

    expect(extension.entries.at(-1).data).toMatchObject({
      mode: "pi",
      piBuiltins: ["read", "grep"],
    });
  });

  it("rejects providers that do not advertise OpenAI grammar tools", async () => {
    const extension = loadExtension();
    await extension.start();
    const unsupported = {
      ...SUPPORTED_MODEL,
      provider: "other",
      api: "openai-completions",
      compat: {},
    };

    await expect(
      extension.events.get("before_agent_start")(
        { systemPrompt: "base" },
        extension.context({ model: unsupported }),
      ),
    ).rejects.toThrow("does not advertise it");
  });

  it("executes raw JavaScript without an approval callback", async () => {
    const extension = loadExtension();
    await extension.start();
    const result = await extension.tools
      .get("exec")
      .execute(
        "call-1",
        { code: 'text("ran automatically");' },
        new AbortController().signal,
        undefined,
        extension.context({ hasUI: true }),
      );

    expect(result.details.status).toBe("completed");
    expect(result.content[0].text).toBe("ran automatically");
  });

  it("writes files in Codex and Pi mode", async () => {
    const codex = loadExtension({ mode: "codex" });
    await codex.start();
    const patch = `*** Begin Patch\n*** Add File: codex.txt\n+codex\n*** End Patch`;
    const codexResult = await codex.tools
      .get("exec")
      .execute(
        "codex-write",
        { code: `text(await tools.apply_patch(${JSON.stringify(patch)}));` },
        undefined,
        undefined,
        codex.context(),
      );
    expect(codexResult.details.status).toBe("completed");
    expect(readFileSync(join(root, "codex.txt"), "utf8")).toBe("codex\n");
    await codex.events.get("session_shutdown")({}, codex.context());

    const pi = loadExtension({ mode: "pi" });
    await pi.start();
    const piResult = await pi.tools.get("exec").execute(
      "pi-write",
      {
        code: 'const result = await tools.write({path:"pi.txt",content:"pi\\n"}); text(result.content[0].text);',
      },
      undefined,
      undefined,
      pi.context(),
    );
    expect(piResult.details.status).toBe("completed");
    expect(existsSync(join(root, "pi.txt"))).toBe(true);
    expect(readFileSync(join(root, "pi.txt"), "utf8")).toBe("pi\n");
    await pi.events.get("session_shutdown")({}, pi.context());
    shutdown = undefined;
  });

  it("runs a Codex command from inside a JavaScript cell", async () => {
    const extension = loadExtension({ mode: "codex" });
    await extension.start();
    const result = await extension.tools.get("exec").execute(
      "codex-command",
      {
        code: 'const result = await tools.exec_command({cmd:"printf command > integrated.txt; printf done",yield_time_ms:2000}); text(result);',
      },
      undefined,
      undefined,
      extension.context(),
    );
    expect(result.details.status).toBe("completed");
    expect(JSON.parse(result.content[0].text).output).toBe("done");
    expect(result.details.mode).toBe("codex");
    expect(result.details.nestedToolTraces).toMatchObject([
      {
        name: "tools.exec_command",
        effect: "execute",
        status: "completed",
        input: { commandBytes: 44 },
      },
    ]);
    expect(readFileSync(join(root, "integrated.txt"), "utf8")).toBe("command");
  });

  it("restores a recorded mode instead of changing it from the current default", async () => {
    const extension = loadExtension({ mode: "pi" });
    extension.entries.push({
      type: "custom",
      customType: CODE_MODE_SESSION_ENTRY,
      data: { mode: "codex", piBuiltins: [], contractVersion: 1 },
    });
    await extension.start();
    const prompt = await extension.events.get("before_agent_start")(
      { systemPrompt: "base" },
      extension.context(),
    );
    expect(prompt.systemPrompt).toContain("Code Mode (codex mode)");
    expect(extension.tools.get("exec").description).toContain("codex mode tools");
  });

  it("changes mode before a conversation and saves the shared default", async () => {
    const configPath = join(root, "settings", "config.json");
    const extension = loadExtension({ mode: "codex", configPath });
    await extension.start();
    await extension.commands.get("code-mode").handler(
      "",
      extension.context({
        hasUI: true,
        ui: {
          notify: () => undefined,
          select: async () => "pi",
          confirm: async () => false,
        },
      }),
    );
    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved.mode).toBe("pi");
    expect(extension.entries.at(-1).data).toMatchObject({
      mode: "pi",
      piBuiltins: ["read", "bash", "edit", "write"],
    });
    expect(extension.tools.get("exec").description).toContain("pi mode tools");
    const prompt = await extension.events.get("before_agent_start")(
      { systemPrompt: "base" },
      extension.context(),
    );
    expect(prompt.systemPrompt).toContain("active vanilla Pi built-ins");
  });

  it("starts a new session when mode changes after a conversation", async () => {
    const configPath = join(root, "settings", "config.json");
    const extension = loadExtension({ mode: "codex", configPath });
    await extension.start();
    extension.entries.push({ type: "message" });
    let nextEntry;
    await extension.commands.get("code-mode").handler(
      "pi",
      extension.context({
        hasUI: true,
        ui: {
          notify: () => undefined,
          select: async () => undefined,
          confirm: async () => true,
        },
        newSession: async ({ setup }) => {
          await setup({
            appendCustomEntry: (customType, data) => {
              nextEntry = { customType, data };
            },
          });
          return { cancelled: false };
        },
      }),
    );
    expect(nextEntry).toMatchObject({
      customType: CODE_MODE_SESSION_ENTRY,
      data: {
        mode: "pi",
        piBuiltins: ["read", "bash", "edit", "write"],
        contractVersion: 1,
      },
    });
  });

  it("collects an explicitly registered nested tool before freezing the session", async () => {
    const extension = loadExtension();
    extension.bus.set(CODE_MODE_COLLECT_EVENT, () => {
      extension.api.events.emit(CODE_MODE_REGISTER_EVENT, {
        id: "fixture.echo",
        sdkPath: ["fixture", "echo"],
        modes: ["codex", "pi"],
        description: "Echo a fixture value.",
        kind: "function",
        effect: "read",
        replay: "safe",
        invoke: async (input) => input,
      });
    });
    await extension.start();
    const result = await extension.tools
      .get("exec")
      .execute(
        "registered-tool",
        { code: 'text(await tools.fixture.echo({value:"ok"}));' },
        undefined,
        undefined,
        extension.context(),
      );
    expect(result.details.status).toBe("completed");
    expect(JSON.parse(result.content[0].text)).toEqual({ value: "ok" });
  });

  it("rejects invalid or network-capable extension registrations", async () => {
    const invalid = loadExtension();
    invalid.bus.set(CODE_MODE_COLLECT_EVENT, () => {
      invalid.api.events.emit(CODE_MODE_REGISTER_EVENT, null);
    });
    await expect(invalid.start()).rejects.toThrow("invalid Code Mode registration");

    const network = loadExtension();
    network.bus.set(CODE_MODE_COLLECT_EVENT, () => {
      network.api.events.emit(CODE_MODE_REGISTER_EVENT, {
        id: "fixture.network",
        sdkPath: ["fixture", "network"],
        modes: ["codex"],
        description: "Network fixture.",
        kind: "function",
        effect: "network",
        replay: "unsafe",
        invoke: async () => null,
      });
    });
    await expect(network.start()).rejects.toThrow("effect is not allowed");
  });

  it("resumes and terminates yielded cells through wait", async () => {
    const extension = loadExtension();
    await extension.start();
    const exec = await extension.tools
      .get("exec")
      .execute(
        "call-waiting",
        { code: 'await yield_control(); text("resumed");' },
        undefined,
        undefined,
        extension.context(),
      );
    expect(exec.details.status).toBe("waiting");
    const waited = await extension.tools
      .get("wait")
      .execute(
        "wait-1",
        { cell_id: exec.details.cellId, yield_time_ms: 1_000, max_tokens: 1_000 },
        undefined,
        undefined,
        extension.context(),
      );
    expect(waited.details.status).toBe("completed");
    expect(waited.content[0].text).toBe("resumed");

    const waiting = await extension.tools
      .get("exec")
      .execute(
        "call-terminate",
        { code: "await yield_control();" },
        undefined,
        undefined,
        extension.context(),
      );
    const terminated = await extension.tools
      .get("wait")
      .execute(
        "wait-terminate",
        { cell_id: waiting.details.cellId, terminate: true },
        undefined,
        undefined,
        extension.context(),
      );
    expect(terminated.details.status).toBe("terminated");
  });

  it("returns bounded errors for unknown waits", async () => {
    const extension = loadExtension();
    await extension.start();
    const result = await extension.tools
      .get("wait")
      .execute(
        "unknown-wait",
        { cell_id: "missing", yield_time_ms: 1 },
        undefined,
        undefined,
        extension.context(),
      );
    expect(result.details.status).toBe("failed");
    expect(result.content[0].text).toContain("Wait failed");
  });

  it("returns guest failures as bounded tool results", async () => {
    const extension = loadExtension();
    await extension.start();
    const result = await extension.tools
      .get("exec")
      .execute(
        "call-failed",
        { code: "invalid JavaScript {{{" },
        new AbortController().signal,
        undefined,
        extension.context(),
      );

    expect(result.details.status).toBe("failed");
    expect(result.content[0].text).toContain("Execution failed");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CODE_MODE_SYSTEM_PROMPT,
  createCodeModeResourceLoader,
  createCodeModeRuntime,
  escapeApprovalText,
} from "../src/index.ts";

let agentDir;
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-code-mode-harness-root-"));
  agentDir = mkdtempSync(join(tmpdir(), "pi-code-mode-harness-agent-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
});

describe("approval display", () => {
  it("makes controls visible and distinguishes them from literal escapes", () => {
    const rendered = escapeApprovalText(`\\\u001b\r\t\u202e\nplain`);

    expect(rendered).toBe(
      ["\\\\", "\\u{001b}", "\\u{000d}", "\\u{0009}", "\\u{202e}", "\nplain"].join(""),
    );
    expect(rendered).not.toContain("\u001b");
  });
});

describe("standard Pi runtime", () => {
  it("uses the Code Mode agent directory and only exposes exec", async () => {
    const runtime = await createCodeModeRuntime({
      provider: "openai",
      model: "gpt-5.4",
      cwd: root,
      agentDir,
      approve: () => false,
    });

    try {
      expect(runtime.services.agentDir).toBe(agentDir);
      expect(runtime.services.resourceLoader.getExtensions().errors).toEqual([]);
      expect(runtime.services.resourceLoader.getExtensions().extensions).toHaveLength(1);
      expect(runtime.services.resourceLoader.getSkills()).toEqual({ skills: [], diagnostics: [] });
      expect(runtime.services.resourceLoader.getPrompts()).toEqual({
        prompts: [],
        diagnostics: [],
      });
      expect(runtime.services.resourceLoader.getAgentsFiles()).toEqual({ agentsFiles: [] });
      expect(runtime.services.resourceLoader.getSystemPrompt()).toBe(CODE_MODE_SYSTEM_PROMPT);
      expect(runtime.session.agent.state.tools.map((tool) => tool.name)).toEqual(["exec"]);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("SDK harness resource loader", () => {
  it("loads only the inline Code Mode extension and fixed prompt", async () => {
    const loader = await createCodeModeResourceLoader({
      cwd: root,
      agentDir,
      approve: () => false,
    });

    const extensions = loader.getExtensions();
    expect(extensions.errors).toEqual([]);
    expect(extensions.extensions).toHaveLength(1);
    expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
    expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(loader.getThemes()).toEqual({ themes: [], diagnostics: [] });
    expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
    expect(loader.getSystemPrompt()).toBe(CODE_MODE_SYSTEM_PROMPT);
    expect(loader.getAppendSystemPrompt()).toEqual([]);
  });
});

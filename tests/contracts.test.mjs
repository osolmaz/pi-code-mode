import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PI_BUILTINS,
  VANILLA_PI_BUILTINS,
  createCodexTools,
  createPiTools,
} from "../src/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function normalized(tool) {
  return {
    id: tool.id,
    sdkPath: [...tool.sdkPath],
    kind: tool.kind,
    effect: tool.effect,
    ...(tool.inputSchema?.required === undefined
      ? {}
      : { required: [...tool.inputSchema.required].sort() }),
    ...(tool.inputSchema?.properties === undefined
      ? {}
      : { properties: Object.keys(tool.inputSchema.properties).sort() }),
    ...(tool.outputSchema?.required === undefined
      ? {}
      : { outputRequired: [...tool.outputSchema.required].sort() }),
  };
}

describe("pinned upstream tool contracts", () => {
  it("matches the pinned Codex tool shape", () => {
    const expected = fixture("codex-contract.json");
    const tools = createCodexTools(
      {},
      {
        exec: async () => ({}),
        write: async () => ({}),
      },
    );
    expect(tools.map(normalized)).toEqual(expected.tools);
    expect(expected.source.revision).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("matches the pinned vanilla Pi built-ins and package version", () => {
    const expected = fixture("pi-contract.json");
    const packagePath = fileURLToPath(
      new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url),
    );
    const installed = JSON.parse(readFileSync(packagePath, "utf8"));
    expect(installed.version).toBe(expected.source.version);
    expect(VANILLA_PI_BUILTINS).toEqual(expected.allBuiltins);
    expect(DEFAULT_PI_BUILTINS).toEqual(expected.defaultBuiltins);

    const root = mkdtempSync(join(tmpdir(), "pi-code-mode-contract-"));
    try {
      const tools = createPiTools(DEFAULT_PI_BUILTINS, root, {
        model: undefined,
        thinkingLevel: "off",
        sessionManager: {
          getSessionId: () => "contract-test",
          getSessionFile: () => undefined,
        },
      });
      expect(tools.map(normalized)).toEqual(expected.defaultTools);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

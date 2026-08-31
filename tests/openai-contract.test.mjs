import { describe, expect, it } from "vitest";

import {
  CODE_MODE_EXEC_CONSTRAINED_SAMPLING,
  CODE_MODE_EXEC_GRAMMAR,
  assertOpenAICodeMode,
  parseExecOptions,
  resolveLimits,
  supportsOpenAICodeMode,
} from "../src/index.ts";

function model(overrides = {}) {
  return {
    id: "test",
    name: "Test",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
    compat: { supportsOpenAIGrammarTools: true },
    ...overrides,
  };
}

describe("OpenAI Code Mode contract", () => {
  it("uses the Codex-compatible Lark grammar as a freeform tool contract", () => {
    expect(CODE_MODE_EXEC_GRAMMAR).toBe(`start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \\t]*\\/\\/ @exec:[^\\r\\n]*/
NEWLINE: /\\r?\\n/
SOURCE: /[\\s\\S]+/`);
    expect(CODE_MODE_EXEC_CONSTRAINED_SAMPLING).toEqual({
      type: "grammar",
      variants: { openai_lark: CODE_MODE_EXEC_GRAMMAR },
    });
  });

  it("parses the optional first-line exec pragma", () => {
    const limits = resolveLimits();
    expect(parseExecOptions('text("plain");', limits)).toEqual({
      yieldTimeMs: 10_000,
      maxOutputBytes: 40_000,
    });
    expect(
      parseExecOptions(
        '// @exec:{"yield_time_ms":250,"max_output_tokens":100}\ntext("configured");',
        limits,
      ),
    ).toEqual({ yieldTimeMs: 250, maxOutputBytes: 400 });
    expect(parseExecOptions('// @exec:{"yield_time_ms":25}\ntext(1);', limits)).toEqual({
      yieldTimeMs: 25,
      maxOutputBytes: 40_000,
    });
    expect(parseExecOptions('// @exec:{"max_output_tokens":25}\ntext(1);', limits)).toEqual({
      yieldTimeMs: 10_000,
      maxOutputBytes: 100,
    });
  });

  it("rejects malformed, unknown, and out-of-range exec options", () => {
    const limits = resolveLimits();
    expect(() => parseExecOptions("", limits)).toThrow("program source is empty");
    expect(() => parseExecOptions("// @exec:nope\ntext(1);", limits)).toThrow(
      "invalid @exec pragma JSON",
    );
    expect(() => parseExecOptions("// @exec:[]\ntext(1);", limits)).toThrow(
      "@exec pragma must be a JSON object",
    );
    expect(() => parseExecOptions('// @exec:{"other":1}\ntext(1);', limits)).toThrow(
      "unknown @exec option",
    );
    for (const value of [-1, 1.5, 30 * 60 * 1_000 + 1]) {
      expect(() =>
        parseExecOptions(`// @exec:{"yield_time_ms":${String(value)}}\ntext(1);`, limits),
      ).toThrow();
    }
    for (const value of [0, 1.5, 32_001]) {
      expect(() =>
        parseExecOptions(`// @exec:{"max_output_tokens":${String(value)}}\ntext(1);`, limits),
      ).toThrow();
    }
  });

  it("uses advertised transport capability rather than model-name checks", () => {
    expect(supportsOpenAICodeMode(model({ id: "any-future-model" }))).toBe(true);
    expect(supportsOpenAICodeMode(model({ api: "azure-openai-responses" }))).toBe(true);
    expect(supportsOpenAICodeMode(model({ api: "openai-codex-responses" }))).toBe(true);
    expect(supportsOpenAICodeMode(undefined)).toBe(false);
    expect(supportsOpenAICodeMode(model({ compat: undefined }))).toBe(false);
    expect(supportsOpenAICodeMode(model({ compat: { supportsOpenAIGrammarTools: false } }))).toBe(
      false,
    );
    expect(supportsOpenAICodeMode(model({ api: "anthropic-messages" }))).toBe(false);
    expect(() => assertOpenAICodeMode(model())).not.toThrow();
    expect(() => assertOpenAICodeMode(undefined)).toThrow("requires a selected model");
    expect(() => assertOpenAICodeMode(model({ api: "openai-completions" }))).toThrow(
      "does not advertise it",
    );
  });

  it("validates configured safety limits", () => {
    expect(resolveLimits({ maxToolCalls: 1 }).maxToolCalls).toBe(1);
    for (const value of [0, 1.5, 65]) {
      expect(() => resolveLimits({ maxToolCalls: value })).toThrow(
        "maxToolCalls must be a positive safe integer",
      );
    }
  });
});

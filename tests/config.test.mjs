import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSessionContract,
  getCodeModeConfigPath,
  loadCodeModeConfig,
  normalizePiBuiltins,
  parseCodeModeConfig,
  parseSessionContract,
  saveCodeModeConfig,
} from "../src/index.ts";

let root;
let configPath;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-code-mode-config-"));
  configPath = join(root, "config", "pi-code-mode", "config.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Code Mode user config", () => {
  it("uses XDG_CONFIG_HOME and falls back to the user config directory", () => {
    expect(getCodeModeConfigPath({ XDG_CONFIG_HOME: join(root, "xdg") }, "/home/test")).toBe(
      join(root, "xdg", "pi-code-mode", "config.json"),
    );
    expect(getCodeModeConfigPath({}, "/home/test")).toBe(
      "/home/test/.config/pi-code-mode/config.json",
    );
    expect(getCodeModeConfigPath({ XDG_CONFIG_HOME: "   " }, "/home/test")).toBe(
      "/home/test/.config/pi-code-mode/config.json",
    );
    expect(
      getCodeModeConfigPath({ XDG_CONFIG_HOME: ` ${join(root, "trimmed")} ` }, "/home/test"),
    ).toBe(join(root, "trimmed", "pi-code-mode", "config.json"));
    expect(() => getCodeModeConfigPath({ XDG_CONFIG_HOME: "relative" }, "/home/test")).toThrow(
      "must be an absolute path",
    );
  });

  it("saves and loads only nonsecret provider configuration with private permissions", () => {
    const config = {
      provider: "openai",
      model: "gpt-5.4",
      apiKeyEnv: "OPENAI_API_KEY",
    };

    saveCodeModeConfig(config, configPath);

    expect(loadCodeModeConfig(configPath)).toEqual(config);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "config", "pi-code-mode")).mode & 0o777).toBe(0o700);
    const saved = readFileSync(configPath, "utf8");
    expect(saved).toContain("OPENAI_API_KEY");
    expect(saved).not.toContain('apiKey"');
  });

  it("returns undefined for a missing config", () => {
    expect(loadCodeModeConfig(configPath)).toBeUndefined();
  });

  it("normalizes strings and supports a mode-only extension config", () => {
    expect(parseCodeModeConfig({ provider: " openai ", model: " gpt-5.4 ", mode: "pi" })).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      mode: "pi",
    });
    expect(parseCodeModeConfig({ mode: "codex" })).toEqual({ mode: "codex" });
  });

  it("rejects unknown, secret, and malformed fields", () => {
    for (const value of [null, [], "config"]) {
      expect(() => parseCodeModeConfig(value)).toThrow("config must be a JSON object");
    }
    expect(() =>
      parseCodeModeConfig({ provider: "openai", model: "gpt-5.4", apiKey: "secret" }),
    ).toThrow("unknown config field");
    expect(() => parseCodeModeConfig({ provider: 7, model: "gpt-5.4" })).toThrow(
      "provider must be a non-empty string",
    );
    expect(() => parseCodeModeConfig({ provider: "openai", model: 7 })).toThrow(
      "model must be a non-empty string",
    );
    expect(() =>
      parseCodeModeConfig({ provider: "openai", model: "gpt-5.4", apiKeyEnv: 7 }),
    ).toThrow("apiKeyEnv must be a non-empty string");
    expect(() =>
      parseCodeModeConfig({ provider: "openai", model: "gpt-5.4", apiKeyEnv: "bad name" }),
    ).toThrow("environment-variable name");
    expect(() => parseCodeModeConfig({ provider: "", model: "gpt-5.4" })).toThrow(
      "provider must be a non-empty string",
    );
    expect(() => parseCodeModeConfig({ mode: "hybrid" })).toThrow("mode must be codex or pi");
  });

  it("normalizes and validates persisted session contracts", () => {
    expect(normalizePiBuiltins(["write", "read", "write", "custom"])).toEqual(["read", "write"]);
    expect(createSessionContract("codex", ["read"])).toEqual({
      mode: "codex",
      piBuiltins: [],
      contractVersion: 1,
    });
    expect(
      parseSessionContract({ mode: "pi", piBuiltins: ["write", "read"], contractVersion: 1 }),
    ).toEqual({ mode: "pi", piBuiltins: ["read", "write"], contractVersion: 1 });
    for (const value of [
      null,
      [],
      {},
      { mode: "pi", piBuiltins: [], contractVersion: 2 },
      { mode: "other", piBuiltins: [], contractVersion: 1 },
      { mode: "pi", piBuiltins: "read", contractVersion: 1 },
      { mode: "pi", piBuiltins: [7], contractVersion: 1 },
    ]) {
      expect(parseSessionContract(value)).toBeUndefined();
    }
  });

  it("accepts the exact size limit and rejects invalid or oversized files", () => {
    mkdirSync(join(root, "config", "pi-code-mode"), { recursive: true });
    writeFileSync(configPath, "not JSON");
    expect(() => loadCodeModeConfig(configPath)).toThrow("invalid Code Mode config");

    const config = JSON.stringify({ provider: "openai", model: "gpt-5.4" });
    writeFileSync(configPath, config.padEnd(16 * 1024, " "));
    expect(loadCodeModeConfig(configPath)).toEqual({ provider: "openai", model: "gpt-5.4" });

    writeFileSync(configPath, "x".repeat(16 * 1024 + 1));
    expect(() => loadCodeModeConfig(configPath)).toThrow("exceeds 16384 bytes");
  });
});

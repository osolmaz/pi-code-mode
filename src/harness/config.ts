import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { parseCodeModeMode, type CodeModeMode } from "../core/mode.js";

const MAX_CONFIG_BYTES = 16 * 1024;
const CONFIG_KEYS = new Set(["provider", "model", "apiKeyEnv", "mode"]);
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export type CodeModeConfig = {
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  mode?: CodeModeMode;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

// Each optional config field has its own validation rule.
// eslint-disable-next-line complexity
export function parseCodeModeConfig(value: unknown): CodeModeConfig {
  if (!isRecord(value)) throw new Error("config must be a JSON object");
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`unknown config field: ${key}`);
  }

  const providerValue = value["provider"];
  const modelValue = value["model"];
  const apiKeyEnvValue = value["apiKeyEnv"];
  const modeValue = value["mode"];
  const provider =
    providerValue === undefined ? undefined : requiredString(providerValue, "provider");
  const model = modelValue === undefined ? undefined : requiredString(modelValue, "model");
  const apiKeyEnv =
    apiKeyEnvValue === undefined ? undefined : requiredString(apiKeyEnvValue, "apiKeyEnv");
  if (apiKeyEnv !== undefined && !ENVIRONMENT_NAME.test(apiKeyEnv)) {
    throw new Error("apiKeyEnv must be an environment-variable name");
  }
  const mode = modeValue === undefined ? undefined : parseCodeModeMode(modeValue);
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(mode === undefined ? {} : { mode }),
  };
}

export function getCodeModeConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const configuredHome = environment["XDG_CONFIG_HOME"]?.trim();
  if (configuredHome !== undefined && configuredHome.length > 0) {
    if (!isAbsolute(configuredHome)) throw new Error("XDG_CONFIG_HOME must be an absolute path");
    return join(configuredHome, "pi-code-mode", "config.json");
  }
  return join(homeDirectory, ".config", "pi-code-mode", "config.json");
}

export function loadCodeModeConfig(path = getCodeModeConfigPath()): CodeModeConfig | undefined {
  if (!existsSync(path)) return undefined;
  if (statSync(path).size > MAX_CONFIG_BYTES) {
    throw new Error(`Code Mode config exceeds ${String(MAX_CONFIG_BYTES)} bytes`);
  }
  try {
    return parseCodeModeConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid Code Mode config: ${message}`);
  }
}

export function saveCodeModeConfig(config: CodeModeConfig, path = getCodeModeConfigPath()): void {
  const validated = parseCodeModeConfig(config);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  const temporary = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(validated, undefined, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export const CODE_MODE_MODES = ["codex", "pi"] as const;

export type CodeModeMode = (typeof CODE_MODE_MODES)[number];

export const DEFAULT_CODE_MODE_MODE: CodeModeMode = "codex";
export const CODE_MODE_CONTRACT_VERSION = 1;
export const CODE_MODE_SESSION_ENTRY = "pi-code-mode/session";

export const VANILLA_PI_BUILTINS = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;
export type VanillaPiBuiltin = (typeof VANILLA_PI_BUILTINS)[number];

export const DEFAULT_PI_BUILTINS: readonly VanillaPiBuiltin[] = Object.freeze([
  "read",
  "bash",
  "edit",
  "write",
]);

export type CodeModeSessionContract = {
  mode: CodeModeMode;
  piBuiltins: readonly VanillaPiBuiltin[];
  contractVersion: typeof CODE_MODE_CONTRACT_VERSION;
};

export function parseCodeModeMode(value: unknown, field = "mode"): CodeModeMode {
  if (value === "codex" || value === "pi") return value;
  throw new Error(`${field} must be codex or pi`);
}

export function isVanillaPiBuiltin(value: string): value is VanillaPiBuiltin {
  return (VANILLA_PI_BUILTINS as readonly string[]).includes(value);
}

export function normalizePiBuiltins(values: readonly string[]): readonly VanillaPiBuiltin[] {
  const unique = new Set(values.filter(isVanillaPiBuiltin));
  return Object.freeze(VANILLA_PI_BUILTINS.filter((name) => unique.has(name)));
}

export function createSessionContract(
  mode: CodeModeMode,
  piBuiltins: readonly string[] = DEFAULT_PI_BUILTINS,
): CodeModeSessionContract {
  return Object.freeze({
    mode,
    piBuiltins: mode === "pi" ? normalizePiBuiltins(piBuiltins) : Object.freeze([]),
    contractVersion: CODE_MODE_CONTRACT_VERSION,
  });
}

// A persisted contract must fail closed when any field is malformed.
// eslint-disable-next-line complexity
export function parseSessionContract(value: unknown): CodeModeSessionContract | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record["contractVersion"] !== CODE_MODE_CONTRACT_VERSION) return undefined;
  const mode = record["mode"];
  const piBuiltins = record["piBuiltins"];
  if ((mode !== "codex" && mode !== "pi") || !Array.isArray(piBuiltins)) return undefined;
  if (!piBuiltins.every((item): item is string => typeof item === "string")) return undefined;
  return createSessionContract(mode, piBuiltins);
}

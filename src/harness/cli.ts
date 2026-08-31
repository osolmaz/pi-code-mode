#!/usr/bin/env node

import { stderr, stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import {
  getCodeModeConfigPath,
  loadCodeModeConfig,
  saveCodeModeConfig,
  type CodeModeConfig,
} from "./config.js";
import { runCodeModePrompt, runCodeModeRepl } from "./index.js";
import { createTerminalApproval } from "./terminal-approval.js";

type CliArguments = {
  config: CodeModeConfig;
  configPath: string;
  cwd: string;
  prompt?: string;
  apiKey?: string;
  saveConfig: boolean;
};

const HELP = `Usage: pi-code-mode [options] [prompt]

Runs Pi with only the approved Code Mode exec tool. With no prompt, starts an interactive in-memory session.

Options:
  --provider <provider>    Override the configured Pi provider
  --model <model>          Override the configured model
  --api-key-env <name>     Read the provider credential from this environment variable
  --cwd <directory>        Set the read-only sandbox root (default: current directory)
  --save-config            Save the effective provider, model, and API-key variable name
  -h, --help               Show this help

The user config is stored under the XDG config directory. It never stores an API key. CLI options override saved values. Type /exit or /quit to leave interactive mode.`;

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

type CliState = {
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  cwd: string;
  promptParts: string[];
  saveConfig: boolean;
};

type OptionSpec = {
  consumed: number;
  apply: (state: CliState, args: string[], index: number) => void;
};

const OPTION_SPECS: Record<string, OptionSpec> = {
  "--provider": {
    consumed: 2,
    apply: (state, args, index) => {
      state.provider = takeValue(args, index, "--provider");
    },
  },
  "--model": {
    consumed: 2,
    apply: (state, args, index) => {
      state.model = takeValue(args, index, "--model");
    },
  },
  "--cwd": {
    consumed: 2,
    apply: (state, args, index) => {
      state.cwd = resolve(takeValue(args, index, "--cwd"));
    },
  },
  "--api-key-env": {
    consumed: 2,
    apply: (state, args, index) => {
      state.apiKeyEnv = takeValue(args, index, "--api-key-env");
    },
  },
  "--save-config": {
    consumed: 1,
    apply: (state) => {
      state.saveConfig = true;
    },
  },
  "--help": {
    consumed: 1,
    apply: () => {
      stdout.write(`${HELP}\n`);
      process.exit(0);
    },
  },
  "-h": {
    consumed: 1,
    apply: () => {
      stdout.write(`${HELP}\n`);
      process.exit(0);
    },
  },
};

function requiredConfigValue(
  explicit: string | undefined,
  saved: string | undefined,
  flag: string,
  configPath: string,
): string {
  const selected = explicit ?? saved;
  if (selected === undefined)
    throw new Error(`${flag} is required or must be set in ${configPath}`);
  return selected;
}

function effectiveConfig(
  state: CliState,
  saved: CodeModeConfig | undefined,
  configPath: string,
): CodeModeConfig {
  const provider = requiredConfigValue(state.provider, saved?.provider, "--provider", configPath);
  const model = requiredConfigValue(state.model, saved?.model, "--model", configPath);
  const apiKeyEnv = state.apiKeyEnv ?? saved?.apiKeyEnv;
  return { provider, model, ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }) };
}

function finalizeArguments(state: CliState): CliArguments {
  const configPath = getCodeModeConfigPath();
  const config = effectiveConfig(state, loadCodeModeConfig(configPath), configPath);
  const apiKey = config.apiKeyEnv === undefined ? undefined : process.env[config.apiKeyEnv];
  if (config.apiKeyEnv !== undefined && (apiKey === undefined || apiKey.length === 0)) {
    throw new Error(`environment variable is not set: ${config.apiKeyEnv}`);
  }
  return {
    config,
    configPath,
    cwd: state.cwd,
    ...(state.promptParts.length === 0 ? {} : { prompt: state.promptParts.join(" ") }),
    ...(apiKey === undefined ? {} : { apiKey }),
    saveConfig: state.saveConfig,
  };
}

function parseArguments(args: string[]): CliArguments {
  const state: CliState = { cwd: process.cwd(), promptParts: [], saveConfig: false };
  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (argument === undefined) throw new Error("invalid empty argument");
    if (argument === "--") {
      state.promptParts.push(...args.slice(index + 1));
      break;
    }
    const option = OPTION_SPECS[argument];
    if (option !== undefined) {
      option.apply(state, args, index);
      index += option.consumed;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`unknown option: ${argument}`);
    state.promptParts.push(argument);
    index += 1;
  }
  return finalizeArguments(state);
}

function readTerminalPrompt(): Promise<string | undefined> {
  return new Promise((resolvePrompt) => {
    const interface_ = createInterface({ input: stdin, output: stderr, terminal: true });
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      interface_.close();
      resolvePrompt(value);
    };
    interface_.once("close", () => {
      finish(undefined);
    });
    interface_.once("SIGINT", () => {
      finish(undefined);
    });
    interface_.question("code-mode> ", (answer) => {
      const command = answer.trim().toLocaleLowerCase();
      finish(command === "/exit" || command === "/quit" ? undefined : answer);
    });
  });
}

async function runInteractive(args: CliArguments): Promise<void> {
  if (!stdin.isTTY || !stderr.isTTY) throw new Error("interactive mode requires a terminal");
  stderr.write(
    `Pi Code Mode\nModel: ${args.config.provider}/${args.config.model}\nRoot: ${args.cwd}\nType /exit or /quit to leave.\n\n`,
  );
  await runCodeModeRepl({
    provider: args.config.provider,
    model: args.config.model,
    cwd: args.cwd,
    approve: createTerminalApproval(),
    nextPrompt: readTerminalPrompt,
    onText: (text) => {
      stdout.write(text);
    },
    onTurnEnd: () => {
      stdout.write("\n");
    },
    onWarning: (warning) => {
      stderr.write(`Warning: ${warning}\n`);
    },
    ...(args.apiKey === undefined ? {} : { apiKey: args.apiKey }),
  });
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.saveConfig) {
    saveCodeModeConfig(args.config, args.configPath);
    stderr.write(`Saved config: ${args.configPath}\n`);
  }
  if (args.prompt === undefined) {
    await runInteractive(args);
    return;
  }
  await runCodeModePrompt({
    provider: args.config.provider,
    model: args.config.model,
    cwd: args.cwd,
    prompt: args.prompt,
    approve: createTerminalApproval(),
    onText: (text) => {
      stdout.write(text);
    },
    ...(args.apiKey === undefined ? {} : { apiKey: args.apiKey }),
  });
  stdout.write("\n");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`pi-code-mode: ${message}\n`);
  process.exitCode = 1;
});

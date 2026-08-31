#!/usr/bin/env node

import { resolve } from "node:path";
import { stderr, stdin, stdout } from "node:process";

import {
  getCodeModeConfigPath,
  loadCodeModeConfig,
  saveCodeModeConfig,
  type CodeModeConfig,
} from "./config.js";
import { runCodeModeInteractive } from "./index.js";

type CliArguments = {
  config: CodeModeConfig;
  configPath: string;
  cwd: string;
  prompt?: string;
  apiKey?: string;
  saveConfig: boolean;
};

const HELP = `Usage: pi-code-mode [options] [prompt]

Runs Pi's standard interactive TUI with only the approved Code Mode exec tool.
A prompt argument becomes the initial message.

Options:
  --provider <provider>    Override the configured Pi provider
  --model <model>          Override the configured model
  --api-key-env <name>     Read the provider credential from this environment variable
  --cwd <directory>        Set the initial read-only sandbox root (default: current directory)
  --save-config            Save the effective provider, model, and API-key variable name
  -h, --help               Show this help

The user config is stored under the XDG config directory. It never stores an API key. CLI options override saved values. Use Pi's standard controls to work with or leave the session.`;

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
  if (selected === undefined) {
    throw new Error(`${flag} is required or must be set in ${configPath}`);
  }
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
  const state: CliState = {
    cwd: process.cwd(),
    promptParts: [],
    saveConfig: false,
  };
  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (argument === undefined) break;
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

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.saveConfig) {
    saveCodeModeConfig(args.config, args.configPath);
    stderr.write(`Saved config: ${args.configPath}\n`);
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("interactive mode requires a terminal");
  }
  await runCodeModeInteractive({
    provider: args.config.provider,
    model: args.config.model,
    cwd: args.cwd,
    ...(args.apiKey === undefined ? {} : { apiKey: args.apiKey }),
    ...(args.prompt === undefined ? {} : { initialMessage: args.prompt }),
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`pi-code-mode: ${message}\n`);
  process.exitCode = 1;
});

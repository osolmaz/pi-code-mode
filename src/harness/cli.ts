#!/usr/bin/env node

import { resolve } from "node:path";

import { runCodeModePrompt } from "./index.js";
import { createTerminalApproval } from "./terminal-approval.js";

type CliArguments = {
  provider: string;
  model: string;
  cwd: string;
  prompt: string;
  apiKey?: string;
};

const HELP = `Usage: pi-code-mode --provider <provider> --model <model> [--cwd <directory>] [--api-key-env <name>] <prompt>

Runs one prompt through an in-memory Pi Code Mode session. Every generated program requires a separate terminal approval. --api-key-env reads the named variable into an in-memory credential store.`;

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

type CliState = {
  provider?: string;
  model?: string;
  apiKey?: string;
  cwd: string;
  promptParts: string[];
};

type OptionHandler = (state: CliState, args: string[], index: number) => void;

const OPTION_HANDLERS: Record<string, OptionHandler> = {
  "--provider": (state, args, index) => {
    state.provider = takeValue(args, index, "--provider");
  },
  "--model": (state, args, index) => {
    state.model = takeValue(args, index, "--model");
  },
  "--cwd": (state, args, index) => {
    state.cwd = resolve(takeValue(args, index, "--cwd"));
  },
  "--api-key-env": (state, args, index) => {
    const name = takeValue(args, index, "--api-key-env");
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
      throw new Error(`environment variable is not set: ${name}`);
    }
    state.apiKey = value;
  },
};

function finalizeArguments(state: CliState): CliArguments {
  if (state.provider === undefined) throw new Error("--provider is required");
  if (state.model === undefined) throw new Error("--model is required");
  if (state.promptParts.length === 0) throw new Error("a prompt is required");
  return {
    provider: state.provider,
    model: state.model,
    cwd: state.cwd,
    prompt: state.promptParts.join(" "),
    ...(state.apiKey === undefined ? {} : { apiKey: state.apiKey }),
  };
}

function parseArguments(args: string[]): CliArguments {
  const state: CliState = { cwd: process.cwd(), promptParts: [] };
  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (argument === undefined) throw new Error("invalid empty argument");
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
    }
    const handler = OPTION_HANDLERS[argument];
    if (handler !== undefined) {
      handler(state, args, index);
      index += 2;
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
  await runCodeModePrompt({
    ...args,
    approve: createTerminalApproval(),
    onText: (text) => process.stdout.write(text),
  });
  process.stdout.write("\n");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`pi-code-mode: ${message}\n`);
  process.exitCode = 1;
});

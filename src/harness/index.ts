import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { CODE_MODE_SYSTEM_PROMPT } from "../core/prompt.js";
import type { ApprovalCallback, SandboxLimits } from "../core/types.js";
import { createCodeModeExtension } from "../extension/index.js";

export type CreateCodeModeHarnessOptions = {
  provider: string;
  model: string;
  cwd: string;
  approve: ApprovalCallback;
  apiKey?: string;
  limits?: Partial<SandboxLimits>;
};

export type CodeModeHarness = {
  session: AgentSession;
  warning?: string;
  dispose: () => void;
};

export type CreateCodeModeResourceLoaderOptions = Pick<
  CreateCodeModeHarnessOptions,
  "cwd" | "approve" | "limits"
> & {
  agentDir?: string;
};

export async function createCodeModeResourceLoader(
  options: CreateCodeModeResourceLoaderOptions,
): Promise<DefaultResourceLoader> {
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir ?? getAgentDir(),
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: CODE_MODE_SYSTEM_PROMPT,
    extensionFactories: [
      createCodeModeExtension({
        approve: options.approve,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      }),
    ],
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    promptsOverride: () => ({ prompts: [], diagnostics: [] }),
    themesOverride: () => ({ themes: [], diagnostics: [] }),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();
  return resourceLoader;
}

async function createHarnessModelRuntime(
  options: CreateCodeModeHarnessOptions,
): Promise<ModelRuntime> {
  if (options.apiKey === undefined) return ModelRuntime.create();
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
  await modelRuntime.setRuntimeApiKey(options.provider, options.apiKey);
  return modelRuntime;
}

export async function createCodeModeHarness(
  options: CreateCodeModeHarnessOptions,
): Promise<CodeModeHarness> {
  const modelRuntime = await createHarnessModelRuntime(options);
  const resolved = resolveCliModel({
    cliProvider: options.provider,
    cliModel: options.model,
    modelRuntime,
  });
  if (resolved.error !== undefined || resolved.model === undefined) {
    throw new Error(resolved.error ?? `model not found: ${options.provider}/${options.model}`);
  }

  const agentDir = getAgentDir();
  const resourceLoader = await createCodeModeResourceLoader({
    cwd: options.cwd,
    agentDir,
    approve: options.approve,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 },
  });
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    model: resolved.model,
    thinkingLevel: resolved.thinkingLevel ?? "off",
    modelRuntime,
    resourceLoader,
    tools: ["exec"],
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager,
  });

  return {
    session,
    ...(resolved.warning === undefined ? {} : { warning: resolved.warning }),
    dispose: () => {
      session.dispose();
    },
  };
}

function subscribeToSessionText(session: AgentSession, onText: (text: string) => void): () => void {
  return session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      onText(event.assistantMessageEvent.delta);
    }
  });
}

export type RunCodeModePromptOptions = CreateCodeModeHarnessOptions & {
  prompt: string;
  onText?: (text: string) => void;
};

export async function runCodeModePrompt(options: RunCodeModePromptOptions): Promise<string> {
  const harness = await createCodeModeHarness(options);
  let output = "";
  const unsubscribe = subscribeToSessionText(harness.session, (text) => {
    output += text;
    options.onText?.(text);
  });

  try {
    await harness.session.prompt(options.prompt);
    return output;
  } finally {
    unsubscribe();
    harness.dispose();
  }
}

export type CodeModePromptLoopOptions = {
  nextPrompt: () => Promise<string | undefined>;
  submitPrompt: (prompt: string) => Promise<void>;
  onTurnEnd?: () => void;
};

export async function runCodeModePromptLoop(options: CodeModePromptLoopOptions): Promise<void> {
  for (
    let prompt = await options.nextPrompt();
    prompt !== undefined;
    prompt = await options.nextPrompt()
  ) {
    if (prompt.trim().length === 0) continue;
    await options.submitPrompt(prompt);
    options.onTurnEnd?.();
  }
}

export type RunCodeModeReplOptions = CreateCodeModeHarnessOptions & {
  nextPrompt: () => Promise<string | undefined>;
  onText?: (text: string) => void;
  onTurnEnd?: () => void;
  onWarning?: (warning: string) => void;
};

export async function runCodeModeRepl(options: RunCodeModeReplOptions): Promise<void> {
  const harness = await createCodeModeHarness(options);
  const unsubscribe = subscribeToSessionText(harness.session, (text) => options.onText?.(text));
  if (harness.warning !== undefined) options.onWarning?.(harness.warning);

  try {
    await runCodeModePromptLoop({
      nextPrompt: options.nextPrompt,
      submitPrompt: (prompt) => harness.session.prompt(prompt),
      ...(options.onTurnEnd === undefined ? {} : { onTurnEnd: options.onTurnEnd }),
    });
  } finally {
    unsubscribe();
    harness.dispose();
  }
}

import { dirname, join } from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionRuntime,
  AgentSessionRuntimeDiagnostic,
  CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultResourceLoader,
  getAgentDir,
  InteractiveMode,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { CODE_MODE_SYSTEM_PROMPT } from "../core/prompt.js";
import type { ApprovalCallback, SandboxLimits } from "../core/types.js";
import { createCodeModeExtension } from "../extension/index.js";
import { getCodeModeConfigPath } from "./config.js";

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

async function createModelRuntime(provider: string, apiKey?: string): Promise<ModelRuntime> {
  if (apiKey === undefined) return ModelRuntime.create();
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
  await modelRuntime.setRuntimeApiKey(provider, apiKey);
  return modelRuntime;
}

export async function createCodeModeHarness(
  options: CreateCodeModeHarnessOptions,
): Promise<CodeModeHarness> {
  const modelRuntime = await createModelRuntime(options.provider, options.apiKey);
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

export type CreateCodeModeRuntimeOptions = {
  provider: string;
  model: string;
  cwd: string;
  agentDir?: string;
  approve?: ApprovalCallback;
  apiKey?: string;
  limits?: Partial<SandboxLimits>;
};

export async function createCodeModeRuntime(
  options: CreateCodeModeRuntimeOptions,
): Promise<AgentSessionRuntime> {
  const agentDir = options.agentDir ?? dirname(getCodeModeConfigPath());
  const modelRuntime = await createModelRuntime(options.provider, options.apiKey);
  const extension = createCodeModeExtension({
    ...(options.approve === undefined ? {} : { approve: options.approve }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir: runtimeAgentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const settingsManager = SettingsManager.create(cwd, runtimeAgentDir, {
      projectTrusted: false,
    });
    const services = await createAgentSessionServices({
      cwd,
      agentDir: runtimeAgentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
        systemPrompt: CODE_MODE_SYSTEM_PROMPT,
        extensionFactories: [extension],
      },
    });
    const resolved = resolveCliModel({
      cliProvider: options.provider,
      cliModel: options.model,
      modelRuntime,
    });
    if (resolved.error !== undefined || resolved.model === undefined) {
      throw new Error(resolved.error ?? `model not found: ${options.provider}/${options.model}`);
    }

    const diagnostics: AgentSessionRuntimeDiagnostic[] = [
      ...services.diagnostics,
      ...services.resourceLoader.getExtensions().errors.map(({ path, error }) => ({
        type: "error" as const,
        message: `Failed to load extension "${path}": ${error}`,
      })),
    ];
    if (resolved.warning !== undefined) {
      diagnostics.push({ type: "warning", message: resolved.warning });
    }

    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
        model: resolved.model,
        thinkingLevel: resolved.thinkingLevel ?? "off",
        tools: ["exec"],
      })),
      services,
      diagnostics,
    };
  };

  return createAgentSessionRuntime(createRuntime, {
    cwd: options.cwd,
    agentDir,
    sessionManager: SessionManager.create(options.cwd, join(agentDir, "sessions")),
  });
}

export type RunCodeModeInteractiveOptions = CreateCodeModeRuntimeOptions & {
  initialMessage?: string;
};

export async function runCodeModeInteractive(
  options: RunCodeModeInteractiveOptions,
): Promise<void> {
  const runtime = await createCodeModeRuntime(options);
  const interactiveMode = new InteractiveMode(runtime, {
    startupDiagnostics: [...runtime.diagnostics],
    ...(runtime.modelFallbackMessage === undefined
      ? {}
      : { modelFallbackMessage: runtime.modelFallbackMessage }),
    ...(options.initialMessage === undefined ? {} : { initialMessage: options.initialMessage }),
  });
  await interactiveMode.run();
}

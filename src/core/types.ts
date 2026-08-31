export const CODE_MODE_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

export type CodeModeToolName = (typeof CODE_MODE_TOOL_NAMES)[number];

export type SandboxLimits = {
  maxSourceBytes: number;
  timeoutMs: number;
  memoryBytes: number;
  stackBytes: number;
  maxToolCalls: number;
  maxReadBytes: number;
  maxScannedBytes: number;
  maxScannedEntries: number;
  maxResults: number;
  maxOutputBytes: number;
};

export type ExecutionStats = {
  toolCalls: number;
  scannedBytes: number;
  scannedEntries: number;
};

export type CodeModeExecution =
  | {
      status: "completed";
      output: string;
      truncated: boolean;
      stats: ExecutionStats;
    }
  | {
      status: "failed";
      error: string;
      stats?: ExecutionStats;
    };

export type ExecuteProgramOptions = {
  code: string;
  rootDir: string;
  limits?: Partial<SandboxLimits>;
  signal?: AbortSignal;
};

export type WorkerRequest = {
  code: string;
  rootDir: string;
  limits: SandboxLimits;
};

export type WorkerResponse =
  | {
      ok: true;
      output: string;
      truncated: boolean;
      stats: ExecutionStats;
    }
  | {
      ok: false;
      error: string;
      stats?: ExecutionStats;
    };

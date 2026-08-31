export type CodeModeToolName = "read" | "grep" | "find" | "ls";

export type CodeModeLimits = {
  maxSourceBytes: number;
  maxHeapBytes: number;
  maxOutputBytes: number;
  maxToolCalls: number;
  maxConcurrentToolCalls: number;
  maxToolInputBytes: number;
  maxToolResultBytes: number;
  maxTotalToolResultBytes: number;
  maxStoreBytes: number;
  maxTimerMs: number;
  maxTimers: number;
  cpuLimitMs: number;
  wallTimeMs: number;
  initialYieldTimeMs: number;
  maxReadBytes: number;
  maxScannedBytes: number;
  maxScannedEntries: number;
  maxResults: number;
};

export type ReadOnlyStats = {
  toolCalls: number;
  scannedBytes: number;
  scannedEntries: number;
};

export type CodeModeOutput =
  | { type: "text"; text: string }
  | { type: "notification"; message: string };

export type CodeModeStats = {
  toolCalls: number;
  outputBytes: number;
  wallTimeMs: number;
};

export type CodeModeCellStatus = "completed" | "failed" | "waiting" | "terminated";

export type CodeModeCellResult = {
  status: CodeModeCellStatus;
  cellId: string;
  output: CodeModeOutput[];
  truncated: boolean;
  stats: CodeModeStats;
  error?: string;
};

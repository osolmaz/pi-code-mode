export default {
  checkers: ["typescript"],
  concurrency: 4,
  coverageAnalysis: "perTest",
  mutate: ["src/core/limits.ts", "src/harness/config.ts"],
  reporters: ["clear-text", "progress"],
  testRunner: "vitest",
  thresholds: {
    break: 85,
    high: 90,
    low: 85,
  },
  tsconfigFile: "tsconfig.json",
};

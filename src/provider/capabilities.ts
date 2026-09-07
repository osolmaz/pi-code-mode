import type { Api, Model } from "@earendil-works/pi-ai";

export type CodeModeInputFormat = "json" | "grammar";

export function codeModeInputFormat(model: Model<Api> | undefined): CodeModeInputFormat {
  if (
    model === undefined ||
    ![
      "openai-completions",
      "openai-responses",
      "azure-openai-responses",
      "openai-codex-responses",
    ].includes(model.api)
  ) {
    return "json";
  }
  return model.compat !== undefined &&
    "supportsOpenAIGrammarTools" in model.compat &&
    model.compat.supportsOpenAIGrammarTools
    ? "grammar"
    : "json";
}

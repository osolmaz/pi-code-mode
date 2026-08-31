import type { Api, Model } from "@earendil-works/pi-ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsOpenAICodeMode(model: Model<Api> | undefined): boolean {
  if (model === undefined) return false;
  if (
    model.api !== "openai-responses" &&
    model.api !== "azure-openai-responses" &&
    model.api !== "openai-codex-responses"
  ) {
    return false;
  }
  return isRecord(model.compat) && model.compat["supportsOpenAIGrammarTools"] === true;
}

export function assertOpenAICodeMode(model: Model<Api> | undefined): void {
  if (model === undefined) throw new Error("Code Mode requires a selected model");
  if (!supportsOpenAICodeMode(model)) {
    throw new Error(
      `Code Mode requires an OpenAI Responses model with grammar custom-tool support; ${model.provider}/${model.id} does not advertise it`,
    );
  }
}

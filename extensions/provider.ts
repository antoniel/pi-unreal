import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Source = "runner" | "pi";
export type RunnerConfig = { label: string; env: Record<string, string> };

// The runner speaks OpenAI Responses, not pi-ai's provider protocols. Never
// forward a Pi token to a provider that the runner cannot actually speak to.
const responsesProviders = new Set(["openai", "openrouter", "fireworks"]);

export async function runnerConfig(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  source: Source,
  runnerProvider: string,
  runnerModel: string,
): Promise<RunnerConfig> {
  if (source === "runner") {
    return {
      label: `${runnerProvider}/${runnerModel}`,
      env: { UNREAL_HARNESS_LLM_PROVIDER: runnerProvider, UNREAL_HARNESS_LLM_MODEL: runnerModel },
    };
  }
  const model = ctx.model;
  if (!model) throw new Error("Select a Pi model with /model before using /unreal-model pi.");
  if (!responsesProviders.has(model.provider) || model.api !== "openai-responses") {
    throw new Error(`The runner does not support ${model.provider}/${model.id} (${model.api}) through Pi. Use /model to select an OpenAI Responses model or /unreal-model runner.`);
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`Pi credential unavailable for ${model.provider}; configure access in Pi.`);
  if (!auth.apiKey) throw new Error(`The runner requires an API key for ${model.provider}; this Pi authentication method is incompatible.`);
  if (auth.headers && Object.keys(auth.headers).length) {
    throw new Error(`The runner does not accept extra headers for ${model.provider}; ignoring them would be unsafe.`);
  }
  const baseUrl = auth.baseUrl || model.baseUrl;
  // Do not accidentally send a Pi credential to a third-party or insecure URL.
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { throw new Error(`Invalid URL for ${model.provider}.`); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
    throw new Error(`The ${model.provider} provider URL must use HTTPS (or localhost).`);
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Provider URL contains credentials or unsupported parameters.");
  return {
    label: `${model.provider}/${model.id} (Pi)`,
    env: {
      UNREAL_HARNESS_LLM_PROVIDER: model.provider,
      UNREAL_HARNESS_LLM_MODEL: model.id,
      UNREAL_HARNESS_LLM_API_KEY: auth.apiKey,
      UNREAL_HARNESS_LLM_BASE_URL: baseUrl,
    },
  };
}

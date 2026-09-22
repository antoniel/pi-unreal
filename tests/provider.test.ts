import { expect, test } from "bun:test";
import { runnerConfig } from "../extensions/provider.ts";

const model = { provider: "openai", id: "gpt-4.1", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
const ctx = (selected: any = model, auth: any = { ok: true, apiKey: "test-secret" }) => ({
  model: selected,
  modelRegistry: { getApiKeyAndHeaders: async () => auth },
});

test("runner selection does not need Pi auth and is configurable", async () => {
  expect(await runnerConfig(ctx(), "runner", "openrouter", "vendor/model")).toEqual({
    label: "openrouter/vendor/model",
    env: { UNREAL_HARNESS_LLM_PROVIDER: "openrouter", UNREAL_HARNESS_LLM_MODEL: "vendor/model" },
  });
});

test("Pi Responses model resolves auth on demand without logging or persisting it", async () => {
  const config = await runnerConfig(ctx(), "pi", "openai-codex", "gpt-6-sol");
  expect(config.label).toBe("openai/gpt-4.1 (Pi)");
  expect(config.env).toEqual({
    UNREAL_HARNESS_LLM_PROVIDER: "openai",
    UNREAL_HARNESS_LLM_MODEL: "gpt-4.1",
    UNREAL_HARNESS_LLM_API_KEY: "test-secret",
    UNREAL_HARNESS_LLM_BASE_URL: model.baseUrl,
  });
});

test("incompatible Pi connectors fail closed and never forward their tokens", async () => {
  for (const selected of [
    { ...model, provider: "anthropic", api: "anthropic-messages" },
    { ...model, provider: "openai-codex", api: "openai-codex-responses" },
    { ...model, provider: "openrouter", api: "openai-completions" },
  ]) {
    let called = false;
    const context = ctx(selected);
    context.modelRegistry.getApiKeyAndHeaders = async () => { called = true; return { ok: true, apiKey: "secret" }; };
    expect(runnerConfig(context, "pi", "openai-codex", "gpt-6-sol")).rejects.toThrow("does not support");
    expect(called).toBe(false);
  }
  expect(runnerConfig(ctx(model, { ok: false, error: "secret" }), "pi", "openai", "gpt-4.1")).rejects.toThrow("unavailable");
  expect(runnerConfig(ctx(model, { ok: true, apiKey: "secret", headers: { "x-special": "value" } }), "pi", "openai", "gpt-4.1")).rejects.toThrow("extra headers");
  expect(runnerConfig(ctx({ ...model, baseUrl: "http://evil.example/v1" }), "pi", "openai", "gpt-4.1")).rejects.toThrow("HTTPS");
});

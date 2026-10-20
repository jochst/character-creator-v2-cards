/**
 * OpenAI-compatible providers. Keys stay on the server (env vars); the browser only ever sees provider ids.
 */
export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  /** Env var holding the API key. Local servers may not need one. */
  keyEnv?: string;
  /** Env var that overrides baseUrl. */
  baseUrlEnv?: string;
  /** Request starts allowed per second, and how many may start back to back. */
  rateLimit: { perSecond: number; burst: number };
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "nano-gpt",
    name: "NanoGPT",
    baseUrl: "https://nano-gpt.com/api/v1",
    keyEnv: "NANOGPT_API_KEY",
    rateLimit: { perSecond: 25, burst: 25 },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    rateLimit: { perSecond: 10, burst: 10 },
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    rateLimit: { perSecond: 10, burst: 10 },
  },
  {
    id: "local",
    name: "Local (LM Studio, Ollama, mock)",
    baseUrl: "http://localhost:3999/v1",
    baseUrlEnv: "LOCAL_LLM_BASE_URL",
    rateLimit: { perSecond: 50, burst: 50 },
  },
];

export interface ResolvedProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  rateLimit: ProviderPreset["rateLimit"];
}

export function resolveProvider(id: string, env: NodeJS.ProcessEnv = process.env): ResolvedProvider | undefined {
  const preset = PROVIDER_PRESETS.find((p) => p.id === id);
  if (!preset) return undefined;
  const apiKey = preset.keyEnv ? env[preset.keyEnv]?.trim() || undefined : undefined;
  if (preset.keyEnv && !apiKey) return undefined;
  const baseUrl = ((preset.baseUrlEnv && env[preset.baseUrlEnv]?.trim()) || preset.baseUrl).replace(/\/+$/, "");
  return { id: preset.id, name: preset.name, baseUrl, apiKey, rateLimit: preset.rateLimit };
}

/** Providers usable right now: their key is set (or they need none). */
export function configuredProviders(env: NodeJS.ProcessEnv = process.env): { id: string; name: string }[] {
  return PROVIDER_PRESETS.filter((p) => resolveProvider(p.id, env)).map(({ id, name }) => ({ id, name }));
}

export function authHeaders(provider: ResolvedProvider): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
    // NanoGPT also accepts x-api-key.
    if (provider.id === "nano-gpt") headers["x-api-key"] = provider.apiKey;
  }
  return headers;
}

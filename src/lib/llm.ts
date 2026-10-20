import { authHeaders, type ResolvedProvider } from "./providers";
import { bucketFor } from "./rate-limiter";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamRequest {
  provider: ResolvedProvider;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
}

export type StreamPart = { type: "delta"; text: string } | { type: "usage"; usage: Usage };

const MAX_RETRIES_ON_429 = 3;
const MAX_RETRIES_ON_CONNECT = 2;
/** Network failures where no response arrived; seen under bursts of ~50 parallel starts. */
const TRANSIENT_CONNECT_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"]);

function isTransientConnectError(e: unknown): boolean {
  const code = (e as { cause?: { code?: string } } | undefined)?.cause?.code;
  return Boolean(code && TRANSIENT_CONNECT_CODES.has(code));
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Retry-After in ms (seconds or an HTTP date), else 1s/2s/4s. */
export function retryDelay(header: string | null, attempt: number, now = Date.now()): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return 1000 * 2 ** attempt;
}

/**
 * Starts one streaming chat completion, waiting for the provider's rate limiter first. A 429 pauses the
 * provider's whole bucket for Retry-After and tries again (a 429 was refused, so a retry can't double-charge).
 * A connection that fails before any response (timeout, reset) is retried up to twice.
 */
export async function openStream(req: StreamRequest): Promise<Response> {
  const bucket = bucketFor(req.provider.id, req.provider.rateLimit);
  let connectRetries = 0;
  for (let attempt = 0; ; attempt++) {
    await bucket.acquire(req.signal);
    const res = await fetch(`${req.provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...authHeaders(req.provider), Accept: "text/event-stream" },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      }),
      signal: req.signal,
    }).catch((e: unknown) => {
      if (req.signal?.aborted || !isTransientConnectError(e) || connectRetries >= MAX_RETRIES_ON_CONNECT) throw e;
      return undefined;
    });
    if (!res) {
      connectRetries++;
      attempt--;
      await new Promise((r) => setTimeout(r, 250 * connectRetries));
      continue;
    }
    if (res.status === 429 && attempt < MAX_RETRIES_ON_429) {
      await res.body?.cancel();
      bucket.pause(retryDelay(res.headers.get("retry-after"), attempt));
      continue;
    }
    if (!res.ok || !res.body) throw new ProviderError(await errorMessage(res), res.status || 502);
    return res;
  }
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const msg = typeof json.error === "string" ? json.error : json.error?.message || json.message;
    if (msg) return `${res.status}: ${msg}`;
  } catch {
    /* not JSON */
  }
  return `${res.status}: ${text.slice(0, 200) || res.statusText || "request failed"}`;
}

/** Parses an OpenAI-style SSE body into text deltas and a final usage part. */
export async function* readStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamPart> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const part = parseLine(line);
        if (part === "done") return;
        if (part) yield* part;
      }
    }
    const tail = parseLine(buffer.trim());
    if (tail && tail !== "done") yield* tail;
  } finally {
    reader.releaseLock();
  }
}

function parseLine(line: string): StreamPart[] | "done" | undefined {
  if (!line.startsWith("data:")) return undefined;
  const data = line.slice(5).trim();
  if (data === "[DONE]") return "done";
  let json: {
    choices?: { delta?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  };
  try {
    json = JSON.parse(data);
  } catch {
    return undefined;
  }
  const parts: StreamPart[] = [];
  const text = json.choices?.[0]?.delta?.content;
  if (text) parts.push({ type: "delta", text });
  if (json.usage) parts.push({ type: "usage", usage: { promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens } });
  return parts;
}

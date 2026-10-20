#!/usr/bin/env node
// A fake OpenAI-compatible provider for local testing without spending credits.
// Streams a short reply word by word. Point the "local" provider at it (the default: http://localhost:3999/v1).
//   node scripts/mock-provider.mjs [--port 3999] [--rate 5]
// --rate N answers 429 (Retry-After: 1) to any request beyond N starts in the current second.
import { createServer } from "node:http";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const port = arg("port", 3999);
const rate = arg("rate", Infinity);
let windowStart = 0;
let windowCount = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

createServer(async (req, res) => {
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-fast" }, { id: "mock-slow" }] }));
    return;
  }
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  const now = Date.now();
  if (now - windowStart >= 1000) {
    windowStart = now;
    windowCount = 0;
  }
  if (++windowCount > rate) {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
    res.end(JSON.stringify({ error: { message: "Rate limited (mock)" } }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  const system = body.messages?.find((m) => m.role === "system")?.content ?? "";
  const name = /You are ([^.\n]+)\./.exec(system)?.[1] ?? "Mock";
  const last = body.messages?.at(-1)?.content ?? "";
  const reply = `${name} here (${body.model}). You said: "${String(last).slice(0, 60)}". This reply is streamed word by word.`;
  const delay = body.model === "mock-slow" ? 120 : 30;

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  let aborted = false;
  res.on("close", () => (aborted = true));
  const words = reply.split(" ");
  for (let i = 0; i < words.length && !aborted; i++) {
    const content = (i === 0 ? "" : " ") + words[i];
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    await sleep(delay);
  }
  if (!aborted) {
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: words.length } })}\n\n`);
    res.write("data: [DONE]\n\n");
  }
  res.end();
}).listen(port, () => console.log(`mock provider on http://localhost:${port}/v1${rate !== Infinity ? ` (429 above ${rate}/s)` : ""}`));

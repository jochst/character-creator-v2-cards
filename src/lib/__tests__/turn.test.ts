import { afterEach, describe, expect, it, vi } from "vitest";
import { readStream, retryDelay } from "../llm";
import { buildMessages, type TurnEvent, type TurnRequest } from "../scene";
import { runTurn } from "../turn";

function sse(chunks: string[], status = 200, headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
  return new Response(body, { status, headers });
}
const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

describe("readStream", () => {
  it("joins deltas split across chunks and reads usage", async () => {
    const res = sse([delta("Hel").slice(0, 20), delta("Hel").slice(20) + delta("lo"), `data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n`]);
    const parts = [];
    for await (const p of readStream(res.body!)) parts.push(p);
    expect(parts).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "usage", usage: { promptTokens: 3, completionTokens: 2 } },
    ]);
  });
});

describe("retryDelay", () => {
  it("honours Retry-After seconds, else backs off", () => {
    expect(retryDelay("2", 0)).toBe(2000);
    expect(retryDelay(null, 2)).toBe(4000);
  });
});

describe("buildMessages", () => {
  it("shows a character its own lines as assistant and others' as named user lines", () => {
    const cast = [
      { id: "a", name: "Aria", persona: "Bard." },
      { id: "k", name: "Kael", persona: "Mercenary." },
    ];
    const msgs = buildMessages(cast[0], cast, [
      { id: "1", speaker: "user", content: "Hi" },
      { id: "2", speaker: "k", content: "Hm." },
      { id: "3", speaker: "a", content: "Hello!" },
    ]);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("You are Aria.");
    expect(msgs[0].content).toContain("Kael");
    expect(msgs.slice(1)).toEqual([
      { role: "user", content: "User: Hi" },
      { role: "user", content: "Kael: Hm." },
      { role: "assistant", content: "Hello!" },
    ]);
  });
});

describe("runTurn", () => {
  afterEach(() => vi.unstubAllGlobals());
  const provider = { id: "test", name: "Test", baseUrl: "http://x/v1", rateLimit: { perSecond: 1000, burst: 1000 } };
  const base: Omit<TurnRequest, "order"> = {
    turnId: "t1",
    characters: [
      { id: "a", name: "Aria", persona: "" },
      { id: "k", name: "Kael", persona: "", model: "other-model" },
    ],
    defaults: { providerId: "test", model: "m1" },
    log: [{ id: "u", speaker: "user", content: "Hi" }],
  };

  it("streams every character in parallel with its own model, tagged by character", async () => {
    const models: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      models.push(body.model);
      return sse([delta(`from ${body.model}`), "data: [DONE]\n\n"]);
    });
    const events: TurnEvent[] = [];
    await runTurn({ ...base, order: "parallel" }, (e) => events.push(e), new AbortController().signal, { resolve: () => provider });
    expect(models.sort()).toEqual(["m1", "other-model"]);
    const done = events.filter((e) => e.type === "done");
    expect(done.map((e) => [e.characterId, e.type === "done" && e.content]).sort()).toEqual([
      ["a", "from m1"],
      ["k", "from other-model"],
    ]);
    expect(events.at(-1)).toEqual({ type: "end" });
  });

  it("keeps going when one character fails", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return body.model === "m1" ? new Response(JSON.stringify({ error: { message: "bad model" } }), { status: 400 }) : sse([delta("ok"), "data: [DONE]\n\n"]);
    });
    const events: TurnEvent[] = [];
    await runTurn({ ...base, order: "parallel" }, (e) => events.push(e), new AbortController().signal, { resolve: () => provider });
    expect(events).toContainEqual({ type: "error", characterId: "a", error: "400: bad model", content: "" });
    expect(events.some((e) => e.type === "done" && e.characterId === "k" && e.content === "ok")).toBe(true);
  });

  it("in chained order, later characters see earlier replies", async () => {
    const seen: string[][] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
      seen.push(body.messages.slice(1).map((m) => m.content));
      return sse([delta(`reply ${seen.length}`), "data: [DONE]\n\n"]);
    });
    await runTurn({ ...base, order: "chained" }, () => {}, new AbortController().signal, { resolve: () => provider });
    expect(seen[0]).toEqual(["User: Hi"]);
    expect(seen[1]).toEqual(["User: Hi", "Aria: reply 1"]);
  });

  it("retries after a 429", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => (++calls === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "0" } }) : sse([delta("ok"), "data: [DONE]\n\n"])));
    const events: TurnEvent[] = [];
    await runTurn({ ...base, characters: [base.characters[0]], order: "parallel" }, (e) => events.push(e), new AbortController().signal, { resolve: () => ({ ...provider, id: "retry-test" }) });
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "done" && e.content === "ok")).toBe(true);
  });

  it("reports a missing provider without calling out", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const events: TurnEvent[] = [];
    await runTurn({ ...base, characters: [base.characters[0]], order: "parallel" }, (e) => events.push(e), new AbortController().signal, { resolve: () => undefined });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ type: "error", characterId: "a" });
  });
});

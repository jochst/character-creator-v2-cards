import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeCharacter } from "../memory";
import { buildMessages, pendingSummary, RECENT_WINDOW, SUMMARY_BATCH, visibleLog, type Character, type LogEntry } from "../scene";

const log = (n: number): LogEntry[] => Array.from({ length: n }, (_, i) => ({ id: String(i), speaker: i % 2 ? "k" : "user", content: `line ${i}` }));
const aria: Character = { id: "a", name: "Aria", persona: "Bard.", style: "Flowery.", examples: "Oh joy!\nWhat a tale!", memory: { notes: "Secretly a spy.", summary: "We met Kael at the inn." } };
const kael: Character = { id: "k", name: "Kael", persona: "Mercenary.", memory: { notes: "Owes Aria money." } };

describe("buildMessages", () => {
  it("includes only this character's voice and private memory", () => {
    const system = buildMessages(aria, [aria, kael], log(2))[0].content;
    expect(system).toContain("How you speak: Flowery.");
    expect(system).toContain("- Oh joy!\n- What a tale!");
    expect(system).toContain("Secretly a spy.");
    expect(system).toContain("We met Kael at the inn.");
    expect(system).not.toContain("Owes Aria money.");
    expect(system).not.toContain("Mercenary.");
  });
});

describe("memory window", () => {
  it("shows everything until the summary is due", () => {
    expect(visibleLog(kael, log(10))).toHaveLength(10);
    expect(pendingSummary(kael, log(RECENT_WINDOW + SUMMARY_BATCH - 1))).toBeUndefined();
    expect(pendingSummary(kael, log(RECENT_WINDOW + SUMMARY_BATCH))).toEqual({ from: 0, to: SUMMARY_BATCH });
  });

  it("hides entries the summary covers", () => {
    const c = { ...kael, memory: { summarizedThrough: 20 } };
    const visible = visibleLog(c, log(40));
    expect(visible[0].id).toBe("20");
    expect(visible).toHaveLength(20);
  });

  it("caps the window if summaries keep failing", () => {
    expect(visibleLog(kael, log(200))).toHaveLength(RECENT_WINDOW + SUMMARY_BATCH);
  });
});

describe("summarizeCharacter", () => {
  afterEach(() => vi.unstubAllGlobals());
  const provider = { id: "mem-test", name: "Test", baseUrl: "http://x/v1", rateLimit: { perSecond: 1000, burst: 1000 } };
  const defaults = { providerId: "mem-test", model: "m1" };

  it("asks the character's own model to fold aged-out lines into its first-person memory", async () => {
    let sent: { model: string; messages: { role: string; content: string }[] } | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "I remember the inn and the ruins." } }] })}\n\ndata: [DONE]\n\n`));
          c.close();
        },
      });
      return new Response(body);
    });
    const character = { ...aria, model: "aria-model" };
    const update = await summarizeCharacter(character, [character, kael], log(RECENT_WINDOW + SUMMARY_BATCH), defaults, { resolve: () => provider });
    expect(update).toEqual({ characterId: "a", summary: "I remember the inn and the ruins.", summarizedThrough: SUMMARY_BATCH });
    expect(sent?.model).toBe("aria-model");
    expect(sent?.messages[0].content).toContain("first person, as Aria");
    expect(sent?.messages[1].content).toContain("We met Kael at the inn.");
    expect(sent?.messages[1].content).toContain("Kael: line 1");
    expect(sent?.messages[1].content).not.toContain(`line ${SUMMARY_BATCH}`);
  });

  it("does nothing when no summary is due", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await summarizeCharacter(aria, [aria], log(5), defaults, { resolve: () => provider })).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

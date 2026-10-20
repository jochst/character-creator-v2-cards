"use client";

import { useEffect, useRef, useState } from "react";
import type { Character, LogEntry, SceneDefaults, TurnEvent, TurnOrder } from "@/lib/scene";

interface Provider {
  id: string;
  name: string;
}

interface Live {
  content: string;
  model?: string;
  status: "waiting" | "streaming" | "done" | "stopped" | "error";
  error?: string;
  firstTokenMs?: number;
}

interface SavedScene {
  characters: Character[];
  defaults: SceneDefaults;
  order: TurnOrder;
  log: LogEntry[];
}

const STORAGE_KEY = "scene.v1";

const newId = () => crypto.randomUUID();

const STARTER: SavedScene = {
  characters: [
    { id: "aria", name: "Aria", persona: "A cheerful bard who answers in rhymes when she can." },
    { id: "kael", name: "Kael", persona: "A blunt, dry-witted mercenary of few words." },
  ],
  defaults: { providerId: "local", model: "mock-fast" },
  order: "parallel",
  log: [],
};

function loadScene(): SavedScene {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...STARTER, ...(JSON.parse(raw) as Partial<SavedScene>) };
  } catch {
    /* storage blocked or corrupt */
  }
  return STARTER;
}

/** Splits an SSE body into parsed `data:` events. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<TurnEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let split: number;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) yield JSON.parse(line.slice(6)) as TurnEvent;
      }
    }
  }
}

export function SceneChat() {
  const [scene, setScene] = useState<SavedScene>(STARTER);
  const [loaded, setLoaded] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [input, setInput] = useState("");
  const [live, setLive] = useState<Record<string, Live>>({});
  const [turnId, setTurnId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Read storage after mount so server and client render the same first frame.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScene(loadScene());
    setLoaded(true);
    fetch("/api/providers")
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)
      .then((d) => setProviders(d.providers))
      .catch(() => setProviders([]));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(scene));
    } catch {
      /* storage blocked */
    }
  }, [scene, loaded]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [scene.log.length, live]);

  const update = (patch: Partial<SavedScene>) => setScene((s) => ({ ...s, ...patch }));
  const updateCharacter = (id: string, patch: Partial<Character>) =>
    setScene((s) => ({ ...s, characters: s.characters.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const nameOf = (speaker: string) => (speaker === "user" ? "You" : (scene.characters.find((c) => c.id === speaker)?.name ?? "Removed character"));

  const send = async () => {
    const text = input.trim();
    if (!text || turnId) return;
    const id = newId();
    const userEntry: LogEntry = { id: newId(), speaker: "user", content: text };
    const log = [...scene.log, userEntry];
    const order = scene.characters.map((c) => c.id);
    setInput("");
    setError(null);
    setTurnId(id);
    update({ log });
    setLive(Object.fromEntries(order.map((cid) => [cid, { content: "", status: "waiting" } satisfies Live])));
    const abort = new AbortController();
    abortRef.current = abort;
    // Replies are appended to the log in cast order once each finishes, so the transcript reads the same every time.
    const finished: Record<string, string> = {};
    const finish = (cid: string, content: string) => {
      if (content) finished[cid] = content;
    };
    try {
      const res = await fetch("/api/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnId: id, characters: scene.characters, defaults: scene.defaults, order: scene.order, log }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Turn failed (${res.status}).`);
      }
      for await (const e of sseEvents(res.body)) {
        if (e.type === "end") break;
        setLive((prev) => {
          const cur = prev[e.characterId] ?? { content: "", status: "waiting" };
          switch (e.type) {
            case "start":
              return { ...prev, [e.characterId]: { ...cur, model: e.model, status: "streaming" } };
            case "delta":
              return { ...prev, [e.characterId]: { ...cur, content: cur.content + e.text } };
            case "done":
              return { ...prev, [e.characterId]: { ...cur, content: e.content, status: e.stopped ? "stopped" : "done", firstTokenMs: e.firstTokenMs } };
            case "error":
              return { ...prev, [e.characterId]: { ...cur, content: e.content, status: "error", error: e.error } };
          }
        });
        if (e.type === "done" || e.type === "error") finish(e.characterId, e.content);
      }
    } catch (e) {
      if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Turn failed.");
    } finally {
      const replies = order.filter((cid) => finished[cid]).map((cid) => ({ id: newId(), speaker: cid, content: finished[cid] }));
      setScene((s) => ({ ...s, log: [...s.log, ...replies] }));
      setLive({});
      setTurnId(null);
      abortRef.current = null;
    }
  };

  const stop = (characterId?: string) => {
    if (!turnId) return;
    const q = new URLSearchParams({ turnId, ...(characterId ? { characterId } : {}) });
    void fetch(`/api/turn?${q}`, { method: "DELETE" });
  };

  const providerOptions = providers.length > 0 ? providers : [{ id: scene.defaults.providerId, name: `${scene.defaults.providerId} (not configured)` }];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 md:flex-row">
      <aside className="flex w-full flex-col gap-4 md:w-80 md:shrink-0">
        <section className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">Scene defaults</h2>
          <label className="flex flex-col gap-1 text-xs">
            Provider
            <select className="rounded border border-zinc-300 bg-transparent p-1.5 text-sm dark:border-zinc-700" value={scene.defaults.providerId} onChange={(e) => update({ defaults: { ...scene.defaults, providerId: e.target.value } })}>
              {providerOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Model
            <input className="rounded border border-zinc-300 bg-transparent p-1.5 text-sm dark:border-zinc-700" value={scene.defaults.model} onChange={(e) => update({ defaults: { ...scene.defaults, model: e.target.value } })} />
          </label>
          <div className="flex gap-1 text-xs" role="radiogroup" aria-label="Turn order">
            {(["parallel", "chained"] as const).map((o) => (
              <button key={o} type="button" role="radio" aria-checked={scene.order === o} onClick={() => update({ order: o })} className={`flex-1 rounded border px-2 py-1 ${scene.order === o ? "border-blue-500 bg-blue-500/10" : "border-zinc-300 dark:border-zinc-700"}`}>
                {o === "parallel" ? "All at once" : "One after another"}
              </button>
            ))}
          </div>
        </section>

        {scene.characters.map((c) => (
          <section key={c.id} className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <input aria-label="Name" className="flex-1 rounded border border-zinc-300 bg-transparent p-1.5 text-sm font-semibold dark:border-zinc-700" value={c.name} onChange={(e) => updateCharacter(c.id, { name: e.target.value })} />
              <button type="button" className="text-xs text-zinc-500 hover:text-red-600" onClick={() => update({ characters: scene.characters.filter((x) => x.id !== c.id) })} disabled={Boolean(turnId)}>
                Remove
              </button>
            </div>
            <textarea aria-label="Persona" rows={2} className="rounded border border-zinc-300 bg-transparent p-1.5 text-sm dark:border-zinc-700" value={c.persona} onChange={(e) => updateCharacter(c.id, { persona: e.target.value })} />
            <div className="flex gap-2">
              <select aria-label="Provider" className="w-1/2 rounded border border-zinc-300 bg-transparent p-1.5 text-xs dark:border-zinc-700" value={c.providerId ?? ""} onChange={(e) => updateCharacter(c.id, { providerId: e.target.value || undefined })}>
                <option value="">Scene provider</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input aria-label="Model" placeholder="Scene model" className="w-1/2 rounded border border-zinc-300 bg-transparent p-1.5 text-xs dark:border-zinc-700" value={c.model ?? ""} onChange={(e) => updateCharacter(c.id, { model: e.target.value || undefined })} />
            </div>
          </section>
        ))}
        <button type="button" className="rounded-lg border border-dashed border-zinc-300 p-2 text-sm dark:border-zinc-700" disabled={Boolean(turnId)} onClick={() => update({ characters: [...scene.characters, { id: newId(), name: "New character", persona: "" }] })}>
          Add character
        </button>
      </aside>

      <main className="flex min-h-[70vh] flex-1 flex-col rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center justify-between border-b border-zinc-200 p-3 dark:border-zinc-800">
          <h1 className="text-sm font-semibold">Group chat</h1>
          <button type="button" className="text-xs text-zinc-500 hover:text-red-600 disabled:opacity-40" disabled={Boolean(turnId) || scene.log.length === 0} onClick={() => update({ log: [] })}>
            Clear chat
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
          {scene.log.map((m) => (
            <div key={m.id} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.speaker === "user" ? "self-end bg-blue-600 text-white" : "self-start bg-zinc-100 dark:bg-zinc-900"}`}>
              {m.speaker !== "user" && <div className="mb-0.5 text-xs font-semibold">{nameOf(m.speaker)}</div>}
              <p className="whitespace-pre-wrap">{m.content}</p>
            </div>
          ))}
          {Object.entries(live).map(([cid, l]) => (
            <div key={cid} className="max-w-[85%] self-start rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">
              <div className="mb-0.5 flex items-center gap-2 text-xs">
                <span className="font-semibold">{nameOf(cid)}</span>
                {l.model && <span className="text-zinc-500">{l.model}</span>}
                <span className="text-zinc-500">{l.status === "waiting" ? "waiting…" : l.status === "streaming" ? "typing…" : l.status}</span>
                {(l.status === "waiting" || l.status === "streaming") && (
                  <button type="button" className="ml-auto text-zinc-500 hover:text-red-600" onClick={() => stop(cid)}>
                    Stop
                  </button>
                )}
              </div>
              <p className="whitespace-pre-wrap">{l.content}</p>
              {l.error && <p className="mt-1 text-xs text-red-600">{l.error}</p>}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        {error && <p className="px-3 text-sm text-red-600">{error}</p>}
        <form
          className="flex gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input className="flex-1 rounded border border-zinc-300 bg-transparent p-2 text-sm dark:border-zinc-700" placeholder="Say something to the group" value={input} onChange={(e) => setInput(e.target.value)} />
          {turnId ? (
            <button type="button" className="rounded bg-red-600 px-4 text-sm text-white" onClick={() => stop()}>
              Stop all
            </button>
          ) : (
            <button type="submit" className="rounded bg-blue-600 px-4 text-sm text-white disabled:opacity-40" disabled={!input.trim() || scene.characters.length === 0}>
              Send
            </button>
          )}
        </form>
      </main>
    </div>
  );
}

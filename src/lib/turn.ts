import { openStream, readStream } from "./llm";
import { resolveProvider, type ResolvedProvider } from "./providers";
import { buildMessages, resolveModel, type Character, type LogEntry, type TurnEvent, type TurnRequest } from "./scene";

/** Per-character abort controllers of turns in flight, so one character can be stopped mid-turn. */
const active = new Map<string, Map<string, AbortController>>();

export function stopCharacter(turnId: string, characterId?: string): boolean {
  const turn = active.get(turnId);
  if (!turn) return false;
  if (characterId) {
    const c = turn.get(characterId);
    c?.abort();
    return Boolean(c);
  }
  for (const c of turn.values()) c.abort();
  return true;
}

interface Deps {
  resolve?: (id: string) => ResolvedProvider | undefined;
  now?: () => number;
}

/**
 * Runs one turn: every character gets its own stream. "parallel" starts them all at once; "chained" runs them
 * in order, each seeing the replies before it. One character failing never stops the others.
 */
export async function runTurn(req: TurnRequest, send: (e: TurnEvent) => void, signal: AbortSignal, deps: Deps = {}): Promise<void> {
  const resolve = deps.resolve ?? ((id: string) => resolveProvider(id));
  const now = deps.now ?? Date.now;
  const controllers = new Map<string, AbortController>();
  for (const c of req.characters) {
    const ctrl = new AbortController();
    controllers.set(c.id, ctrl);
  }
  const abortAll = () => controllers.forEach((c) => c.abort());
  signal.addEventListener("abort", abortAll, { once: true });
  active.set(req.turnId, controllers);

  const runOne = async (character: Character, log: LogEntry[]): Promise<string | undefined> => {
    const ctrl = controllers.get(character.id)!;
    const { providerId, model } = resolveModel(character, req.defaults);
    const provider = resolve(providerId);
    if (!provider) {
      send({ type: "error", characterId: character.id, error: `Provider "${providerId}" isn't configured. Set its API key in .env.local.`, content: "" });
      return undefined;
    }
    if (!model) {
      send({ type: "error", characterId: character.id, error: "No model set for this character or the scene.", content: "" });
      return undefined;
    }
    send({ type: "start", characterId: character.id, providerId, model });
    const started = now();
    let content = "";
    let firstTokenMs: number | undefined;
    let usage: { promptTokens?: number; completionTokens?: number } = {};
    try {
      const res = await openStream({
        provider,
        model,
        messages: buildMessages(character, req.characters, log),
        temperature: character.temperature,
        signal: ctrl.signal,
      });
      for await (const part of readStream(res.body!)) {
        if (part.type === "delta") {
          firstTokenMs ??= now() - started;
          content += part.text;
          send({ type: "delta", characterId: character.id, text: part.text });
        } else usage = part.usage;
      }
      send({ type: "done", characterId: character.id, content, firstTokenMs, totalMs: now() - started, ...usage });
      return content;
    } catch (e) {
      if (ctrl.signal.aborted) {
        // Stopping keeps whatever text arrived.
        send({ type: "done", characterId: character.id, content, firstTokenMs, totalMs: now() - started, stopped: true });
        return content || undefined;
      }
      send({ type: "error", characterId: character.id, error: describeError(e), content });
      return content || undefined;
    }
  };

  try {
    if (req.order === "parallel") {
      await Promise.all(req.characters.map((c) => runOne(c, req.log)));
    } else {
      const log = [...req.log];
      for (const c of req.characters) {
        if (signal.aborted) break;
        const reply = await runOne(c, log);
        if (reply) log.push({ id: `${req.turnId}-${c.id}`, speaker: c.id, content: reply });
      }
    }
  } finally {
    signal.removeEventListener("abort", abortAll);
    active.delete(req.turnId);
    send({ type: "end" });
  }
}

/** fetch() reports network failures as a bare "fetch failed"; the cause says what actually went wrong. */
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return "Request failed.";
  const cause = e.cause as { code?: string; message?: string } | undefined;
  const detail = cause?.code || cause?.message;
  return detail && !e.message.includes(detail) ? `${e.message} (${detail})` : e.message;
}

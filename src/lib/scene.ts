import type { ChatMessage } from "./llm";

/** Shared by the browser and the turn route. */
export interface Character {
  id: string;
  name: string;
  persona: string;
  /** Blank fields fall back to the scene defaults. */
  providerId?: string;
  model?: string;
  temperature?: number;
  /** How this character talks: vocabulary, rhythm, quirks. Kept separate from persona so the voice stays distinct. */
  style?: string;
  /** A few lines in this character's voice, one per line. Shown to its model as examples of how it speaks. */
  examples?: string;
  memory?: CharacterMemory;
}

/** Private to one character: only that character's model ever sees it. */
export interface CharacterMemory {
  /** Written by the user: secrets, goals, relationships. */
  notes?: string;
  /** Written by the character's own model: what it remembers of the older chat, from its point of view. */
  summary?: string;
  /** How many log entries (from the start) the summary already covers. */
  summarizedThrough?: number;
}

/** Recent log entries every character sees word for word; anything older lives only in its summary. */
export const RECENT_WINDOW = 24;
/** Summarize once this many entries have piled up beyond the window, so memory updates in batches. */
export const SUMMARY_BATCH = 8;

export interface SceneDefaults {
  providerId: string;
  model: string;
}

export type TurnOrder = "parallel" | "chained";

export interface LogEntry {
  id: string;
  /** "user" or a character id. */
  speaker: string;
  content: string;
}

export interface TurnRequest {
  turnId: string;
  characters: Character[];
  defaults: SceneDefaults;
  order: TurnOrder;
  /** The conversation so far, including the user's new message as the last entry. */
  log: LogEntry[];
}

/** Events the turn route sends, one per SSE `data:` line. */
export type TurnEvent =
  | { type: "start"; characterId: string; providerId: string; model: string }
  | { type: "delta"; characterId: string; text: string }
  | { type: "done"; characterId: string; content: string; firstTokenMs?: number; totalMs: number; promptTokens?: number; completionTokens?: number; stopped?: boolean }
  | { type: "error"; characterId: string; error: string; content: string }
  | { type: "end" };

export function resolveModel(character: Character, defaults: SceneDefaults): { providerId: string; model: string } {
  return {
    providerId: character.providerId?.trim() || defaults.providerId,
    model: character.model?.trim() || defaults.model,
  };
}

/**
 * The log entries a character still sees verbatim: everything its summary doesn't cover yet. Between summaries
 * that can run up to RECENT_WINDOW + SUMMARY_BATCH entries; past that (summaries failing) the oldest are dropped.
 */
export function visibleLog(character: Character, log: LogEntry[]): LogEntry[] {
  const covered = Math.min(character.memory?.summarizedThrough ?? 0, log.length);
  return log.slice(Math.max(covered, log.length - RECENT_WINDOW - SUMMARY_BATCH));
}

/**
 * The prompt one character sees: its own persona, voice, examples and private memory, then the recent log with
 * its own lines as `assistant` and everyone else's as `user` lines prefixed with the speaker's name.
 * Nothing about other characters' personas or memories is included, so each model only knows its own character.
 */
export function buildMessages(character: Character, cast: Character[], log: LogEntry[]): ChatMessage[] {
  const others = cast.filter((c) => c.id !== character.id).map((c) => c.name);
  const nameOf = (speaker: string) => (speaker === "user" ? "User" : cast.find((c) => c.id === speaker)?.name ?? "Someone");
  const examples = character.examples?.split("\n").map((l) => l.trim()).filter(Boolean) ?? [];
  const memory = character.memory;
  const system = [
    `You are ${character.name}.`,
    character.persona.trim(),
    character.style?.trim() && `How you speak: ${character.style.trim()}`,
    examples.length > 0 && `Lines in your voice:\n${examples.map((l) => `- ${l}`).join("\n")}`,
    memory?.notes?.trim() && `Private to you (no one else knows this; reveal it only if and when ${character.name} would):\n${memory.notes.trim()}`,
    memory?.summary?.trim() && `What you remember from earlier in this chat:\n${memory.summary.trim()}`,
    others.length > 0 ? `You are in a group chat with the User and ${others.join(", ")}. Each of them is a different person with their own way of talking.` : "You are chatting with the User.",
    `Reply only as ${character.name}, in your own voice. Don't copy the others' wording, tone or sentence patterns, and don't agree just to agree. Do not write lines for anyone else and do not prefix your reply with your name.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const messages: ChatMessage[] = [{ role: "system", content: system }];
  for (const entry of visibleLog(character, log)) {
    if (entry.speaker === character.id) messages.push({ role: "assistant", content: entry.content });
    else messages.push({ role: "user", content: `${nameOf(entry.speaker)}: ${entry.content}` });
  }
  return messages;
}

/** The slice of log a character's summary should absorb next, or undefined when it's not due yet. */
export function pendingSummary(character: Character, log: LogEntry[]): { from: number; to: number } | undefined {
  const from = Math.min(character.memory?.summarizedThrough ?? 0, log.length);
  const to = log.length - RECENT_WINDOW;
  return to - from >= SUMMARY_BATCH ? { from, to } : undefined;
}

const MAX_CHARACTERS = 25;
const MAX_LOG = 500;

export function parseTurnRequest(body: unknown): TurnRequest | string {
  if (!body || typeof body !== "object") return "Expected a JSON body.";
  const b = body as Partial<TurnRequest>;
  if (typeof b.turnId !== "string" || !b.turnId) return "turnId is required.";
  if (!Array.isArray(b.characters) || b.characters.length === 0) return "Add at least one character.";
  if (b.characters.length > MAX_CHARACTERS) return `At most ${MAX_CHARACTERS} characters per scene.`;
  for (const c of b.characters) {
    if (!c || typeof c.id !== "string" || typeof c.name !== "string" || typeof c.persona !== "string") return "Each character needs id, name and persona.";
  }
  if (!b.defaults || typeof b.defaults.providerId !== "string" || typeof b.defaults.model !== "string") return "defaults.providerId and defaults.model are required.";
  if (b.order !== "parallel" && b.order !== "chained") return 'order must be "parallel" or "chained".';
  if (!Array.isArray(b.log) || b.log.length === 0) return "log must include the user's message.";
  if (b.log.length > MAX_LOG) return `log is limited to ${MAX_LOG} entries.`;
  for (const e of b.log) {
    if (!e || typeof e.speaker !== "string" || typeof e.content !== "string") return "Each log entry needs speaker and content.";
  }
  return b as TurnRequest;
}

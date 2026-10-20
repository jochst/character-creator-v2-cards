import { openStream, readStream } from "./llm";
import { resolveProvider, type ResolvedProvider } from "./providers";
import { pendingSummary, resolveModel, type Character, type LogEntry, type SceneDefaults } from "./scene";

export type MemoryUpdate = { characterId: string; summary: string; summarizedThrough: number } | { characterId: string; error: string };

/** Generous because reasoning models spend part of the budget thinking before any visible text (600 ran out live). */
const MAX_SUMMARY_TOKENS = 2500;

/**
 * Folds the log entries that have aged out of a character's recent window into its private summary, written by
 * that character's own model in first person, so each character remembers the chat its own way.
 */
export async function summarizeCharacter(
  character: Character,
  cast: Character[],
  log: LogEntry[],
  defaults: SceneDefaults,
  opts: { resolve?: (id: string) => ResolvedProvider | undefined; signal?: AbortSignal } = {},
): Promise<MemoryUpdate | undefined> {
  const range = pendingSummary(character, log);
  if (!range) return undefined;
  const { providerId, model } = resolveModel(character, defaults);
  const provider = (opts.resolve ?? ((id: string) => resolveProvider(id)))(providerId);
  if (!provider) return { characterId: character.id, error: `Provider "${providerId}" isn't configured.` };
  const nameOf = (speaker: string) => (speaker === character.id ? `${character.name} (you)` : speaker === "user" ? "User" : (cast.find((c) => c.id === speaker)?.name ?? "Someone"));
  const transcript = log
    .slice(range.from, range.to)
    .map((e) => `${nameOf(e.speaker)}: ${e.content}`)
    .join("\n");
  const previous = character.memory?.summary?.trim();
  try {
    const res = await openStream({
      provider,
      model,
      maxTokens: MAX_SUMMARY_TOKENS,
      signal: opts.signal,
      messages: [
        {
          role: "system",
          content: [
            `You are ${character.name}. ${character.persona.trim()}`,
            `You are updating your private memory of a group chat. Write it in first person, as ${character.name}, in your own words: what happened, what others said or did that matters to you, how you feel about each person, promises, plans and anything you want to remember.`,
            "Keep the important details from your previous memory and add the new ones. Under 250 words. Write only the memory, no preamble.",
          ].join("\n\n"),
        },
        { role: "user", content: `${previous ? `Your memory so far:\n${previous}\n\n` : ""}What was said since:\n${transcript}` },
      ],
    });
    let summary = "";
    for await (const part of readStream(res.body!)) if (part.type === "delta") summary += part.text;
    summary = summary.trim();
    if (!summary) return { characterId: character.id, error: "The model returned an empty memory." };
    return { characterId: character.id, summary, summarizedThrough: range.to };
  } catch (e) {
    return { characterId: character.id, error: e instanceof Error ? e.message : "Memory update failed." };
  }
}

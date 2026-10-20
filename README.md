# character-creator-v2-cards

A group chat where every AI character answers on its own LLM stream, each with its own provider and model.

## Run it

```bash
npm install
cp .env.example .env.local   # add the keys for the providers you use
npm run mock                 # optional: fake provider on :3999, no credits spent
npm run dev
```

With no keys set, the "Local" provider points at the mock (`http://localhost:3999/v1`), so the app works out of the box.

## How it works

- `POST /api/turn` starts one `/chat/completions` stream per character and merges them into one SSE response; every event carries a `characterId`. One character failing never stops the others.
- "All at once" runs every character in parallel; "One after another" runs them in order, each seeing the replies before it.
- Each provider has a token bucket (`src/lib/rate-limiter.ts`) that gates request starts: NanoGPT gets 25/s. A 429 pauses that provider's bucket for `Retry-After`, then retries (up to 3 times).
- Characters pick a provider and model; blank fields use the scene defaults. Keys live only on the server in env vars.
- Each character's prompt holds only its own persona, speech style, example lines and private memory, never the others', so separate models keep separate voices.
- Private memory: notes you write, plus a first-person summary its own model writes. Every character sees the last 24 messages word for word. Once 8 more pile up, `POST /api/memory` folds the older ones into each character's summary.
- `DELETE /api/turn?turnId=…&characterId=…` stops one character (or the whole turn without `characterId`); text that already arrived is kept.

Behind an HTTPS proxy, start Node with `NODE_USE_ENV_PROXY=1` so the server's `fetch` uses it.

The limiter is in-memory, so it's per server process. A multi-instance deploy (e.g. Vercel) would need a shared store like Redis.

## Scripts

- `npm run check`: lint, typecheck, tests, build
- `npm test`: unit tests (limiter, stream parsing, turn orchestration)
- `node scripts/mock-provider.mjs --rate 3`: mock that answers 429 above 3 requests/s, to watch the limiter work

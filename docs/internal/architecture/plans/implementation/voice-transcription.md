# Implementation Plan: Telegram Voice Message Transcription

**Status**: Ready to implement
**Owner**: Ghostwriter
**Last updated**: 2026-07-07
**Related spec**: `docs/internal/product/agent/features/transcription/README.md`

This plan covers the concrete code, dependency, and configuration changes
required to ship the feature described in the spec. It assumes the spec
has been agreed on and stays inside the decisions made there.

## Scope

In scope:

- New npm dependency: `@ai-sdk/groq`.
- New environment variable: `GROQ_API_KEY`.
- Two files modified: `apps/ghostwriter/agent/channels/telegram.ts`,
  `apps/ghostwriter/.env` (local) and the Vercel project env (production).
- One file extended: `apps/ghostwriter/agent/instructions.md` (one
  paragraph added).

Out of scope:

- TTS replies (`sendVoice` from the agent back to the user).
- Cost attribution in instrumentation.
- Language hints to `transcribe()`.
- Streaming transcription.
- Quote-and-reply voice.

## Dependency and environment setup

### Install the Groq provider package

The project pins `ai@^7.0.0` via direct dependency plus an `overrides`
block. Add `@ai-sdk/groq` as a direct dependency at a version compatible
with `ai@7.x`. Check `node_modules/@ai-sdk/groq/package.json` for the
declared peer range before pinning; align with whatever the current `ai`
major supports.

```
npm install @ai-sdk/groq
```

Verify after install:

- `apps/ghostwriter/package.json` lists `@ai-sdk/groq` under
  `dependencies`.
- `node_modules/@ai-sdk/groq` exists.
- `node_modules/@ai-sdk/groq/package.json` declares
  `@ai-sdk/provider` as a peer at a version already satisfied by the
  transitive tree.

### Add the API key

Two places, kept in sync manually:

1. `apps/ghostwriter/.env` — append:

   ```
   GROQ_API_KEY=gsk_...
   ```

   Generate the key in the Groq Cloud console under API Keys. The local
   `.env` file is gitignored at the repo root (`**/.env`) so this addition
   stays local.

2. Vercel project — add `GROQ_API_KEY` to the production environment via
   the Vercel dashboard (Settings → Environment Variables). Apply to all
   environments (Production, Preview, Development) so preview deployments
   can exercise the feature.

Do not echo the key in shell history. When sourcing `.env` for local
testing, prefer `set -a; source apps/ghostwriter/.env; set +a` over inline
export.

## File changes

### `apps/ghostwriter/agent/channels/telegram.ts`

This is the only code-bearing file. The change has three parts: tighten
env validation to include `GROQ_API_KEY`, expand `uploadPolicy` to allow
the audio MIME types, and add an `onMessage` override that intercepts
voice and audio updates.

#### 1. Env validation block

Add `GROQ_API_KEY` to the existing fail-fast block. Reuse the same
shape as the existing checks so the error messages stay consistent.

Add a `getEnv` helper or inline check that throws at module load time
with a message of the form:

> `GROQ_API_KEY is not set. Add it to .env. Get a key from https://console.groq.com/keys`

This matches the tone of the existing `TELEGRAM_BOT_TOKEN` /
`TELEGRAM_WEBHOOK_SECRET_TOKEN` checks above it.

#### 2. `uploadPolicy.allowedMediaTypes`

Add three entries to the existing `["image/*", "application/pdf"]` array:

| Entry | Why |
|---|---|
| `audio/ogg` | Telegram voice notes are typically Ogg Opus. Verified via `Voice.mime_type` field documented in `python-telegram-bot@v22.7/src/telegram/_files/voice.py`. |
| `audio/mpeg` | Generic MP3 audio sent as `message.audio`. |
| `audio/mp4` | M4A audio sent as `message.audio`. |

The `maxBytes: 10 * 1024 * 1024` cap stays. Telegram `getFile` itself caps
downloads at 20 MB; our 10 MB cap is conservative on purpose and covers
roughly an hour of voice at typical Opus bitrates.

#### 3. `onMessage` override

The eve `telegramChannel` accepts an `onMessage(update, ctx)` hook. We
register one that:

1. Detects `update.message.voice ?? update.message.audio`.
2. If neither is present, returns `ctx.default(update)` so the existing
   dispatch path runs unchanged.
3. If one is present, downloads the file via `getFile`, transcribes via
   Groq's `whisper-large-v3-turbo`, formats the transcript with the
   `[voice Ns, lang=xx]` header, and calls `ctx.send(...)` with the
   resulting text plus the original `auth` and `continuationToken`.

The exact shape of the override is in the spec. The implementation
should:

- Use the AI SDK's `transcribe()` from `ai`, not a direct HTTP call to
  Groq. The function takes care of multipart upload, base64 encoding,
  and response parsing.
- Pass `Buffer` from `arrayBuffer()` to `transcribe({ audio })`. The
  `Buffer` form is documented in the AI SDK transcription reference.
- Set a hard timeout (suggested: `AbortSignal.timeout(15_000)`) on the
  `transcribe()` call so a stuck Groq request cannot pin the function
  invocation.
- Log one line per successful transcription at `info` level with the
  shape agreed in the spec (user_id, duration, language, transcript
  length). Do not log the transcript content itself.
- On `transcribe()` throwing, log the error and surface a short
  user-facing message via `ctx.send` ("I couldn't transcribe that
  voice note, please retry or send as text") rather than letting the
  error bubble.

### `apps/ghostwriter/agent/instructions.md`

Add one short paragraph under the "How you work" section, between
"Research first." and "Draft with structure.":

> **Voice messages.** Telegram voice notes are transcribed server-side
> via Groq Whisper before reaching you. The user message you see is
> formatted as `[voice Ns, lang=xx]` on one line, followed by the
> transcript. Treat the transcript as ordinary user input. You do not
> need to acknowledge the voice provenance unless the user asks.

The rest of `instructions.md` stays untouched. No changes to
`agent/agent.ts`, no changes to `agent/connections/*`, no changes to the
tool belt.

## Local verification before deploy

Run these in order. Each must pass before moving to the next.

1. **Type check**: `cd apps/ghostwriter && npm run typecheck`.
   Expect zero errors. The new `transcribe()` import and `onMessage`
   handler must typecheck against the installed `ai@^7` and `eve@^0.20`.

2. **Build**: `cd apps/ghostwriter && npm run build`. Expect a clean
   build with no missing-module errors.

3. **Dev server**: `cd apps/ghostwriter && npm run dev`. Expect the
   channel to mount without throwing on the new env check.

4. **Webhook health**: `curl -i https://ghostwriter-agent.nesalia.com/eve/v1/telegram`.
   Expect a 401 or 405 (Telegram never sends GET). This proves the route
   is still mounted after the channel changes.

5. **Local DM voice test**: send a 5-second French voice note from a
   real phone to the bot. Expect a research-grounded text reply within
   ~3 seconds (1–2 s transcription + agent latency). Inspect the Vercel
   function log for the one-line info log.

6. **Failure path**: temporarily set `GROQ_API_KEY` to an invalid value
   in the local `.env`, restart `npm run dev`, send a voice note. Expect
   the user-facing "I couldn't transcribe that voice note" message and
   an error-level log line.

7. **Group dispatch sanity**: in a Telegram group with the bot added,
   send a voice note without mentioning the bot. Expect no reaction
   (the override's early return + eve's group dispatch rules). Then
   send a voice note with `@bot_username` mentioned; expect a reply.

## Deploy

1. Merge the branch to `main`. The repo's GitHub Action (or whatever CI
   runs on push to `main`) will pick up the change.

2. Vercel will redeploy automatically. Confirm the deployment's
   environment includes `GROQ_API_KEY` (Vercel dashboard →
   Deployments → latest → Environment). If the env var is missing at
   runtime, the channel's startup validation will throw.

3. Re-run `curl -i https://ghostwriter-agent.nesalia.com/eve/v1/telegram`
   against the production URL to confirm the route still responds.

4. From a phone, send a production voice note. Confirm reply latency
   and transcript quality match the local test.

## Rollback

The change is small enough to revert with `git revert <merge-sha>`
followed by a push. The webhook does not need to be re-registered;
`setWebhook` was called once at bot setup and points at the channel's
`POST /eve/v1/telegram` route which exists regardless of the override.
After revert:

- Voice updates fall back to the default channel dispatch. With the new
  audio MIME types still in `uploadPolicy`, the file will be fetched
  and passed as a `FilePart` to the agent. The agent may then ignore
  the audio silently (M3 may not consume audio natively) or surface
  an error to the user. Either is acceptable as a degraded state.
- Text, photo, PDF, and group-dispatch behavior is unchanged.
- The `GROQ_API_KEY` env var becomes unused but harmless. Remove it
  from Vercel in the same revert PR if you want to keep the env
  clean.

A targeted rollback that keeps the dependency installed but disables
only the `onMessage` override is also acceptable: comment out the
override export, redeploy. This is the smaller-blast-radius option if
the rollback is due to a transcription-specific bug rather than a
fundamental design issue.

## Open questions before merge

These are the items the spec left ambiguous and that the implementation
will pin down. Worth a quick decision before code lands:

1. **What does the error message look like exactly?** Suggested in the
   spec as "I couldn't transcribe that voice note, please retry or send
   as text". Confirm or rewrite.

2. **Where does the `getFile` download happen?** We call Telegram's
   `getFile` HTTP endpoint directly using `process.env.TELEGRAM_BOT_TOKEN`
   in the channel file. Confirm this is acceptable, or whether it
   should live in a separate helper module.

3. **Does the agent's reply pass through `sendVoice` if the transcript
   starts with a magic trigger word (e.g. "voice reply:")?** The spec
   says no for this iteration. Confirm.

4. **Where do the one-line info logs go — Vercel stdout, or a structured
   logger?** The spec assumes stdout. Confirm or pick a logger.

## Estimated effort

Roughly:

- Dependency install and env wiring: 5 minutes
- `channels/telegram.ts` rewrite: 30–45 minutes (including env
  validation, `onMessage` override, error path)
- `instructions.md` paragraph: 5 minutes
- Local verification (steps 1–7 above): 30 minutes
- Deploy and production smoke test: 15 minutes

Total: under two hours of focused work for someone familiar with the
existing channel file.
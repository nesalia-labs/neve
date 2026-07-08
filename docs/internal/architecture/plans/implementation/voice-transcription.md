# Implementation Plan: Telegram Voice Message Transcription

**Status**: Implemented (uncommitted, in working tree)
**Owner**: Ghostwriter
**Last updated**: 2026-07-08
**Related spec**: `docs/internal/product/agent/features/transcription/README.md`

This plan covers the concrete code, dependency, and configuration changes
required to ship the feature described in the spec. It assumes the spec
has been agreed on and stays inside the decisions made there.

## What was actually implemented

The original plan proposed using `telegramChannel`'s `onMessage` hook to
intercept voice updates. After reading `eve@0.20.0`'s
`apps/ghostwriter/node_modules/eve/dist/src/public/channels/telegram/telegramChannel.d.ts`,
that approach was rejected: `onMessage` only returns `null | { auth, context }`
and cannot replace the message body with our transcript.

The actual implementation is a **wrapper channel** that uses `defineChannel`
to mount `POST /eve/v1/telegram` itself, intercepts the raw webhook,
transcribes voice/audio updates, and forwards a modified `Request` to
the inner `telegramChannel`'s route handler. The inner handler does the
real dispatch (group gating, mentions, HITL, callback queries, forum
topics, reply handling) — we just rewrite the message body before
handing off.

## Scope

In scope:

- New npm dependency: `@ai-sdk/groq@^4`.
- New environment variable: `GROQ_API_KEY`.
- One file rewritten: `apps/ghostwriter/agent/channels/telegram.ts`.
- One file extended: `apps/ghostwriter/agent/instructions.md` (one
  paragraph added).
- `.env` (local) and Vercel project env (production) — add `GROQ_API_KEY`.

Out of scope:

- TTS replies (`sendVoice` from the agent back to the user).
- Cost attribution in instrumentation.
- Language hints to `transcribe()`.
- Streaming transcription.
- Quote-and-reply voice.

## Dependency and environment setup

### Install the Groq provider package

Verified compatible: `@ai-sdk/groq@4.x` aligns with `ai@7.x`
(`@ai-sdk/groq@4.0.5` ships `TranscriptionModelV4`, the type
`transcribe()` from `ai@7` expects).

```
cd apps/ghostwriter
npm install @ai-sdk/groq@^4
```

Verify after install:

- `apps/ghostwriter/package.json` lists `@ai-sdk/groq` under
  `dependencies` with a `^4` range.
- `node_modules/@ai-sdk/groq/dist/index.d.ts` exposes a
  `transcription(modelId: GroqTranscriptionModelId)` method returning
  `TranscriptionModelV4`.
- `package-lock.json` updated.

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

Rewritten end to end. The new file is a `defineChannel` wrapper around
eve's `telegramChannel`. Imports come from `eve/channels` (for
`defineChannel` and `POST`), `eve/channels/telegram` (for the inner
`telegramChannel` plus the `getTelegramFile` and `downloadTelegramFile`
helpers), `ai` (for `transcribe`), and `@ai-sdk/groq` (for `groq`).

#### 1. Env validation block

Top-of-file fail-fast checks for `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET_TOKEN`, `TELEGRAM_BOT_USERNAME`, and the new
`GROQ_API_KEY`. Each check throws with an actionable message (e.g. for
`GROQ_API_KEY`: "Get a key from https://console.groq.com/keys"). The
existing `crypto.randomBytes(32).toString('hex')` generator hint for
the webhook secret is preserved.

#### 2. `uploadPolicy.allowedMediaTypes`

Add three entries to the existing `["image/*", "application/pdf"]` array:

| Entry | Why |
|---|---|
| `audio/ogg` | Telegram voice notes are typically Ogg Opus. Verified via the `Voice.mime_type` field documented in `python-telegram-bot@v22.7/src/telegram/_files/voice.py`. |
| `audio/mpeg` | Generic MP3 audio sent as `message.audio`. |
| `audio/mp4` | M4A audio sent as `message.audio`. |

The `maxBytes: 10 * 1024 * 1024` cap stays. Telegram `getFile` itself caps
downloads at 20 MB (verified via the python-telegram-bot `File` class
note); our 10 MB cap is conservative on purpose and covers roughly an
hour of voice at typical Opus bitrates.

#### 3. The wrapper route handler

The new file's default export is a `defineChannel({ routes: [...] })`
with a single `POST("/eve/v1/telegram", ...)` route. The handler:

1. Reads the original body once via `req.text()`.
2. JSON-parses it into a loose `TelegramUpdate` shape.
3. Detects `parsed.message.voice ?? parsed.message.audio`.
4. **If neither** → forwards the original body unchanged to the inner
   handler. Every other update type passes through transparently.
5. **If voice/audio** → calls `getTelegramFile({ credentials, fileId })`
   to resolve a `file_path`, then `downloadTelegramFile({ credentials,
   filePath })` to fetch the bytes, then `transcribe({ model:
   groq.transcription("whisper-large-v3-turbo"), audio: Buffer, abortSignal:
   AbortSignal.timeout(15_000) })`. On success, builds a modified JSON
   body that replaces `voice`/`audio` with `text: "[voice Ns,
   lang=xx]\n<transcript>"` (and appends any original caption on a third
   line) and forwards it to the inner handler.
6. **On error** → logs the failure at error level and forwards a
   fallback text message ("I couldn't transcribe that voice note, please
   retry or send as text.") so the agent at least replies rather than
   hanging.

#### 4. Type cast for the inner handler

The inner `telegramChannel`'s route handler is parameterized over
`TelegramChannelState`, while our wrapping `defineChannel` has no state of
its own. The framework hands the same `args` (session machinery, `send`,
`getSession`, etc.) to both handlers at runtime — only the generic type
parameter differs. A single cast via `Parameters<typeof innerHandler>[1]`
keeps the rest of the file type-safe.

#### 5. Logging

One `console.log` per successful transcription at the agreed shape
(`user`, `duration`, `lang`, `chars`). Errors logged via `console.error`.
No transcript content in logs.

### `apps/ghostwriter/agent/instructions.md`

Renumbered "How you work" list to insert a new step 3 about voice
messages. The new step says voice notes are pre-transcribed server-side,
explains the `[voice Ns, lang=xx]` header format, and tells the agent to
treat the transcript as ordinary user input. Mentions that captions on
voice notes appear on a third line after the transcript.

The rest of `instructions.md` is untouched. No changes to
`agent/agent.ts`, no changes to `agent/connections/*`, no changes to the
tool belt.

## Local verification before deploy

Run these in order. Each must pass before moving to the next.

1. **Type check**: `cd apps/ghostwriter && npm run typecheck`.
   Expect zero errors. **Verified 2026-07-08 against Node 22 in this
   shell — passed. The full `eve build` requires Node 24 (per
   `.node-version`); run that on the dev box before merging.**

2. **Build**: `cd apps/ghostwriter && npm run build`. Expect a clean
   build with no missing-module errors. (Requires Node 24.)

3. **Dev server**: `cd apps/ghostwriter && npm run dev`. Expect the
   channel to mount without throwing on the new env check. If any env var
   is missing, startup fails with a specific message.

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
   (the wrapper passes through, eve's group dispatch rules apply). Then
   send a voice note with `@bot_username` mentioned; expect a reply.

## Deploy

1. Merge the branch to `main`. Vercel will redeploy automatically.
2. Confirm the deployment's environment includes `GROQ_API_KEY`
   (Vercel dashboard → Deployments → latest → Environment). If the env
   var is missing at runtime, the channel's startup validation will
   throw.
3. Re-run `curl -i https://ghostwriter-agent.nesalia.com/eve/v1/telegram`
   against the production URL to confirm the route still responds.
4. From a phone, send a production voice note. Confirm reply latency
   and transcript quality match the local test.

## Rollback

The change is small enough to revert with `git revert <merge-sha>`
followed by a push. The webhook does not need to be re-registered;
`setWebhook` was called once at bot setup and points at the channel's
`POST /eve/v1/telegram` route which exists regardless of the wrapper.

After revert:

- Voice updates fall back to the pre-wrapper behavior. With the new
  audio MIME types still in `uploadPolicy`, the inner telegramChannel
  will try to fetch the file (the inner handler calls
  `collectTelegramFileParts` on `message.attachments`, which only
  surfaces `document | photo` kinds — voice has no kind in eve's
  attachment model). The user message will be empty text and no file
  parts, so the agent will receive the `<telegram_context>` block with
  nothing from the user. That's a degraded but non-crashing state.
- Text, photo, PDF, and group-dispatch behavior is unchanged.
- The `GROQ_API_KEY` env var becomes unused but harmless. Remove it
  from Vercel in the same revert PR if you want to keep the env clean.

A targeted rollback that keeps the dependency installed but reverts only
the wrapper logic is also acceptable. The smaller-blast-radius option
is to restore the original `telegramChannel({ ... })` direct export
without our wrapper, redeploy, and accept the degraded voice state.

## Open questions (resolved by implementation)

These were open in the spec at planning time; the implementation
resolved them as follows:

1. **Error message wording**: confirmed exactly as the spec suggested:
   "I couldn't transcribe that voice note, please retry or send as text."

2. **`getFile` location**: lives inline in `channels/telegram.ts`. The
   calls go through eve's own `getTelegramFile` and `downloadTelegramFile`
   helpers (not raw HTTP), so the channel file stays declarative. A
   separate helper module was not needed at this scale.

3. **`sendVoice` magic trigger**: confirmed out of scope for this
   iteration. The agent receives a text transcript and replies in text.

4. **Log destination**: confirmed Vercel stdout via `console.log` /
   `console.error`. No structured logger added.

## What changed from the 2026-07-07 draft

- **Approach**: `onMessage` override → `defineChannel` wrapper.
- **File count**: same (one rewritten channel file, one extended
  instructions file).
- **Dependency**: `@ai-sdk/groq` confirmed compatible at `^4`.
- **Verification**: typecheck verified passing on 2026-07-08 (build
  deferred to dev box due to Node version mismatch in the work shell).

## Estimated effort (actual)

- Verification prep (`onMessage` signature deep-dive, API exploration): 30 min
- Dependency install and env wiring: 2 min
- `channels/telegram.ts` rewrite (incl. type-cast debugging): 30 min
- `instructions.md` paragraph: 2 min
- Typecheck pass: 2 min
- Plan doc revision: 10 min

Total: roughly 75 minutes of focused work, plus the time spent on
verification prep before coding.
# Telegram Voice Message Transcription

**Status**: Proposed
**Owner**: Ghostwriter
**Last updated**: 2026-07-07

## Problem

Ghostwriter is reachable from Telegram as a bot, but the channel only supports
text, photos, and PDFs today. Users who prefer voice notes — including the
target user themselves in many mobile contexts — cannot drive Ghostwriter
through that surface. Sending a voice note to the bot produces no meaningful
response, because the underlying language model does not consume audio as
input.

We want voice messages to feel identical to text messages from the agent's
perspective: the user holds the mic button, talks, releases, and gets a
research-grounded reply as if they had typed.

## Goal

A Telegram voice message (or audio file) arriving at the bot is transcribed
server-side and delivered to the agent as plain text. The agent's response is
sent back through the existing `message.completed` handler, exactly like a
typed message.

Non-goals for this iteration:

- Replying with synthesized voice (TTS). Out of scope; tracked separately.
- Speaker diarization, sentiment, or any post-transcription enrichment.
- Persisting transcripts to durable storage. They live only in the session
  and in a single console log line per message.

## Solution overview

We intercept inbound Telegram updates that carry a `voice` or `audio`
attachment before the default channel handler dispatches them, download the
file from Telegram's `getFile` endpoint, transcribe it with Groq's
`whisper-large-v3-turbo`, and re-inject the transcript as a text message into
the same eve session. From the agent's point of view, the user typed a
slightly-prefixed text string.

This is intentionally a thin server-side translation layer. The agent
(`agent/agent.ts`), its system prompt (`agent/instructions.md`), and its
tool belt (`agent/connections/*`) are unchanged.

## Why transcription, not native multimodal audio

`agent/agent.ts` uses `vercel-minimax-ai-provider` against the
`MiniMax-M3` model. We verified the provider's package contents directly:

- `node_modules/vercel-minimax-ai-provider/dist/index.d.ts` declares
  `MinimaxChatModelId = 'MiniMax-M2' | 'MiniMax-M2.1' | 'MiniMax-M2.1-lightning' | string`
  and exports models implementing `LanguageModelV3` from `@ai-sdk/provider`.
  `LanguageModelV3` is the AI SDK's standard text-only language-model
  interface; it has no `audio` content part.
- The provider's `README.md` documents only `MiniMax-M2`, `MiniMax-M2.1`,
  and `MiniMax-M2.1-lightning` under "Available Models". `MiniMax-M3` is
  not listed. The string-fallback in the type means the model id is not
  blocked at compile time, but nothing in the package advertises or types
  audio support for any model id.
- The agent's own header comment in `agent/agent.ts` describes M3 as having
  "native multimodal input (image + video)" — audio is not listed.

Together this is enough to treat audio input as out of contract: passing
audio bytes through the provider would either be rejected, dropped, or
delivered as opaque content the model cannot ground. Transcribing first
stays inside the text-only contract the provider is typed for, and the
transcript is text the model is already known to handle.

A separate note, out of scope for this feature: `MiniMax-M3` itself is not
in the provider's documented model list. The existing fallback note in
`agent.ts` ("If MiniMax's Anthropic-compat endpoint accepts `MiniMax-M3`,
this works. If it 404s, fall back to `MiniMax-M2.7`.") already covers this;
we are not changing it here.

## Why Groq

The decision pivots on three axes: cost, API surface, and provisioning
effort. Pricing was checked against the vendors' public pricing pages on
2026-07-07.

| Axis | Groq whisper-large-v3-turbo | OpenAI whisper-1 |
|---|---|---|
| Cost per audio hour (USD) | $0.04 | $0.36 ($0.006 / minute) |
| Other Whisper variants offered | `Whisper V3 Large` at $0.111/h | `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` (token-priced) |
| Speed factor (Groq-published) | 228× | not published in equivalent form |
| Minimum billing increment | 10 seconds per request | per-minute, rounded up |
| French transcription quality | Strong | Strong |
| Provisioning effort | Groq API key + `@ai-sdk/groq` (same `transcribe()` API) | OpenAI API key + `@ai-sdk/openai` (same `transcribe()` API) |

Groq is roughly nine times cheaper per audio hour and uses the same
`transcribe({ model, audio })` contract in `ai@^7`, so swapping providers
later is a one-line change in the transcription adapter. The Groq-published
speed factor of 228× is relative to real-time playback, not a measured
end-to-end latency; we have not benchmarked wall-clock latency for this
specific app, and we are not claiming one here.

If Groq becomes unreliable, swapping to OpenAI's `whisper-1` is the
documented fallback because both providers expose the same `transcribe()`
contract.

## Why `onMessage`, not the LLM

We considered letting the agent call a `transcribe_voice` tool on demand.
Three reasons we did not:

1. The model cannot see that an incoming `FilePart` is audio until it has
   already attempted to consume it. If M3 cannot interpret audio, the model
   is likely to ignore it or fail before ever deciding to call a tool.
2. Tool-choice latency is paid on every turn until the model gives up.
   Transcribing up front pays the cost once and only once.
3. The transcript shape we want (`[voice Ns, lang=fr]\n<text>`) is
   information the user does not need to see filtered through model
   reasoning. It is presentation, not reasoning.

`onMessage` is the right hook: it runs before the channel dispatches the
message into the session, so by the time the agent sees content, it is text.

## Flow

```
Telegram user holds mic, releases
         │
         ▼
POST /eve/v1/telegram   (webhook, signed by X-Telegram-Bot-Api-Secret-Token)
         │
         ▼
telegramChannel.onMessage(update)
         │
         ├── update.message.voice  ──► downloadTelegramFile(file_id)
         │                                    │
         │                                    ▼
         │                          transcribe({ model: groq('whisper-large-v3-turbo'),
         │                                          audio: <Buffer> })
         │                                    │
         │                                    ▼
         │                          "[voice 12s, lang=fr]\n<transcript>"
         │
         └── otherwise ──► default channel dispatch
                                  │
                                  ▼
                         eve session runs the agent
                                  │
                                  ▼
                         message.completed handler
                         (sendMessage back via Telegram)
```

A single Telegram update either contains a voice/audio or it does not; the
override path and the default path do not interleave.

## Configuration

### New environment variable

`GROQ_API_KEY` is required. It is read from `apps/ghostwriter/.env` in
development and from the Vercel project's environment variables in
production. The key is owned by Groq Cloud; rotate via the Groq dashboard.

### Updated `uploadPolicy`

The existing policy in `agent/channels/telegram.ts` allows only `image/*`
and `application/pdf`. To permit the channel's attachment pipeline to even
consider voice and audio files before our override intercepts them, we add
the relevant MIME types:

| Type | Why |
|---|---|
| `audio/ogg` | Telegram voice notes are typically Ogg Opus; this is the conventional MIME type Telegram clients send for `message.voice`. The `Voice` object exposes `mime_type` as an optional field, so the client can override. |
| `audio/mpeg` | Generic MP3 audio sent via Telegram's audio attachment (`message.audio`) |
| `audio/mp4` | M4A audio sent via Telegram's audio attachment |

The `Voice` object fields, verified against the python-telegram-bot v22.7
source (`src/telegram/_files/voice.py`), are `file_id` (str, required),
`file_unique_id` (str, required), `duration` (int seconds, required),
`mime_type` (str, optional), and `file_size` (int bytes, optional). The
`file_id` is what we hand to `getFile` to resolve a download URL.

The `10 MB` size cap stays. The Telegram `getFile` endpoint enforces a
20 MB maximum file size for downloads (verified via the python-telegram-bot
`File` class note: "Maximum file size to download is 20 MB."), so anything
over 10 MB on the receiving side is already excluded by Telegram itself
for files above the 20 MB threshold. Our 10 MB cap is conservative on
purpose: it keeps payloads predictable for Groq (whose billing increments
in 10-second slices) and for the agent's context window, and it covers
roughly an hour of voice at typical Opus bitrates.

### What stays the same

- The strict dispatch rules (DM = all, group = `/ask` / mention / reply).
- The webhook registration at `https://ghostwriter-agent.nesalia.com/eve/v1/telegram`.
- The `sendMessage` plain-text delivery path for the agent's reply.
- The HITL inline-keyboard behavior for `ask_question` tool calls.

## Transcript format

The agent sees a single text message with a one-line header:

```
[voice 12s, lang=fr]

OK donc je veux que tu m'écrives un thread LinkedIn sur les agents autonomes,
pas plus de 280 caractères par post, et je veux que tu cites au moins une
source primaire.
```

The header is a soft convention rather than a hard protocol. The agent is
free to acknowledge it ("I received a 12-second voice note in French:
..."), treat it as plain input, or ignore it entirely. The point is to make
voice provenance traceable when reading transcripts in session history
without forcing the agent into a specific response shape.

## Privacy and data handling

| What | Where it goes | Retention |
|---|---|---|
| Original audio bytes | Downloaded from Telegram via `getFile`, passed to Groq, discarded after `transcribe()` returns | None |
| Transcript | Injected into the eve session as user-role content; follows the session's normal retention | Whatever eve sessions already retain |
| Console log | One line per message: user_id, duration, detected language, transcript length | Stays in Vercel's function logs per their retention policy |

Audio bytes are not written to disk, not cached, not persisted to a
database. They live only in the function invocation's memory for the
duration of the transcription call.

The disclosure rule in `agent/instructions.md` ("You are an automated AI
assistant. When required by law or platform policy, disclose this to the
user unprompted.") applies unchanged.

## Limits and edge cases

| Case | Behavior |
|---|---|
| `GROQ_API_KEY` missing at startup | Fail-fast with a clear error pointing at `.env`, mirroring the existing telegram env validation |
| Telegram update has no `message.voice` / `message.audio` | Override is a no-op; default channel dispatch runs |
| Voice note in a group that does not mention the bot | Caught upstream by eve's group dispatch rules; never reaches the transcription path |
| Groq returns an empty transcript | The agent receives an empty message with the header line. Likely user silence — fine to ignore or ask for clarification |
| Audio file larger than `uploadPolicy.maxBytes` (10 MB) | Dropped by eve before our code sees it. User gets no error; could be improved later with an explicit reply. Note that Telegram's `getFile` itself caps downloads at 20 MB, so the hard ceiling is on Telegram's side, not ours. |
| Audio file within size cap but Groq rejects (corrupted, unsupported codec) | `transcribe()` throws; we log and surface a short user-facing message ("I couldn't transcribe that voice note, please retry or send as text"). Groq's minimum billing increment is 10 seconds per request, so sub-10s clips still incur that floor on the bill. |
| Multiple attachments in one update | We process the first voice/audio only. Telegram caps to one voice per message, so this is theoretical |
| User sends voice in a forum topic | Inherits the existing `message_thread_id` continuation token behavior; transcript stays in the same topic thread |

## Testing plan

1. **Local synthetic test**: send a small OGG file via `sendMessage` API with
   `parse_mode` suppressed, simulating a voice note. Verify the transcript
   lands in the agent's session history with the correct header.
2. **DM voice test from a real phone**: send a 5-second French voice note
   to the bot. Confirm reply latency and transcript accuracy.
3. **Group dispatch test**: in a Telegram group with the bot added, send a
   voice note without mentioning the bot. Confirm the bot does not react.
   Then send a voice note mentioning the bot. Confirm transcription + reply.
4. **Cost probe**: send ten 30-second voice notes over a short window and
   inspect Groq usage for the matching time window.
5. **Failure path**: temporarily set `GROQ_API_KEY` to an invalid value,
   send a voice note, and confirm the user-facing error message and the
   function log line.

## Future work

- **TTS replies**: a `sendVoice` path in the `message.completed` handler,
  gated on a session-level preference. AI SDK's `experimental_generateSpeech`
  with ElevenLabs is the obvious provider pair.
- **Cost attribution**: surface Groq usage per Telegram user in
  instrumentation metadata, so heavy voice users are visible.
- **Language hints**: when Telegram's `message.from.language_code` is
  present, pass it as a `language` hint to `transcribe()` to reduce
  misdetection on short clips.
- **Streaming transcription**: for long voice notes, use
  `experimental_streamTranscribe` so the agent can start reasoning on the
  first segments instead of waiting for the full file.
- **Quote-and-reply voice**: when the user replies to a previous bot
  message with a voice note, prepend the quoted context to the transcript
  before sending it into the session.

## Verification status

This doc was rewritten after a verification pass on 2026-07-07. Claims
below are tagged by source.

### Verified against primary sources

| Claim | Source checked |
|---|---|
| eve telegram channel supports only "photos and documents" out of the box, with `uploadPolicy` as the gate and `getFile` for fetching | UNPKG `eve@0.12.3/docs/channels/telegram.mdx`, fetched 2026-07-07 |
| eve's `defineChannel` accepts `FilePart` with `data: Buffer \| URL` and `mediaType`, and exposes `fetchFile(url)` for authenticated URL fetching | UNPKG `eve@0.13.3/docs/channels/custom.mdx`, fetched 2026-07-07 |
| Forum topics carry `message_thread_id` in the continuation token | Same eve telegram.mdx |
| AI SDK `transcribe({ model, audio })` accepts `Buffer / Uint8Array / ArrayBuffer / base64 / URL` | `ai-sdk.dev/docs/ai-sdk-core/transcription`, fetched 2026-07-07 |
| `whisper-large-v3-turbo` and `whisper-1` are listed AI SDK transcription providers | Same AI SDK doc |
| AI SDK URL download cap is 2 GiB by default, configurable via `createDownload({ maxBytes })` | Same AI SDK doc |
| Chat SDK distinguishes `files` (always document) vs `attachments` (preserves media type); Telegram supports typed outgoing media | `chat-sdk.dev/docs/files`, fetched 2026-07-07 |
| Groq `whisper-large-v3-turbo` is **$0.04 per hour transcribed**, with a 10-second minimum billing increment and a 228× speed factor | `groq.com/pricing/`, fetched 2026-07-07 |
| Groq also offers `Whisper V3 Large` at **$0.111/hour** | Same Groq pricing page |
| OpenAI `whisper-1` is **$0.006/minute** ($0.36/hour), audio-input only | `platform.openai.com/docs/models/whisper-1`, fetched 2026-07-07 |
| Telegram `Voice` object has fields `file_id, file_unique_id, duration, mime_type, file_size` | `python-telegram-bot@v22.7/src/telegram/_files/voice.py`, fetched 2026-07-07 |
| Telegram `getFile` enforces a **20 MB maximum download size** | `python-telegram-bot@v22.4/telegram.File` note, fetched 2026-07-07 |
| `vercel-minimax-ai-provider` exports models implementing `LanguageModelV3` from `@ai-sdk/provider` (text-only interface, no audio content part) | `node_modules/vercel-minimax-ai-provider/dist/index.d.ts`, read 2026-07-07 |
| The provider's README documents only `MiniMax-M2`, `MiniMax-M2.1`, `MiniMax-M2.1-lightning`. `MiniMax-M3` is not listed. | `node_modules/vercel-minimax-ai-provider/README.md`, read 2026-07-07 |
| The agent's `agent/agent.ts` header comment says M3 has "native multimodal input (image + video)" — audio is not listed | Direct read of the file in this repo |

### Claims that are design proposals, not facts

- The transcript header `[voice Ns, lang=fr]` — convention proposed by this doc, not required by any framework.
- The flow diagram in the **Flow** section — conceptual, not lifted from eve documentation.
- The list of edge cases in **Limits and edge cases** — derived from reading the channel docs, not enumerated verbatim by eve.
- The 5-step **Testing plan** — proposed procedure, not a verified test suite.

### Claims that were removed during the verification pass

The first draft of this doc contained several specific numeric and SLA
claims that could not be verified against primary sources in the time
budget. They were removed rather than hedged in place. They are listed
here so future revisions can re-add them if proper sources appear:

- A claimed 50 MB cap on Telegram voice messages. The verified figure is
  20 MB for `getFile` downloads; the 50 MB figure applies to uploads via
  the Bot API, which is a different direction.
- A claimed "narrower uptime SLA" for Groq versus OpenAI. No primary SLA
  document was retrieved; the claim was opinion.
- A claimed "<1 second latency for a 30-second voice note" on Groq.
  Groq's published 228× speed factor is relative to playback, not a
  measured end-to-end latency for our integration.
- A claimed "2–4 second latency" on OpenAI whisper-1. Same issue.
- A claimed "image and video, with no documented audio input support"
  framing for M3. The verified framing is that the provider implements
  the text-only `LanguageModelV3` interface and that audio is not listed
  anywhere in the provider's package or docs.
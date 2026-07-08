import { defineChannel, POST } from "eve/channels";
import {
  telegramChannel,
  getTelegramFile,
  downloadTelegramFile,
} from "eve/channels/telegram";
import { transcribe } from "ai";
import { groq } from "@ai-sdk/groq";

/**
 * Telegram channel for ghostwriter, with voice-message transcription.
 *
 * Wraps eve's built-in `telegramChannel`: intercepts the raw webhook,
 * downloads and transcribes any `voice` or `audio` attachment via Groq
 * Whisper, then forwards the request to the inner channel's handler with
 * the audio replaced by the transcript text. Every other update flows
 * through unchanged so all of eve's built-in behavior (group dispatch,
 * HITL, callback queries, reply handling, forum topics) keeps working.
 *
 * Reads credentials from the environment:
 *   TELEGRAM_BOT_TOKEN             — from @BotFather
 *   TELEGRAM_WEBHOOK_SECRET_TOKEN  — random hex also sent to setWebhook
 *   TELEGRAM_BOT_USERNAME          — the @handle BotFather assigned (no `@`)
 *   GROQ_API_KEY                   — from https://console.groq.com/keys
 *
 * Attachments are constrained to images, PDFs, and audio up to 10 MB to
 * keep payload sizes predictable for both Groq and the agent context.
 *
 * Remember: register the webhook yourself via setWebhook — eve does not
 * call it for you. See docs/internal/architecture/plans/implementation/
 * voice-transcription.md for the setWebhook curl.
 */

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const webhookSecretToken = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
const botUsername = process.env.TELEGRAM_BOT_USERNAME;
const groqApiKey = process.env.GROQ_API_KEY;

if (!botUsername) {
  throw new Error(
    "TELEGRAM_BOT_USERNAME is not set. Add it to .env (the @handle BotFather assigned, without `@`).",
  );
}
if (!botToken) {
  throw new Error("TELEGRAM_BOT_TOKEN is not set. Add it to .env.");
}
if (!webhookSecretToken) {
  throw new Error(
    "TELEGRAM_WEBHOOK_SECRET_TOKEN is not set. Generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"` and register it via setWebhook.",
  );
}
if (!groqApiKey) {
  throw new Error(
    "GROQ_API_KEY is not set. Add it to .env. Get a key from https://console.groq.com/keys",
  );
}

const credentials = { botToken, webhookSecretToken };

// Inner channel: handles all of eve's built-in telegram behavior
// (group dispatch, mentions, HITL, callback queries, forum topics,
// reply handling). We extract its route handler so we can wrap it.
const inner = telegramChannel({
  botUsername,
  credentials,
  uploadPolicy: {
    allowedMediaTypes: [
      "image/*",
      "application/pdf",
      "audio/ogg",
      "audio/mpeg",
      "audio/mp4",
    ],
    maxBytes: 10 * 1024 * 1024,
  },
});

const innerRoute = inner.routes[0];
if (!innerRoute || innerRoute.transport === "websocket") {
  throw new Error(
    "telegramChannel did not expose a single HTTP route; cannot wrap it.",
  );
}
const innerHandler = innerRoute.handler;

type TelegramUpdate = {
  message?: {
    voice?: { file_id: string };
    audio?: { file_id: string };
    caption?: string;
    from?: { id?: number | string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function formatTranscriptHeader(
  durationInSeconds: number | undefined,
  language: string | undefined,
  text: string,
  originalCaption: string | undefined,
): string {
  const dur = durationInSeconds ?? "?";
  const lang = language ?? "?";
  const header = `[voice ${dur}s, lang=${lang}]\n${text}`;
  return originalCaption ? `${header}\n${originalCaption}` : header;
}

async function transcribeVoiceNote(fileId: string): Promise<{
  text: string;
  language: string | undefined;
  durationInSeconds: number | undefined;
}> {
  const { filePath } = await getTelegramFile({ credentials, fileId });
  const fileResponse = await downloadTelegramFile({
    credentials,
    filePath,
  });
  if (!fileResponse.ok) {
    throw new Error(
      `Telegram file download failed: ${fileResponse.status} ${fileResponse.statusText}`,
    );
  }
  const bytes = Buffer.from(await fileResponse.arrayBuffer());

  const result = await transcribe({
    model: groq.transcription("whisper-large-v3-turbo"),
    audio: bytes,
    abortSignal: AbortSignal.timeout(15_000),
  });

  return {
    text: result.text,
    language: result.language,
    durationInSeconds: result.durationInSeconds,
  };
}

function buildModifiedRequest(
  original: Request,
  modifiedBody: string,
): Request {
  return new Request(original.url, {
    method: original.method,
    headers: original.headers,
    body: modifiedBody,
  });
}

// The inner telegramChannel's route handler is parameterized over
// TelegramChannelState, while our wrapping defineChannel has no state of
// its own. At runtime the framework hands the same `args` (session
// machinery, send, getSession, etc.) to both handlers — only the generic
// type parameter differs. Cast once here so the rest of the file stays
// type-safe.
type InnerArgs = Parameters<typeof innerHandler>[1];
function forwardToInner(req: Request, args: unknown, body: string) {
  return innerHandler(
    buildModifiedRequest(req, body),
    args as InnerArgs,
  );
}

export default defineChannel({
  routes: [
    POST("/eve/v1/telegram", async (req, args) => {
      const originalBody = await req.text();

      let parsed: TelegramUpdate;
      try {
        parsed = JSON.parse(originalBody);
      } catch {
        // Not JSON — let the inner channel decide (it will 200 "ok" on bad JSON)
        return forwardToInner(req, args, originalBody);
      }

      const voiceOrAudio = parsed?.message?.voice ?? parsed?.message?.audio;

      if (!voiceOrAudio) {
        // Plain pass-through — preserves every built-in behavior
        return forwardToInner(req, args, originalBody);
      }

      const userId = parsed?.message?.from?.id;
      const originalCaption = parsed?.message?.caption;

      try {
        const { text, language, durationInSeconds } =
          await transcribeVoiceNote(voiceOrAudio.file_id);

        console.log(
          `[voice transcription] user=${userId ?? "?"} duration=${durationInSeconds ?? "?"} lang=${language ?? "?"} chars=${text.length}`,
        );

        const transcript = formatTranscriptHeader(
          durationInSeconds,
          language,
          text,
          originalCaption,
        );

        const modifiedMessage = {
          ...parsed.message,
          voice: undefined,
          audio: undefined,
          text: transcript,
          caption: "",
        };
        const modifiedBody = JSON.stringify({
          ...parsed,
          message: modifiedMessage,
        });

        return forwardToInner(req, args, modifiedBody);
      } catch (error) {
        console.error(
          `[voice transcription] failed user=${userId ?? "?"}`,
          error,
        );
        const fallbackText =
          "I couldn't transcribe that voice note, please retry or send as text.";
        const fallbackBody = JSON.stringify({
          ...parsed,
          message: {
            ...parsed.message,
            voice: undefined,
            audio: undefined,
            text: fallbackText,
            caption: "",
          },
        });
        return forwardToInner(req, args, fallbackBody);
      }
    }),
  ],
});
import {
  telegramChannel,
  defaultTelegramAuth,
  getTelegramFile,
  downloadTelegramFile,
} from "eve/channels/telegram";
import { transcribe } from "ai";
import { groq } from "@ai-sdk/groq";

/**
 * Telegram channel for ghostwriter, with voice-message transcription.
 *
 * The `onMessage` override detects `voice` / `audio` attachments on the
 * raw Telegram update (eve's `TelegramMessage` parser does not surface
 * these as attachments, so `message.raw` is the only handle), downloads
 * the file via Telegram's `getFile`, transcribes it through Groq's
 * `whisper-large-v3-turbo`, and returns the transcript as a `context`
 * string. eve prepends context strings to the user-role history before
 * the delivery message, so the agent sees the transcript alongside the
 * standard `<telegram_context>` block.
 *
 * For non-voice messages the override mirrors eve's built-in
 * `shouldDispatchTelegramMessage` gate (DM-only, or reply-to-bot /
 * `/ask` command / `@bot_username` mention in groups), so group
 * dispatch rules stay intact.
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

/**
 * Mirror of eve's `shouldDispatchTelegramMessage` from
 * `eve/dist/src/public/channels/telegram/defaults.js`. Kept inline
 * because `defaultOnMessage` is not part of the public exports.
 */
function shouldDispatch(
  message: { from?: { isBot?: boolean }; chat: { type: string }; text: string; caption: string; attachments: readonly unknown[]; replyToMessage?: { from?: { isBot?: boolean } } },
  rawVoiceOrAudio: unknown,
  botUsername: string | undefined,
): boolean {
  if (message.from?.isBot === true || message.chat.type === "channel") {
    return false;
  }
  const text = message.text || message.caption;
  const isVoice = rawVoiceOrAudio != null;
  const hasText = text.trim().length > 0;
  const hasAttachments = message.attachments.length > 0;
  if (!isVoice && !hasText && !hasAttachments) {
    return false;
  }
  const isPrivate = message.chat.type === "private";
  const isReplyToBot = message.replyToMessage?.from?.isBot === true;
  const isCommand = hasText && /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text);
  const isMention =
    botUsername !== undefined &&
    text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
  return isPrivate || isReplyToBot || isCommand || isMention;
}

async function transcribeVoiceNote(fileId: string): Promise<{
  text: string;
  language: string | undefined;
  durationInSeconds: number | undefined;
}> {
  const { filePath } = await getTelegramFile({ credentials, fileId });
  const fileResponse = await downloadTelegramFile({ credentials, filePath });
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

function formatTranscript(
  durationInSeconds: number | undefined,
  language: string | undefined,
  text: string,
  originalCaption: string,
): string {
  const header = `[voice ${durationInSeconds ?? "?"}s, lang=${language ?? "?"}]\n${text}`;
  return originalCaption ? `${header}\n${originalCaption}` : header;
}

export default telegramChannel({
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
  onMessage: async (ctx, message) => {
    const rawMessage = (message.raw as { message?: { voice?: { file_id: string }; audio?: { file_id: string } } })
      ?.message;
    const voiceOrAudio = rawMessage?.voice ?? rawMessage?.audio;

    if (
      !shouldDispatch(
        message,
        voiceOrAudio,
        ctx.telegram.botUsername,
      )
    ) {
      return null;
    }

    await ctx.telegram.startTyping();

    if (!voiceOrAudio) {
      return { auth: defaultTelegramAuth(message) };
    }

    const userId = message.from?.id;
    try {
      const { text, language, durationInSeconds } =
        await transcribeVoiceNote(voiceOrAudio.file_id);

      console.log(
        `[voice transcription] user=${userId ?? "?"} duration=${durationInSeconds ?? "?"} lang=${language ?? "?"} chars=${text.length}`,
      );

      const transcript = formatTranscript(
        durationInSeconds,
        language,
        text,
        message.caption,
      );

      return {
        auth: defaultTelegramAuth(message),
        context: [transcript],
      };
    } catch (error) {
      console.error(
        `[voice transcription] failed user=${userId ?? "?"}`,
        error,
      );
      return {
        auth: defaultTelegramAuth(message),
        context: [
          "I couldn't transcribe that voice note, please retry or send as text.",
        ],
      };
    }
  },
});
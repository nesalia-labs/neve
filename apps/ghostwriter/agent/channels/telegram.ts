import { telegramChannel } from "eve/channels/telegram";

/**
 * Telegram channel for ghostwriter.
 *
 * Reads credentials from the environment:
 *   TELEGRAM_BOT_TOKEN             — from @BotFather
 *   TELEGRAM_WEBHOOK_SECRET_TOKEN  — random hex you also send to setWebhook
 *   TELEGRAM_BOT_USERNAME          — the @handle BotFather assigned (no `@`)
 *
 * If any is missing, the factory throws at module load with a clear error —
 * declare them in .env before running `eve dev` or deploying.
 *
 * Attachments are constrained to images and PDFs up to 10 MB to keep
 * payload sizes predictable for the model context.
 */
export function makeTelegramChannel() {
  const botUsername = process.env.TELEGRAM_BOT_USERNAME;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecretToken = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;

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

  return telegramChannel({
    botUsername,
    credentials: {
      botToken,
      webhookSecretToken,
    },
    uploadPolicy: {
      allowedMediaTypes: ["image/*", "application/pdf"],
      maxBytes: 10 * 1024 * 1024,
    },
  });
}

export default makeTelegramChannel();

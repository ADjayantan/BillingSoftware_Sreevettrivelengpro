import 'server-only';
import { z } from 'zod';

export interface TelegramSendResult {
  sent: boolean;
  /** Telegram is not set up, so nothing was tried. */
  skipped: boolean;
  chatId?: string;
  error?: string;
  /** Telegram said no to this message: repeating it cannot help. */
  refused?: boolean;
}

/** Telegram takes no message longer than this. */
export const TELEGRAM_MAX_CHARS = 4096;

const ATTEMPTS = 3;
const TIMEOUT_MS = 15_000;
/** Asked to wait longer than this, the next scheduled run is the better retry. */
const MAX_WAIT_MS = 30_000;

const tooManyRequests = z.object({ parameters: z.object({ retry_after: z.number().positive() }) });

/**
 * Shared server-only Telegram notification helper.
 * Reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` / `TELEGRAM_OWNER_CHAT_ID`.
 * Gracefully no-ops (`{ sent: false, skipped: true }`) when credentials are unset in dev.
 *
 * Nothing calls a scheduled job again when it fails, so a passing fault is retried here. A
 * connection lost after Telegram took the message makes it arrive twice: better than never.
 */
export async function sendTelegramAlert(options: {
  text: string;
  chatId?: string | null;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  disableWebPagePreview?: boolean;
  sleep?: (ms: number) => Promise<void>;
}): Promise<TelegramSendResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  const chatId = (
    options.chatId?.trim() ||
    env.TELEGRAM_OWNER_CHAT_ID?.trim() ||
    env.TELEGRAM_CHAT_ID?.trim() ||
    ''
  );

  if (!botToken || !chatId) {
    return { sent: false, skipped: true };
  }

  for (let attempt = 1; ; attempt++) {
    let wait = 2000 * attempt;
    let error: string;
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: options.text,
          disable_web_page_preview: options.disableWebPagePreview ?? true,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) return { sent: true, skipped: false, chatId };
      error = `HTTP ${response.status}`;
      if (response.status === 429) {
        const told = tooManyRequests.safeParse(await response.json().catch(() => null));
        if (told.success) wait = told.data.parameters.retry_after * 1000;
      } else if (response.status < 500) {
        return { sent: false, skipped: false, chatId, error, refused: true };
      }
    } catch {
      // Not the library's own words: an address in them has the bot token in it.
      error = 'no answer';
    }
    if (attempt === ATTEMPTS || wait > MAX_WAIT_MS) return { sent: false, skipped: false, chatId, error };
    await sleep(wait);
  }
}

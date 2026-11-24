import 'server-only';

export interface TelegramSendResult {
  sent: boolean;
  skipped: boolean;
  chatId?: string;
  error?: string;
}

/**
 * Shared server-only Telegram notification helper.
 * Reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` / `TELEGRAM_OWNER_CHAT_ID`.
 * Gracefully no-ops (`{ sent: false, skipped: true }`) when credentials are unset in dev.
 */
export async function sendTelegramAlert(options: {
  text: string;
  chatId?: string | null;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  disableWebPagePreview?: boolean;
}): Promise<TelegramSendResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
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

  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: options.text,
        disable_web_page_preview: options.disableWebPagePreview ?? true,
      }),
    });
    if (!response.ok) {
      return { sent: false, skipped: false, chatId, error: `HTTP ${response.status}` };
    }
    return { sent: true, skipped: false, chatId };
  } catch (error) {
    return {
      sent: false,
      skipped: false,
      chatId,
      error: error instanceof Error ? error.message : 'Telegram request failed',
    };
  }
}

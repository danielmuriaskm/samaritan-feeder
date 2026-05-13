import { config } from './config.js';

/**
 * Push an intelligence alert to Samaritan for proactive delivery
 * (e.g. Telegram DM via the bot's internal endpoint).
 */
export async function pushAlertToSamaritan(opts: {
  userId: string;
  chatId?: number;
  title: string;
  content: string;
  mediaUrls?: string[];
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${config.SAMARITAN_BASE_URL}/internal/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-samaritan-auth': config.SAMARITAN_AUTH_TOKEN,
      },
      body: JSON.stringify({
        chat_id: opts.chatId,
        text: `🚨 *Intel Alert*\n\n*${opts.title}*\n\n${opts.content}`,
        parse_mode: 'Markdown',
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Samaritan returned ${res.status}: ${text}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fetch a user's intelligence digest from the feeder itself.
 * Called by Samaritan during system prompt assembly.
 */
export async function getDigestForUser(_userId: string, _query?: string): Promise<string | null> {
  // In the feeder service, this would query local DB.
  // When called from Samaritan, it would hit the feeder's /digest endpoint.
  return null;
}

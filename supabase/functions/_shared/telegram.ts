// Shared Telegram Bot API helpers used by the telegram-webhook and
// telegram-notify Edge Functions.
//
// Env (set as Supabase secrets — see docs/v41_telegram_setup.md):
//   TELEGRAM_BOT_TOKEN   — from BotFather, required.

export function botToken(): string {
  const t = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  return t;
}

// Thin wrapper around https://api.telegram.org/bot<token>/<method>.
export async function tgApi(
  method: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; description?: string; result?: unknown }> {
  const res = await fetch(
    `https://api.telegram.org/bot${botToken()}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return await res.json();
}

// Telegram HTML parse mode requires <, >, & escaped in text nodes.
export function tgEscape(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function sendMessage(
  chatId: string | number,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return await tgApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

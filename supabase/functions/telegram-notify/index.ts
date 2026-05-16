// telegram-notify — invoked by the Supabase Database Webhook on
// INSERT into public.notification_queue. Delivers one queued row to
// the recipient's linked Telegram chat and stamps the row.
//
// Security: the Database Webhook is configured to send a custom header
// `x-notify-secret: <NOTIFY_FN_SECRET>`. We reject anything else so the
// public function URL can't be used to fan out spam.
//
// It is best-effort and idempotent-ish: it only acts on rows still in
// status 'pending', and always leaves the row in a terminal state
// (sent / failed / skipped) so a row is never delivered twice by a
// webhook retry.
//
// Env: TELEGRAM_BOT_TOKEN, NOTIFY_FN_SECRET,
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMessage, tgEscape } from "../_shared/telegram.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const secret = Deno.env.get("NOTIFY_FN_SECRET");
  if (!secret || req.headers.get("x-notify-secret") !== secret) {
    return new Response("forbidden", { status: 403 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // Supabase Database Webhook shape: { type, table, record, old_record }
  const row = payload?.record;
  if (!row?.id) return new Response("no record", { status: 200 });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Re-read under service role and only proceed if still pending — this
  // guards against duplicate webhook deliveries.
  const { data: q } = await admin
    .from("notification_queue")
    .select("id, recipient_user_id, title, body, link_url, status, attempts")
    .eq("id", row.id)
    .maybeSingle();

  if (!q || q.status !== "pending") {
    return new Response("ok", { status: 200 });
  }

  const { data: prof } = await admin
    .from("profiles")
    .select("telegram_chat_id, telegram_notifications_enabled")
    .eq("id", q.recipient_user_id)
    .maybeSingle();

  // No linked chat, or user opted out → skip (not an error).
  if (!prof?.telegram_chat_id || prof.telegram_notifications_enabled === false) {
    await admin
      .from("notification_queue")
      .update({ status: "skipped", sent_at: new Date().toISOString() })
      .eq("id", q.id);
    return new Response("skipped", { status: 200 });
  }

  const lines = [
    `<b>${tgEscape(q.title)}</b>`,
    tgEscape(q.body),
  ];
  if (q.link_url) lines.push(`\n<a href="${tgEscape(q.link_url)}">Open in app</a>`);

  try {
    const r = await sendMessage(prof.telegram_chat_id, lines.join("\n"));
    if (r.ok) {
      await admin
        .from("notification_queue")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", q.id);
      return new Response("sent", { status: 200 });
    }
    await admin
      .from("notification_queue")
      .update({
        status: "failed",
        attempts: (q.attempts ?? 0) + 1,
        error: (r.description ?? "telegram api error").slice(0, 500),
      })
      .eq("id", q.id);
    return new Response("telegram error", { status: 200 });
  } catch (e) {
    await admin
      .from("notification_queue")
      .update({
        status: "failed",
        attempts: (q.attempts ?? 0) + 1,
        error: String(e).slice(0, 500),
      })
      .eq("id", q.id);
    return new Response("error", { status: 200 });
  }
});

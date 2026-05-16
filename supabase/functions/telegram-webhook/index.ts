// telegram-webhook — the bot's webhook endpoint.
//
// Telegram POSTs every update here. We only care about text commands:
//   /start <token>  link this chat to the profile that minted <token>
//   /start          (no token) help text
//   /stop           unlink this chat
//   /status         report link state
//
// Security: Telegram is told a secret token when the webhook is
// registered; it echoes it back in X-Telegram-Bot-Api-Secret-Token on
// every call. We reject anything that doesn't match TELEGRAM_WEBHOOK_SECRET.
//
// We always return 200 (even on logical errors) so Telegram does not
// retry-storm the endpoint; problems are surfaced to the user in chat.
//
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET,
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMessage, tgEscape } from "../_shared/telegram.ts";

const ok = () => new Response("ok", { status: 200 });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const secret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  if (
    !secret ||
    req.headers.get("x-telegram-bot-api-secret-token") !== secret
  ) {
    return new Response("forbidden", { status: 403 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return ok();
  }

  const msg = update?.message ?? update?.edited_message;
  const chatId = msg?.chat?.id;
  const text: string = (msg?.text ?? "").trim();
  if (!chatId || !text) return ok();

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*/, ""); // strip @botname suffix
  const arg = rest.join(" ").trim();
  const tgUsername = msg?.chat?.username
    ? "@" + msg.chat.username
    : (msg?.from?.username ? "@" + msg.from.username : null);

  try {
    if (cmd === "/start" && arg) {
      const { data: tok } = await admin
        .from("telegram_link_tokens")
        .select("token, user_id, expires_at, used_at")
        .eq("token", arg)
        .maybeSingle();

      if (!tok || tok.used_at || new Date(tok.expires_at) < new Date()) {
        await sendMessage(
          chatId,
          "⚠️ That link is invalid or has expired.\n\nOpen <b>Notifications</b> in the app and tap <b>Connect Telegram</b> again to get a fresh link.",
        );
        return ok();
      }

      // Bind the chat to the profile. The partial unique index on
      // profiles.telegram_chat_id keeps one chat → one profile.
      const { error: upErr } = await admin
        .from("profiles")
        .update({
          telegram_chat_id: String(chatId),
          telegram_username: tgUsername,
          telegram_linked_at: new Date().toISOString(),
        })
        .eq("id", tok.user_id);

      if (upErr) {
        // Most likely the unique-index violation: this chat is already
        // linked to a different profile.
        await sendMessage(
          chatId,
          "⚠️ This Telegram account is already linked to another profile. Send /stop there first, then try again.",
        );
        return ok();
      }

      await admin
        .from("telegram_link_tokens")
        .update({ used_at: new Date().toISOString() })
        .eq("token", tok.token);

      await sendMessage(
        chatId,
        "✅ <b>Connected.</b>\n\nYou'll now receive recruitment notifications here — approvals waiting on you, requisition status changes, candidate moves and interview scheduling.\n\nSend /stop anytime to turn these off.",
      );
      return ok();
    }

    if (cmd === "/start") {
      await sendMessage(
        chatId,
        "👋 This bot delivers recruitment notifications.\n\nTo connect: open the app, go to <b>Notifications</b>, and tap <b>Connect Telegram</b>. That gives you a one-tap link back here.",
      );
      return ok();
    }

    if (cmd === "/stop") {
      const { data: prof } = await admin
        .from("profiles")
        .select("id")
        .eq("telegram_chat_id", String(chatId))
        .maybeSingle();

      if (!prof) {
        await sendMessage(chatId, "This chat isn't linked to any profile.");
        return ok();
      }

      await admin
        .from("profiles")
        .update({
          telegram_chat_id: null,
          telegram_username: null,
          telegram_linked_at: null,
        })
        .eq("id", prof.id);

      await sendMessage(
        chatId,
        "🔕 Disconnected. You won't receive notifications here anymore. Reconnect anytime from the app.",
      );
      return ok();
    }

    if (cmd === "/status") {
      const { data: prof } = await admin
        .from("profiles")
        .select("telegram_notifications_enabled, telegram_linked_at")
        .eq("telegram_chat_id", String(chatId))
        .maybeSingle();

      if (!prof) {
        await sendMessage(chatId, "Not linked. Connect from the app's Notifications page.");
      } else {
        await sendMessage(
          chatId,
          `✅ Linked${prof.telegram_linked_at ? " since " + tgEscape(new Date(prof.telegram_linked_at).toUTCString()) : ""}.\nNotifications are <b>${prof.telegram_notifications_enabled ? "on" : "off"}</b> (change in the app).`,
        );
      }
      return ok();
    }

    await sendMessage(
      chatId,
      "Commands: /start &lt;link&gt;, /status, /stop.\nConnect from the app's <b>Notifications</b> page.",
    );
    return ok();
  } catch (e) {
    console.error("telegram-webhook error", e);
    return ok(); // never make Telegram retry
  }
});

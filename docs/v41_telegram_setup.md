# v41 — Telegram notifications: setup guide

This wires the platform up to a Telegram bot so users get a message
when an approval, a requisition status change, a candidate move, or an
interview scheduling concerns them.

You only do this **once**. After it's live, each user self-serves from
the in-app **Notifications** page.

---

## Architecture (1 minute read)

```
 workflow action (browser)
        │  persistReqChange / persistCandidateChange
        ▼
 notification_queue  (one row per recipient)        ← RLS, tenant-scoped
        │  Supabase Database Webhook on INSERT
        ▼
 telegram-notify  (Edge Function, service role)
        │  resolves recipient's linked chat, sends
        ▼
 Telegram  ──────────────────────────────────────►  user's phone

 Linking:  app "Connect Telegram" → create_telegram_link_token() RPC
           → t.me/<bot>?start=<token> → telegram-webhook Edge Function
           binds chat to profile.
```

Nothing runs on a server we own — only the static frontend, Supabase
Postgres, and two Edge Functions.

---

## Step 1 — Create the bot (BotFather)

1. In Telegram, open **@BotFather** → `/newbot`.
2. Pick a name and a username (must end in `bot`, e.g. `isi_talent_bot`).
3. BotFather replies with a **token** like `123456:ABC-DEF...`. Keep it secret.
4. Note the **username** (without the `@`).

## Step 2 — Run the SQL migration

Supabase Dashboard → **SQL Editor** → paste and run
`docs/v41_telegram_notifications.sql`. It's idempotent (safe to re-run).

## Step 3 — Set Edge Function secrets

Pick two random strings for the shared secrets (any password generator):

```bash
supabase secrets set \
  TELEGRAM_BOT_TOKEN="123456:ABC-DEF...your token..." \
  TELEGRAM_WEBHOOK_SECRET="$(openssl rand -hex 24)" \
  NOTIFY_FN_SECRET="$(openssl rand -hex 24)"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

Write down the `TELEGRAM_WEBHOOK_SECRET` and `NOTIFY_FN_SECRET` values —
you need them in steps 5 and 6.

## Step 4 — Deploy the Edge Functions

```bash
supabase functions deploy telegram-webhook --no-verify-jwt
supabase functions deploy telegram-notify  --no-verify-jwt
```

`--no-verify-jwt` is required: Telegram and the Database Webhook call
these with their own shared-secret headers, not a Supabase user JWT.
Both functions reject any request lacking the correct secret header, so
they are not open endpoints.

## Step 5 — Point Telegram at the webhook

Replace `<PROJECT_REF>` and `<TELEGRAM_WEBHOOK_SECRET>`:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<PROJECT_REF>.functions.supabase.co/telegram-webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Verify: `curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"`
should show your URL and `pending_update_count: 0`.

## Step 6 — Create the Database Webhook

Supabase Dashboard → **Database → Webhooks → Create a new hook**:

- **Table:** `public.notification_queue`
- **Events:** `INSERT`
- **Type:** HTTP Request → `POST`
- **URL:** `https://<PROJECT_REF>.functions.supabase.co/telegram-notify`
- **HTTP Headers:** add
  `x-notify-secret: <NOTIFY_FN_SECRET>` (the value from step 3)

(Equivalently, a `pg_net`/`supabase_functions.http_request` trigger on
`notification_queue` AFTER INSERT calling the same URL with that header.)

## Step 7 — Tell the frontend the bot username

Edit `js/config.js`:

```js
export const TELEGRAM_BOT_USERNAME = 'isi_talent_bot'; // no @, from step 1
```

Commit & deploy the static site. Until this is set, the Notifications
page shows a setup hint instead of the Connect button.

---

## Using it

Each user: open the app → **Notifications** (top nav) → **Connect
Telegram** → press **Start** in Telegram. Done. They can pause
notifications with the in-app toggle or `/stop` in the bot, and
re-check state with `/status`.

## What triggers a notification

| Event | Who gets it |
|---|---|
| Req enters `hrbp_review` / `fh_approval` / `ceo_approval` / `ta_assignment` | users with that role in the tenant |
| Req `revisions_requested` / `rejected` / `on_hold` / `cancelled` | the requester |
| Req `active_sourcing` (approved) / `closed` (filled) | requester + assigned recruiters |
| Candidate stage move / offer / hired / rejected | requester + assigned recruiters |
| Interview scheduled | requester + assigned recruiters |

The person who performed the action is never notified about their own
action. Users with no linked Telegram (or notifications paused) are
silently skipped — the queue row is marked `skipped`, not `failed`.

## Troubleshooting

- **Nothing arrives:** check `notification_queue` — `pending` rows mean
  the Database Webhook isn't firing (re-check step 6 URL/header);
  `failed` rows have the Telegram error in the `error` column;
  `skipped` means the recipient isn't linked or paused.
- **Bot says "link invalid/expired":** tokens last 15 min and are
  single-use — tap **Connect Telegram** again for a fresh one.
- **`/start` does nothing:** re-run step 5; confirm `getWebhookInfo`
  has no `last_error_message`.
- **Function logs:** Supabase Dashboard → Edge Functions → logs.

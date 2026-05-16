# v41 — Telegram notifications: deployed backend contract

> The backend (DB schema, RPCs, Edge Functions, Database Webhook) is
> **already deployed and operational** on Supabase project
> `uwaamlyvvzuhoznlrbhz`. There is **no SQL or Edge Function in this
> repo to run** — an earlier draft shipped a different schema; it was
> removed so nobody deploys a conflicting version by mistake. This file
> records the live contract the frontend (`js/notifications.js`) targets.

Bot: **@ISIGROUP_TA_BOT** · Tenant: `5cd82d77-fe6e-4633-8f87-813b2cc5972c`

## RPCs (callable by the `authenticated` role)

| RPC | Args | Purpose |
|---|---|---|
| `telegram_mint_link_token()` | – | Returns a one-time, 15-min link code. Frontend builds `https://t.me/ISIGROUP_TA_BOT?start=<code>` and also shows `/start <code>` for manual entry. |
| `telegram_unlink()` | – | Clears the caller's Telegram link. |
| `telegram_toggle_notifications(enabled)` | `enabled boolean` | Pause/resume delivery for the caller. |

Backend-internal RPCs (not called by the client): `telegram_get_pending_notifications(batch_size)`, `telegram_mark_notification(id, status, error)`, `telegram_cleanup_old_data()`.

## Tables

`profiles` (read by the client for status):
`telegram_chat_id text`, `telegram_username text`,
`telegram_linked_at timestamptz`, `telegram_notifications_enabled boolean`.

`telegram_link_tokens`: `token, profile_id, tenant_id, created_at, expires_at, used_at` — written only by `telegram_mint_link_token()` / the bot.

`notification_queue` — the client INSERTs one row per recipient:

| column | value the client writes |
|---|---|
| `tenant_id` | `state.currentTenantId` |
| `recipient_profile_id` | `profiles.id` of the recipient (= `tenant_members.user_id`) |
| `event_type` | one of the event types below |
| `event_data` | `jsonb` payload (keys below) |

A Supabase Database Webhook (`telegram-notify-trigger`) fires the
`telegram-notify` Edge Function on INSERT; it renders `event_data` per
`event_type` and stamps `status` (`sent` / `failed` / `skipped`).

## Event types and routing

| `event_type` | Recipients (frontend resolves) |
|---|---|
| `requisition_submitted` | role holders for the new stage: HRBP / Function Head / CEO / Head of TA |
| `requisition_approved` | requester + assigned recruiters |
| `requisition_rejected` | requester |
| `requisition_status_changed` | requester (+ recruiters on close) |
| `candidate_status_changed` | requester + assigned recruiters |
| `interview_scheduled` | requester + assigned recruiters |

The acting user is never notified about their own action (filtered
client-side by their auth UUID). Recipients with no linked Telegram or
notifications paused are marked `skipped` by the Edge Function.

## `event_data` keys sent by the client

Requisition events:
`role_title`, `department_name`, `requester_name`, `req_code`,
`status`, `urgency`, `note`.

Candidate / interview events:
`candidate_name`, `role_title`, `req_code`, `stage`, `status`, `note`.

> Only `requisition_submitted`'s shape was specified in the backend
> handoff (`role_title`, `department_name`, `requester_name`,
> `urgency`). The other payloads use the consistent superset above;
> if the deployed `telegram-notify` expects different keys for a given
> `event_type`, adjust the `eventData` objects in
> `dispatchWorkflowNotification()` — that is the single place to change.

## Verify / test

```sql
-- queue state
select status, count(*) from notification_queue group by status;

-- manual end-to-end (linked user should get a message in ~30s)
insert into notification_queue (tenant_id, recipient_profile_id, event_type, event_data)
values ('5cd82d77-fe6e-4633-8f87-813b2cc5972c', '<LINKED_PROFILE_UUID>',
        'requisition_submitted',
        '{"role_title":"Test Engineer","department_name":"QA","requester_name":"Test","urgency":"High"}'::jsonb);
```

If RPCs 404: `notify pgrst, 'reload schema';` (PostgREST cache).
Edge Function logs: Supabase Dashboard → Edge Functions → logs.

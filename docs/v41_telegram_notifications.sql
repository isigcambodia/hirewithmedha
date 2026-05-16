-- ============================================================
-- v41 — Telegram notifications
-- ============================================================
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor).
-- See docs/v41_telegram_setup.md for the full end-to-end setup
-- (BotFather, Edge Functions, secrets, the Database Webhook).
--
-- WHAT THIS ENABLES
--   Users can link their Telegram account to their profile and then
--   receive a Telegram message whenever a workflow event concerns
--   them: an approval lands in their queue, their requisition changes
--   status, a candidate moves stage, or an interview is scheduled.
--
-- HOW IT FITS TOGETHER
--   * profiles gains telegram_* columns (the linked chat + prefs).
--   * telegram_link_tokens — short-lived one-time codes the bot uses
--     to bind a Telegram chat to a profile (via /start <token>).
--   * notification_queue — an outbox. The app inserts a row per
--     recipient when a workflow event fires; a Supabase Database
--     Webhook on INSERT calls the `telegram-notify` Edge Function
--     which actually delivers the message and stamps the row.
--   * SECURITY DEFINER RPCs let a user mint a link token, unlink, and
--     toggle their preference WITHOUT widening the existing profiles
--     RLS policies (the app only ever touches its own row through
--     these, scoped to auth.uid()).
--
-- SAFE TO RE-RUN: every statement is guarded (IF NOT EXISTS / CREATE
-- OR REPLACE / DROP-then-CREATE by name), so running it twice is a
-- no-op.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. profiles: link target + preference
-- ------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS telegram_chat_id              text,
  ADD COLUMN IF NOT EXISTS telegram_username             text,
  ADD COLUMN IF NOT EXISTS telegram_linked_at            timestamptz,
  ADD COLUMN IF NOT EXISTS telegram_notifications_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.profiles.telegram_chat_id IS
  'Telegram chat id this user receives notifications on. Set by the telegram-webhook Edge Function when the user runs /start <token>. NULL = not linked.';

-- One Telegram chat maps to at most one profile (prevents two accounts
-- silently sharing an inbox). Partial unique index ignores NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_telegram_chat_id_uniq
  ON public.profiles (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2. telegram_link_tokens — one-time, short-lived link codes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telegram_link_tokens (
  token       text        PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  tenant_id   uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE INDEX IF NOT EXISTS telegram_link_tokens_user_idx
  ON public.telegram_link_tokens (user_id);

ALTER TABLE public.telegram_link_tokens ENABLE ROW LEVEL SECURITY;

-- No direct client access is needed: tokens are minted by the
-- create_telegram_link_token() RPC (SECURITY DEFINER) and consumed by
-- the Edge Function (service role, bypasses RLS). RLS stays enabled
-- with no policies = deny-all to the anon/authenticated roles.

-- ------------------------------------------------------------
-- 3. notification_queue — the delivery outbox
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_queue (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL,
  recipient_user_id uuid        NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  event_type        text        NOT NULL,
  title             text        NOT NULL,
  body              text        NOT NULL,
  link_url          text,
  status            text        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','sent','failed','skipped')),
  attempts          int         NOT NULL DEFAULT 0,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz
);

CREATE INDEX IF NOT EXISTS notification_queue_status_idx
  ON public.notification_queue (status, created_at);

GRANT SELECT, INSERT ON public.notification_queue TO authenticated;

ALTER TABLE public.notification_queue ENABLE ROW LEVEL SECURITY;

-- Mirrors the tenant-scoped shape used elsewhere in this DB
-- (see public.applications / interviews policies in v40).
DROP POLICY IF EXISTS notif_select ON public.notification_queue;
CREATE POLICY notif_select ON public.notification_queue
  FOR SELECT
  USING (tenant_id = ANY (public.user_tenant_ids()));

DROP POLICY IF EXISTS notif_insert ON public.notification_queue;
CREATE POLICY notif_insert ON public.notification_queue
  FOR INSERT
  WITH CHECK (tenant_id = ANY (public.user_tenant_ids()));

-- Delivery state transitions (pending -> sent/failed/skipped) are made
-- by the Edge Function with the service role, which bypasses RLS, so
-- no UPDATE/DELETE policy is granted to app users.

COMMIT;

-- ============================================================
-- 4. RPCs — scoped self-service, no profiles RLS changes needed
-- ============================================================

-- Mint a fresh single-use link token for the calling user. Clears any
-- prior unused tokens for that user so only the newest link works.
CREATE OR REPLACE FUNCTION public.create_telegram_link_token()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_tenant uuid;
  v_token  text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT tenant_id INTO v_tenant
  FROM public.tenant_members
  WHERE user_id = v_uid AND status = 'active'
  LIMIT 1;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no active tenant membership';
  END IF;

  DELETE FROM public.telegram_link_tokens
  WHERE user_id = v_uid AND used_at IS NULL;

  -- 64 hex chars from two random UUIDs. gen_random_uuid() is core
  -- Postgres (no pgcrypto needed); hex is within Telegram's /start
  -- payload charset ([A-Za-z0-9_-], max 64 chars) and ~122 bits entropy.
  v_token := replace(gen_random_uuid()::text, '-', '')
          || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.telegram_link_tokens (token, user_id, tenant_id, expires_at)
  VALUES (v_token, v_uid, v_tenant, now() + interval '15 minutes');

  RETURN v_token;
END;
$$;

-- Unlink Telegram for the calling user (their own profile row only).
CREATE OR REPLACE FUNCTION public.unlink_telegram()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  UPDATE public.profiles
  SET telegram_chat_id   = NULL,
      telegram_username  = NULL,
      telegram_linked_at = NULL
  WHERE id = v_uid;
END;
$$;

-- Toggle the calling user's notification preference.
CREATE OR REPLACE FUNCTION public.set_telegram_enabled(p_enabled boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  UPDATE public.profiles
  SET telegram_notifications_enabled = COALESCE(p_enabled, true)
  WHERE id = v_uid;
END;
$$;

REVOKE ALL ON FUNCTION public.create_telegram_link_token()      FROM public;
REVOKE ALL ON FUNCTION public.unlink_telegram()                 FROM public;
REVOKE ALL ON FUNCTION public.set_telegram_enabled(boolean)     FROM public;
GRANT EXECUTE ON FUNCTION public.create_telegram_link_token()   TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlink_telegram()              TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_telegram_enabled(boolean)  TO authenticated;

-- ------------------------------------------------------------
-- VERIFY (optional)
--
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'profiles' AND column_name LIKE 'telegram%';
--
--   SELECT tablename, policyname, cmd FROM pg_policies
--   WHERE schemaname = 'public'
--     AND tablename IN ('notification_queue','telegram_link_tokens');
-- ------------------------------------------------------------

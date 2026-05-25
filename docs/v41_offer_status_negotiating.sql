-- ============================================================
-- v41 — Allow 'negotiating' value in applications.offer_status
-- ============================================================
-- Run this ONCE in the Supabase SQL editor (Dashboard -> SQL Editor).
--
-- SYMPTOM
--   In the candidate pipeline, when a candidate is in the "offer" stage
--   with offer_status='sent', clicking the "Negotiate" button does
--   nothing. No UI update, no toast (or a brief "That value is not
--   allowed by the database" toast that disappears too fast to read).
--   The candidate stays on 'sent' and the recruiter cannot re-open the
--   offer modal to adjust salary/grade/start date.
--
-- ROOT CAUSE
--   The frontend correctly transitions offer_status from 'sent' to
--   'negotiating' (js/views.js offerResponse, js/storage.js
--   saveSingleCandidate). But applications.offer_status carries a CHECK
--   constraint that only allows: draft, sent, accepted, declined,
--   rescinded, expired. The 'negotiating' value is rejected with
--   Postgres code 23514, PostgREST returns 400, the row is never
--   updated, and persistCandidateChange swallows the error into a
--   toast.
--
-- FIX
--   Drop any existing CHECK on offer_status (the constraint name is
--   environment-dependent so we discover it) and recreate it with the
--   full set of values that the UI actually uses, including
--   'negotiating'.
-- ============================================================

BEGIN;

-- 1. Drop every CHECK constraint on applications that references
--    offer_status. We don't assume the constraint name.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class     rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns  ON ns.oid  = rel.relnamespace
    WHERE ns.nspname  = 'public'
      AND rel.relname = 'applications'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%offer_status%'
  LOOP
    EXECUTE format('ALTER TABLE public.applications DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

-- 2. Recreate the CHECK with the full set of values, including
--    'negotiating'. NULL is still allowed (offer_status is null for
--    candidates who have not reached the offer stage yet).
ALTER TABLE public.applications
  ADD CONSTRAINT applications_offer_status_check
  CHECK (
    offer_status IS NULL OR offer_status IN (
      'draft',
      'sent',
      'negotiating',
      'accepted',
      'declined',
      'rescinded',
      'expired'
    )
  );

COMMIT;

-- ------------------------------------------------------------
-- Verify (should return 0 rows of invalid data and the new constraint
-- definition):
--
--   SELECT DISTINCT offer_status
--   FROM   public.applications
--   WHERE  offer_status IS NOT NULL
--     AND  offer_status NOT IN ('draft','sent','negotiating',
--                               'accepted','declined','rescinded','expired');
--
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM   pg_constraint
--   WHERE  conrelid = 'public.applications'::regclass
--     AND  conname  = 'applications_offer_status_check';
-- ------------------------------------------------------------

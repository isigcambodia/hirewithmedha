-- ============================================================
-- v40 — Let the app write interviews / interview_feedback
-- ============================================================
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor),
-- AFTER docs/v39_interview_panel.sql.
--
-- SYMPTOM
--   Saving interview feedback fails. Browser console shows:
--     POST .../rest/v1/interview_feedback?select=id  → 403
--     persistCandidateChange failed
--   The Interview Panel UI works (chips add fine); only the save to
--   Supabase is rejected.
--
-- ROOT CAUSE
--   The app reads `interviews` / `interview_feedback` on load but never
--   wrote them until this release. RLS is enabled on both tables but
--   they have NO policies, so SELECT returns zero rows (looked "empty")
--   and INSERT is rejected with 403.
--
-- FIX
--   Add the SAME policy shape the working `candidates` / `applications`
--   tables already use in this database:
--     • SELECT : tenant_id = ANY (user_tenant_ids())
--     • WRITE  : has_role_in_tenant(tenant_id,
--                  ARRAY['admin','recruiter','hiring_manager'])
--   (mirrors public.applications: app_select / app_write).
--
-- SAFE TO RE-RUN: grants are idempotent; policies are dropped-then-
-- created by name, so this disturbs nothing else. It also drops the
-- earlier generic policy names from the first draft of v40, if present.
-- ============================================================

BEGIN;

-- Table privileges (idempotent; harmless if already granted).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.interviews         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.interview_feedback TO authenticated;

-- RLS is already enabled on these tables; ENABLE is a safe no-op.
ALTER TABLE public.interviews         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interview_feedback ENABLE ROW LEVEL SECURITY;

-- Clean up the generic policies from the first draft of v40 (if the
-- earlier version of this file was ever run).
DROP POLICY IF EXISTS hwm_interviews_tenant_rw         ON public.interviews;
DROP POLICY IF EXISTS hwm_interview_feedback_tenant_rw ON public.interview_feedback;

-- ---- interviews : mirror applications' app_select / app_write ----
DROP POLICY IF EXISTS iv_select ON public.interviews;
CREATE POLICY iv_select ON public.interviews
  FOR SELECT
  USING (tenant_id = ANY (user_tenant_ids()));

DROP POLICY IF EXISTS iv_write ON public.interviews;
CREATE POLICY iv_write ON public.interviews
  FOR ALL
  USING      (has_role_in_tenant(tenant_id, ARRAY['admin'::text, 'recruiter'::text, 'hiring_manager'::text]))
  WITH CHECK (has_role_in_tenant(tenant_id, ARRAY['admin'::text, 'recruiter'::text, 'hiring_manager'::text]));

-- ---- interview_feedback : same shape ----
DROP POLICY IF EXISTS ivf_select ON public.interview_feedback;
CREATE POLICY ivf_select ON public.interview_feedback
  FOR SELECT
  USING (tenant_id = ANY (user_tenant_ids()));

DROP POLICY IF EXISTS ivf_write ON public.interview_feedback;
CREATE POLICY ivf_write ON public.interview_feedback
  FOR ALL
  USING      (has_role_in_tenant(tenant_id, ARRAY['admin'::text, 'recruiter'::text, 'hiring_manager'::text]))
  WITH CHECK (has_role_in_tenant(tenant_id, ARRAY['admin'::text, 'recruiter'::text, 'hiring_manager'::text]));

COMMIT;

-- ------------------------------------------------------------
-- VERIFY (optional) — should now list iv_select/iv_write and
-- ivf_select/ivf_write:
--
--   SELECT tablename, policyname, cmd
--   FROM   pg_policies
--   WHERE  schemaname = 'public'
--     AND  tablename IN ('interviews','interview_feedback');
-- ------------------------------------------------------------

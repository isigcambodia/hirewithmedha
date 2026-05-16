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
--   wrote them until this release. As a result these two tables were
--   never given the write GRANT / row-level-security (RLS) policy that
--   `candidates` and `applications` have, so PostgREST returns 403 on
--   INSERT. (v39 only added a column — it did not touch permissions.)
--
-- FIX
--   1. Grant table privileges to the logged-in (authenticated) role.
--   2. Enable RLS and add a tenant-scoped read/write policy that
--      mirrors how the app already scopes tenant_members
--      (status = 'active') — i.e. a user can only touch rows for a
--      tenant they are an active member of.
--
-- SAFE TO RE-RUN: grants are idempotent; policies are dropped-then-
-- created by name, so this disturbs nothing else.
-- ============================================================

BEGIN;

-- 1. Table privileges. Tables created via raw SQL sometimes never got
--    the grant the dashboard adds automatically; without it PostgREST
--    answers 403 ("permission denied for table ...") regardless of RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.interviews         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.interview_feedback TO authenticated;

-- 2. Enable RLS (no-op if already enabled) so the policies below apply.
ALTER TABLE public.interviews         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interview_feedback ENABLE ROW LEVEL SECURITY;

-- 3. Tenant-scoped read/write. The subquery filters tenant_members to
--    the current user's own active rows, so it works even with RLS on
--    tenant_members (a user can always see their own membership).
DROP POLICY IF EXISTS hwm_interviews_tenant_rw ON public.interviews;
CREATE POLICY hwm_interviews_tenant_rw ON public.interviews
  FOR ALL TO authenticated
  USING (
    tenant_id IN (
      SELECT tm.tenant_id FROM public.tenant_members tm
      WHERE tm.user_id = auth.uid() AND tm.status = 'active'
    )
  )
  WITH CHECK (
    tenant_id IN (
      SELECT tm.tenant_id FROM public.tenant_members tm
      WHERE tm.user_id = auth.uid() AND tm.status = 'active'
    )
  );

DROP POLICY IF EXISTS hwm_interview_feedback_tenant_rw ON public.interview_feedback;
CREATE POLICY hwm_interview_feedback_tenant_rw ON public.interview_feedback
  FOR ALL TO authenticated
  USING (
    tenant_id IN (
      SELECT tm.tenant_id FROM public.tenant_members tm
      WHERE tm.user_id = auth.uid() AND tm.status = 'active'
    )
  )
  WITH CHECK (
    tenant_id IN (
      SELECT tm.tenant_id FROM public.tenant_members tm
      WHERE tm.user_id = auth.uid() AND tm.status = 'active'
    )
  );

COMMIT;

-- ------------------------------------------------------------
-- VERIFY (optional) — after running, this should list both new
-- policies, and the GRANTs should show for the authenticated role:
--
--   SELECT tablename, policyname, cmd
--   FROM   pg_policies
--   WHERE  schemaname = 'public'
--     AND  tablename IN ('interviews','interview_feedback');
--
--   SELECT table_name, privilege_type
--   FROM   information_schema.role_table_grants
--   WHERE  grantee = 'authenticated'
--     AND  table_name IN ('interviews','interview_feedback');
-- ------------------------------------------------------------

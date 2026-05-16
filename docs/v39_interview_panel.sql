-- ============================================================
-- v39 — Interview Panel on interview feedback
-- ============================================================
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor).
--
-- WHAT THIS ENABLES
--   The "Interview feedback" modal now collects an Interview Panel —
--   one or more employees, picked with a type-ahead name search and
--   added with the "+" button — instead of a single interviewer.
--   The panel is stored as an array of employee UUIDs on each
--   interview_feedback row.
--
-- BACKGROUND
--   The app reads `interviews` and `interview_feedback` on load but
--   historically never wrote them, so feedback (and the panel) was
--   lost on reload. The client now persists both. The only schema
--   change required is the new array column added below; the rest of
--   this file is defensive / informational.
--
-- SAFE TO RE-RUN: every statement is guarded (IF NOT EXISTS / catalog
-- checks), so running it twice is a no-op.
-- ============================================================

BEGIN;

-- 1. The interview panel: employee UUIDs (employees.id) for everyone
--    who sat on the panel for this feedback entry. Default empty array
--    so existing rows and inserts that omit it stay valid.
ALTER TABLE public.interview_feedback
  ADD COLUMN IF NOT EXISTS panel_member_ids uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.interview_feedback.panel_member_ids IS
  'Interview panel: array of employees.id UUIDs captured in the Interview feedback modal (v39).';

-- 2. GIN index so "feedback where employee X was on the panel"
--    queries stay fast as the table grows. Cheap; remove if unwanted.
CREATE INDEX IF NOT EXISTS interview_feedback_panel_member_ids_gin
  ON public.interview_feedback USING GIN (panel_member_ids);

COMMIT;

-- ------------------------------------------------------------
-- 3. OPTIONAL — Row Level Security checklist.
--
--    The client writes `interviews` and `interview_feedback` for the
--    first time with this release. If saving feedback fails with a
--    "blocked by database policy" / row-level-security error, the
--    authenticated app role needs INSERT (and SELECT) on these two
--    tables, scoped to the user's tenant — the same shape the
--    `candidates` / `applications` policies already use.
--
--    Inspect existing policies first:
--
--      SELECT tablename, policyname, cmd, qual, with_check
--      FROM   pg_policies
--      WHERE  schemaname = 'public'
--        AND  tablename IN ('interviews', 'interview_feedback');
--
--    Then, ONLY IF the equivalent policies are missing, adapt the
--    template below to match how `candidates` is scoped in this DB
--    (helper function / column name may differ) and run it:
--
--    -- ALTER TABLE public.interviews          ENABLE ROW LEVEL SECURITY;
--    -- ALTER TABLE public.interview_feedback  ENABLE ROW LEVEL SECURITY;
--    --
--    -- CREATE POLICY interviews_tenant_rw ON public.interviews
--    --   FOR ALL TO authenticated
--    --   USING      (tenant_id = ANY (public.user_tenant_ids()))
--    --   WITH CHECK  (tenant_id = ANY (public.user_tenant_ids()));
--    --
--    -- CREATE POLICY interview_feedback_tenant_rw ON public.interview_feedback
--    --   FOR ALL TO authenticated
--    --   USING      (tenant_id = ANY (public.user_tenant_ids()))
--    --   WITH CHECK  (tenant_id = ANY (public.user_tenant_ids()));
--
--    (Replace public.user_tenant_ids() with whatever the existing
--    candidates/applications policies use in this project.)
-- ------------------------------------------------------------

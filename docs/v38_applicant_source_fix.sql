-- ============================================================
-- v38 — Make candidates.source data-driven
-- ============================================================
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor).
--
-- SYMPTOM
--   Adding an applicant fails (HTTP 400 on POST /rest/v1/candidates,
--   "persistCandidateChange failed" in the console) whenever the chosen
--   Source is one of the newer options — e.g. "Walk-in", "Employee
--   Referral", "Job Fair", "Campus Recruitment", "Facebook", "Telegram".
--   The original 7 sources (LinkedIn, Job Board, Agency, Career Site,
--   Referral, Direct, Other) still work.
--
-- ROOT CAUSE
--   The Source dropdown is now populated from the applicant_sources
--   table (13+ codes). But candidates.source still carries a legacy
--   CHECK constraint / ENUM that only allows the original 7 codes.
--   Any new code violates it, Postgres raises 23514 / 22P02, PostgREST
--   returns 400, the candidate row is never written, so it never shows
--   up in any pipeline.
--
-- FIX
--   Demote the column to plain text, drop the rigid CHECK, normalise
--   legacy values, and (optionally) re-validate against applicant_sources
--   so it stays data-driven going forward.
-- ============================================================

BEGIN;

-- 1. If candidates.source is a Postgres ENUM, demote it to text so that
--    adding a new source never again requires a schema change.
DO $$
DECLARE
  v_udt text;
BEGIN
  SELECT c.udt_name
    INTO v_udt
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name   = 'candidates'
    AND c.column_name  = 'source';

  IF v_udt IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_type t
                 WHERE t.typname = v_udt AND t.typtype = 'e') THEN
    EXECUTE 'ALTER TABLE public.candidates ALTER COLUMN source DROP DEFAULT';
    EXECUTE 'ALTER TABLE public.candidates ALTER COLUMN source TYPE text USING source::text';
    EXECUTE 'ALTER TABLE public.candidates ALTER COLUMN source SET DEFAULT ''other''';
  END IF;
END $$;

-- 2. Drop every CHECK constraint on candidates that references `source`.
--    The constraint name is environment-dependent, so discover it.
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
      AND rel.relname = 'candidates'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%source%'
  LOOP
    EXECUTE format('ALTER TABLE public.candidates DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

-- 3. Normalise legacy / free-text values so they match applicant_sources.code
--    (lower-case, collapse spaces & hyphens into underscores).
UPDATE public.candidates
SET    source = lower(regexp_replace(btrim(source), '[ -]+', '_', 'g'))
WHERE  source IS NOT NULL
  AND  source <> lower(regexp_replace(btrim(source), '[ -]+', '_', 'g'));

UPDATE public.candidates
SET    source = 'other'
WHERE  source IS NULL OR btrim(source) = '';

COMMIT;

-- ------------------------------------------------------------
-- 4. OPTIONAL — keep the column validated, but data-driven.
--    After this, allowing a new source only needs an applicant_sources
--    row (no schema change ever again).
--
--    Pre-reqs: applicant_sources.code is UNIQUE / PRIMARY KEY, and every
--    existing candidates.source value already exists in applicant_sources.
--    Verify with:
--
--      SELECT DISTINCT c.source
--      FROM   public.candidates c
--      LEFT   JOIN public.applicant_sources s ON s.code = c.source
--      WHERE  s.code IS NULL;   -- must return 0 rows
--
--    Then uncomment and run:
--
-- ALTER TABLE public.candidates
--   ADD CONSTRAINT candidates_source_fk
--   FOREIGN KEY (source) REFERENCES public.applicant_sources (code)
--   NOT VALID;
-- ALTER TABLE public.candidates VALIDATE CONSTRAINT candidates_source_fk;
-- ------------------------------------------------------------

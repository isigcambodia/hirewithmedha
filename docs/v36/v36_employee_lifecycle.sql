-- =============================================================================
-- v36: BU scoping + Employee lifecycle  (PATCHED v3 — reality-aligned)
-- =============================================================================
-- Reconciled against the actual existing schema as verified by Claude Code's
-- codebase reading and Chandy's Supabase queries.
--
-- VERIFIED (do not re-question):
--   * Roles live on `tenant_members.role` (text), filtered by status='active'
--   * Existing role list in CHECK constraint:
--       admin, requester, hrbp, function_head, ceo, head_ta,
--       recruiter, hiring_manager, viewer
--     `group_ceo` must be added (run separately before Section 8b — see end)
--   * `business_units` ALREADY EXISTS with columns:
--       id, tenant_id, name, code, sort_order, is_active, deleted_at
--     Soft-delete pattern uses is_active=true + deleted_at IS NULL
--   * `employees` ALREADY HAS `status` (text, free-form) — current values use
--     capital-A 'Active'. Do NOT re-add the column. Do NOT introduce
--     lowercase 'active'/'inactive' or every existing row violates the new
--     check constraint.
--   * `viewer` role is unused (zero active members) — safe-default BU-scoped
--   * `hiring_manager` role: BU-scoped (Chandy confirmed)
--   * `ceo` role: kept as-is, BU-scoped (used by future BU CEOs)
--   * `group_ceo`: new role for Kang Leng, group-scoped
--
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Extend existing business_units with ceo_user_id
-- ---------------------------------------------------------------------------
-- Table already exists; just add the new column for approval routing.

ALTER TABLE business_units
  ADD COLUMN IF NOT EXISTS ceo_user_id uuid REFERENCES auth.users(id);

COMMENT ON COLUMN business_units.ceo_user_id IS
  'Operational CEO for this BU (approval routing). Distinct from user roles — Kang Leng (group_ceo) holds this for ISI Steel today; future BU CEOs will hold the ceo role.';

-- Ensure ISI Steel exists as a BU. Use NOT EXISTS guard rather than ON CONFLICT
-- because we don't know for certain that (tenant_id, code) is uniquely indexed.
INSERT INTO business_units (tenant_id, code, name, is_active, sort_order)
SELECT '5cd82d77-fe6e-4633-8f87-813b2cc5972c'::uuid, 'STEEL', 'ISI Steel', true, 1
 WHERE NOT EXISTS (
   SELECT 1 FROM business_units
    WHERE tenant_id = '5cd82d77-fe6e-4633-8f87-813b2cc5972c'::uuid
      AND code = 'STEEL'
 );

-- ---------------------------------------------------------------------------
-- 2. user_business_units (BU access grants for BU-scoped users)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_business_units (
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_unit_id  uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  granted_at        timestamptz DEFAULT now(),
  granted_by        uuid REFERENCES auth.users(id),
  PRIMARY KEY (user_id, business_unit_id)
);

COMMENT ON TABLE user_business_units IS
  'BU access grants for BU-scoped users (hrbp, function_head, ceo, requester, hiring_manager). Multiple rows per user are allowed — e.g. an HRBP covering two BUs. Group-scoped roles (admin, head_ta, recruiter, group_ceo) bypass this table entirely via user_business_unit_ids().';

CREATE INDEX IF NOT EXISTS user_business_units_user_idx ON user_business_units (user_id);

-- ---------------------------------------------------------------------------
-- 3. user_business_unit_ids() — the access helper for RLS
-- ---------------------------------------------------------------------------
-- Reads roles from tenant_members.role (verified).
-- Reads BU activity from is_active + deleted_at (matches existing pattern).
-- Defaults unrecognized roles to BU-scoped (fail-closed for hiring_manager,
-- viewer, and any future role that hasn't been classified).

CREATE OR REPLACE FUNCTION user_business_unit_ids()
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  uid       uuid := auth.uid();
  user_role text;
  bu_ids    uuid[];
BEGIN
  IF uid IS NULL THEN
    RETURN ARRAY[]::uuid[];
  END IF;

  -- Locked product rule: one user = one role.
  SELECT role INTO user_role
    FROM tenant_members
   WHERE user_id = uid
     AND status = 'active'
   LIMIT 1;

  IF user_role IN ('admin', 'head_ta', 'recruiter', 'group_ceo') THEN
    -- Group-scoped: every active, non-deleted BU in their tenants.
    SELECT array_agg(id) INTO bu_ids
      FROM business_units
     WHERE is_active = true
       AND deleted_at IS NULL
       AND tenant_id = ANY(user_tenant_ids());
  ELSE
    -- BU-scoped (hrbp, function_head, ceo, requester, hiring_manager, viewer):
    -- read from explicit grants.
    SELECT array_agg(business_unit_id) INTO bu_ids
      FROM user_business_units
     WHERE user_id = uid;
  END IF;

  RETURN COALESCE(bu_ids, ARRAY[]::uuid[]);
END;
$$;

COMMENT ON FUNCTION user_business_unit_ids() IS
  'Returns BU ids visible to the current user. Use in RLS: business_unit_id = ANY(user_business_unit_ids()).';

-- ---------------------------------------------------------------------------
-- 4. Add ONLY the new lifecycle columns to employees
-- ---------------------------------------------------------------------------
-- The employees table already has: id, employee_code, name_en, name_kh,
-- position_title, grade, function_id, department_id, company_email, user_id,
-- company, is_function_head, is_ceo, tenant_id, status.
-- We add ONLY what's new (BU + lifecycle audit columns).

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS business_unit_id uuid REFERENCES business_units(id),
  ADD COLUMN IF NOT EXISTS joined_at        date,
  ADD COLUMN IF NOT EXISTS inactive_at      date,
  ADD COLUMN IF NOT EXISTS inactive_reason  text,
  ADD COLUMN IF NOT EXISTS inactive_notes   text,
  ADD COLUMN IF NOT EXISTS deactivated_by   uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS deactivated_at   timestamptz;

-- Backfill BU: every existing employee currently belongs to ISI Steel.
UPDATE employees
   SET business_unit_id = (
     SELECT id FROM business_units
      WHERE code = 'STEEL' AND tenant_id = employees.tenant_id
      LIMIT 1
   )
 WHERE business_unit_id IS NULL;

ALTER TABLE employees ALTER COLUMN business_unit_id SET NOT NULL;

-- Status check — keeps existing 'Active'/'Inactive' capitalization convention.
-- ('Active' is what the codebase already writes and reads — see js/storage.js)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_status_check') THEN
    ALTER TABLE employees ADD CONSTRAINT employees_status_check
      CHECK (status IN ('Active', 'Inactive'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_inactive_reason_check') THEN
    ALTER TABLE employees ADD CONSTRAINT employees_inactive_reason_check CHECK (
      inactive_reason IS NULL OR
      inactive_reason IN ('resignation','termination','end_of_contract','transfer','retirement','other')
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_inactive_at_required') THEN
    ALTER TABLE employees ADD CONSTRAINT employees_inactive_at_required CHECK (
      status = 'Active' OR inactive_at IS NOT NULL
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS employees_status_idx     ON employees (status);
CREATE INDEX IF NOT EXISTS employees_bu_idx         ON employees (business_unit_id);
CREATE INDEX IF NOT EXISTS employees_bu_active_idx  ON employees (business_unit_id) WHERE status = 'Active';

-- ---------------------------------------------------------------------------
-- 5. Apply BU scoping to requisitions and applications
-- ---------------------------------------------------------------------------
ALTER TABLE requisitions
  ADD COLUMN IF NOT EXISTS business_unit_id uuid REFERENCES business_units(id);

UPDATE requisitions
   SET business_unit_id = (
     SELECT id FROM business_units
      WHERE code = 'STEEL' AND tenant_id = requisitions.tenant_id
      LIMIT 1
   )
 WHERE business_unit_id IS NULL;

ALTER TABLE requisitions ALTER COLUMN business_unit_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS requisitions_bu_idx ON requisitions (business_unit_id);

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS business_unit_id uuid REFERENCES business_units(id);

UPDATE applications a
   SET business_unit_id = r.business_unit_id
  FROM requisitions r
 WHERE a.requisition_id = r.id
   AND a.business_unit_id IS NULL;

ALTER TABLE applications ALTER COLUMN business_unit_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS applications_bu_idx ON applications (business_unit_id);

-- ---------------------------------------------------------------------------
-- 6. RLS — instructions (run separately, after reviewing existing policies)
-- ---------------------------------------------------------------------------
-- Existing policies on employees / requisitions / applications need a single
-- additional clause:  AND business_unit_id = ANY(user_business_unit_ids())
--
-- Example pattern for employees SELECT:
--
--   DROP POLICY IF EXISTS employees_select ON employees;
--   CREATE POLICY employees_select ON employees FOR SELECT
--     USING (
--       tenant_id            = ANY(user_tenant_ids())
--       AND business_unit_id = ANY(user_business_unit_ids())
--     );

-- ---------------------------------------------------------------------------
-- 7. Convenience view (matches existing 'Active' convention)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW employees_active AS
  SELECT * FROM employees WHERE status = 'Active';

COMMENT ON VIEW employees_active IS
  'Convenience view: active employees only. Use in approver/recruiter/requester dropdowns. RLS still applies, so each user only sees their accessible BUs.';

COMMIT;

-- ---------------------------------------------------------------------------
-- Run BEFORE Section 8b: extend tenant_members.role check to allow group_ceo
-- ---------------------------------------------------------------------------
-- ALTER TABLE tenant_members DROP CONSTRAINT tenant_members_role_check;
-- ALTER TABLE tenant_members ADD CONSTRAINT tenant_members_role_check
--   CHECK (role = ANY (ARRAY[
--     'admin'::text, 'requester'::text, 'hrbp'::text, 'function_head'::text,
--     'ceo'::text, 'group_ceo'::text, 'head_ta'::text, 'recruiter'::text,
--     'hiring_manager'::text, 'viewer'::text
--   ]));

-- ---------------------------------------------------------------------------
-- Section 8a: wire Kang Leng as ISI Steel's operational CEO
-- ---------------------------------------------------------------------------
-- UPDATE business_units
--    SET ceo_user_id = (SELECT id FROM auth.users WHERE email = 'kangleng@isigroup.com')
--  WHERE code = 'STEEL';

-- ---------------------------------------------------------------------------
-- Section 8b: promote Kang Leng to group_ceo
-- ---------------------------------------------------------------------------
-- UPDATE tenant_members
--    SET role = 'group_ceo'
--  WHERE user_id = (SELECT id FROM auth.users WHERE email = 'kangleng@isigroup.com')
--    AND status = 'active';

-- =============================================================================
-- Verification queries (run after migration commits):
-- =============================================================================
-- SELECT code, name, ceo_user_id IS NOT NULL AS ceo_set
--   FROM business_units WHERE deleted_at IS NULL;
--
-- SELECT bu.code,
--        count(*) FILTER (WHERE e.status = 'Active')   AS active,
--        count(*) FILTER (WHERE e.status = 'Inactive') AS inactive
--   FROM employees e
--   JOIN business_units bu ON bu.id = e.business_unit_id
--  GROUP BY bu.code;

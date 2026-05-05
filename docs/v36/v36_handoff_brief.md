# v36 Integration — Handoff Brief for Claude Code

> **For:** Claude Code, working on the `Hire with Medhā` / `ISI Group Talent` repo.
> **From:** Design conversation between Chandy and Claude (chat session, May 5 2026).
> **Read alongside:** `v36_employee_lifecycle.sql` and `employee_admin_sketch.html`.

---

## TL;DR

Two things happened in the design conversation that need to land in the repo:

1. **Migration v36** (SQL file) — establishes Business Unit (BU) scoping as the primary access boundary across the platform, and adds soft-deactivation lifecycle to `employees`. **Run this first.** It's a structural change that affects `employees`, `requisitions`, and `applications`.
2. **Employee admin UI** (HTML sketch) — a new "Employees" module inside the platform, behaving differently depending on whether the viewer is BU-scoped (HRBP) or group-scoped (Head of TA, admin, group_ceo). The HTML is a design reference, not code to copy verbatim — integrate it into the existing `prototype.html` patterns.

Suggested platform version after both land: **v37** (the migration is v36, the UI integration that follows is v37+).

---

## Verify Before Writing Code

The chat session produced design artifacts without direct access to the repo or live Supabase schema. Before integration, please verify each of these against ground truth — if any disagree, the repo wins and the brief should be adjusted, not the code.

**Schema verification (Supabase project `uwaamlyvvzuhoznlrbhz`):**
- Confirm `employees`, `requisitions`, `applications` tables exist with the assumed shape. Migration uses `tenant_id`, `requisition_id` foreign-key columns — verify these names match.
- Confirm the role-resolution table. The migration assumes `profiles.role`. If roles actually live somewhere else (e.g. `app_users.role`, `auth.users.raw_user_meta_data->>'role'`, or a `user_roles` join table), update the SELECT inside `user_business_unit_ids()` accordingly. **This is the single most important thing to verify** — get it wrong and BU scoping silently fails open.
- Confirm `user_tenant_ids()` helper exists. The new `user_business_unit_ids()` follows the same shape and depends on it.
- Confirm Kang Leng's auth user record (the migration looks up by email `kangleng@isigroup.com` — adjust if different).

**Codebase verification (`prototype.html` and shipped variants):**
- Read the existing nav structure to find where to add the "Employees" entry.
- Read the existing role-gating pattern to apply it to the new nav entry.
- Read the existing dropdown queries that pick approvers, recruiters, and requesters — these need to be switched to use the new `employees_active` view AND filter by `user_business_unit_ids()`. List the call sites; this is wide-reaching.
- Read the existing application status change handler — the auto-create-from-Hire behavior hooks in there.
- Read the EN/KM translation bundle structure (memory note: ~53 keys were added in v29; follow that pattern).

---

## Architectural Decisions Made (Don't Re-Litigate)

These are settled. Summary with rationale so Claude Code understands the why and doesn't drift.

**Business Unit as primary access scope.** Tim is HRBP for ISI Steel; she sees only Steel — employees, requisitions, applications, dashboard metrics, everything. Future BUs (e.g. ISI Energy) will have their own HRBPs with the same scoping. This means BU scoping threads through the *whole* platform, not just the Employees screen.

**Roles split into two access camps:**

- **Group-scoped** (see all active BUs): `admin`, `head_ta` (Socheata), `recruiter` (the whole pool — Chanlida, Chanpiyuth, Kimsros, Kanhaly, Vanna, Ravy, Lina), `group_ceo` (Kang Leng).
- **BU-scoped** (see only their assigned BU(s)): `hrbp`, `function_head`, `ceo` (per-BU CEO, not yet populated), `requester`.

**Kang Leng special case** — he's both the operational CEO of ISI Steel and the group chairman. The "one user = one role" rule is locked product policy, so we picked `group_ceo` for his role (which gives group-wide visibility). His operational CEO position on Steel requisitions is tracked separately as `business_units.ceo_user_id` — that column is what approval routing reads from. When ISI Energy launches with its own CEO, that person gets the `ceo` role (BU-scoped) and is set as Energy's `ceo_user_id`. **Do not** introduce a multi-role mechanism for Kang Leng.

**HRBPs can cover multiple BUs.** This is already happening in the org. That's why `user_business_units` is a join table, not a single column on a user record. Don't simplify it.

**Recruiters are pooled, not BU-locked.** They get the group-scoped role specifically so any recruiter can be assigned to any BU's requisition. Don't try to add per-BU recruiter assignments — that contradicts the operating model.

**Soft-delete for leavers, never hard-delete.** Historical referential integrity matters: who approved past requisitions, who recruited whom. The `status = 'inactive'` flag plus `inactive_at` / `inactive_reason` audit columns is the pattern. Filter by `status = 'active'` in active-use dropdowns; show full history in archive views.

**One employee = one BU.** Even though users can be in multiple BUs (HRBPs), employees themselves belong to exactly one BU. If someone transfers between BUs, that's modeled as deactivation in the old BU + new employee record in the new BU (with `inactive_reason = 'transfer'`).

---

## What to Integrate (the v37 Build)

**1. New nav entry: "Employees / បុគ្គលិក"**

Visible to: `admin`, `head_ta`, `hrbp`, `group_ceo`. Hidden from `function_head`, `recruiter`, `requester`, `ceo` (BU CEOs don't manage the employee list — that's an HR function).

**2. List view**

Three tabs: All / Active / Inactive (with live counts). Search by name. The table columns and behavior depend on the viewer's role:

- **BU-scoped users (HRBP):** No BU column shown (it would be redundant — everything's in their BU). The scope context indicator at the top of the page shows which BU they're viewing ("Showing employees in **ISI Steel** only").
- **Group-scoped users (head_ta, admin, group_ceo):** BU column shown with color-coded tags. A BU filter dropdown appears alongside the tabs. Default = "All BUs".

Inactive rows are visually muted and show "left [date]" plus the reason in place of the joined date.

The auto-create info banner at the top of the page is shown to everyone and explains: when an application moves to "Hired", the candidate becomes an employee record automatically, assigned to the BU of the requisition.

**3. Add Employee modal**

Fields: Name (EN), Name (KM, optional), Email (optional — required only if they need to log in), Function, Role, Reports to, Joined date.

The BU field behaves differently based on the viewer:

- **BU-scoped user covering one BU:** Field is rendered as a locked display ("ISI Steel — scoped to your BU") and submits that BU automatically.
- **BU-scoped user covering multiple BUs (multi-BU HRBP):** Field is a dropdown limited to the user's assigned BUs.
- **Group-scoped user:** Field is a dropdown of all active BUs.

**4. Deactivate Employee modal**

Fields: Reason (enum: resignation / termination / end_of_contract / transfer / retirement / other), Last working day, Notes (optional).

Includes a **reassignment block** that queries open items belonging to the employee being deactivated and prompts for a new owner before allowing the deactivation to commit. The query needs to count and list:

- Open applications where they are the assigned recruiter
- Draft or in-progress requisitions where they are the requester
- Pending approvals where they are the approver

Each open-item type gets a dropdown of valid replacements (filtered to active employees in the right scope and role). The deactivation transaction commits the status change *and* the reassignments atomically — if reassignment fails, the deactivation rolls back.

**5. Auto-create on application "Hired" status change**

Hook into the existing application status update handler. When status moves to `Hired`, INSERT a row into `employees` with `business_unit_id` pulled from the parent requisition, `joined_at` defaulting to today (editable), name/email pulled from the application. Show a small confirmation banner with the auto-created record and an "Edit" link.

**6. Update all existing dropdowns**

Every dropdown that currently selects approvers, recruiters, requesters, function heads, or any other employee reference needs two changes:

- Switch from `SELECT * FROM employees` to `SELECT * FROM employees_active` (skip leavers automatically)
- Add `WHERE business_unit_id = ANY(user_business_unit_ids())` so users only see employees in BUs they have access to

This is the wide-reaching change. List the call sites first before editing.

---

## Patterns to Follow

These are the established conventions in this codebase. Match them.

The **snapshot-at-submit** pattern from JD Library v22-v35 is the right model anywhere data needs to be preserved against future changes — for the employee deactivation flow, snapshot the employee's name and role into the audit fields on the requisitions/applications they touched, so historical views don't go blank when someone is later renamed or reassigned.

The **RLS pattern** uses `foldername()[2]::uuid = ANY(user_tenant_ids())` for storage policies; for table policies, follow the equivalent `tenant_id = ANY(user_tenant_ids())` pattern, and now extend it with `AND business_unit_id = ANY(user_business_unit_ids())`. The migration includes example syntax in section 6 — these RLS updates are deliberately kept out of the migration because they require reading the existing policy text first.

**EN + KM bilingual coverage** is mandatory across all new UI. Every visible string needs both English and Khmer translations added to the bundle, following the v29 pattern. Use Noto Sans Khmer for body text and Noto Serif Khmer where serif is appropriate. A starter set of KM translations is in the sketch — Page title `បុគ្គលិក`, Add modal `បន្ថែមបុគ្គលិក`, Deactivate modal `បិទដំណើរការ` — but the full integration will need many more (Reason enum values, Status badges, BU names, field labels, button labels, scope context strings, etc.).

**Wording conventions** from TA team feedback: use "Applicant" not "Candidate" or "CV". Use "Active" / "Inactive" not "Enabled" / "Disabled". Use "Reassign" not "Transfer" (transfer is a deactivation reason).

**Brand:** navy `#00338d` and orange `#ff650e`. Fraunces serif for display, Inter Tight for body, JetBrains Mono for numbers and IDs. Warm paper tones (`#faf6f0`, `#f1ebe0`, `#ebe3d3`). The sketch HTML uses these — match them in the integration.

**File locations:** source lives in `/home/claude/prototype.html`, shipped builds go to `/mnt/user-data/outputs/hire_with_medha_wired.html`. Versioned increments — increment to v37 for the integration, v38+ for follow-ups.

---

## Assumptions That Need Action

These are flagged 🚩 in the migration and need to be resolved before or during integration:

The **role-resolution table** assumption (`profiles.role`) inside `user_business_unit_ids()`. Verify against actual schema before running the migration. If wrong, the helper function silently returns wrong results and BU scoping breaks.

**Kang Leng's email** (`kangleng@isigroup.com`) used in the seed UPDATE for `business_units.ceo_user_id` and the role assignment. Adjust to the actual email on his auth.users record.

The **`profiles` UPDATE for setting Kang Leng's role to `group_ceo`** is commented out in the migration — uncomment and run after confirming the table shape.

---

## Out of Scope for v37 (Park These)

Be disciplined about scope. These are tempting but should be separate work:

**RLS policy updates** are intentionally not in the migration. They require reading the existing policy text per table, which Claude Code can do but should treat as a separate, focused task after v36 lands. The migration includes the pattern in comments; apply it as a follow-up.

**CEO delegation** (Socheata sometimes approves on behalf of CEO) — this is a flagged governance decision in the project memory, not yet built and not part of v36/v37. Don't pre-emptively model it.

**CV auto-fill enhancement via LLM** — dormant code from v30-v31, hidden in v32. Stays dormant until separately scoped.

**Bulk Excel upload format** for adding many employees at once — the sketch has a "Bulk upload" button as a placeholder. Wire it as inert (showing "coming soon") until the column format is specified.

**Other BUs beyond ISI Steel** — the model supports it (just `INSERT INTO business_units`), but no other BU should be seeded as part of v37. ISI Steel is the only live BU today.

**Auth access revocation** when an employee is deactivated — separate concern. Deactivating an employee record should *not* automatically revoke their Supabase auth access; that's a separate admin action that may or may not apply (most employees aren't system users at all). For employees who *are* system users, surface a separate prompt — don't bundle it.

---

## Suggested Sequencing

A reasonable order of operations once verification is complete:

1. Verify all assumptions above against actual codebase and Supabase.
2. Run `v36_employee_lifecycle.sql` against the dev branch. Run the verification queries at the bottom of the file.
3. Update RLS policies on `employees`, `requisitions`, `applications` (separate task; pattern in section 6 of the migration).
4. Add the "Employees" nav entry, role-gated.
5. Build the list view with persona-aware behavior (BU column hidden vs shown, scope context, BU filter dropdown).
6. Build the Add Employee modal with persona-aware BU field.
7. Build the Deactivate Employee modal with reassignment of open items.
8. Wire the auto-create-from-Hire flow into the application status change handler.
9. Update every existing dropdown to use `employees_active` + filter by `user_business_unit_ids()`.
10. Add complete EN/KM translation keys for all new UI strings.
11. Manual test as Tim (BU-scoped, single BU), as a hypothetical multi-BU HRBP, as Socheata (group-scoped), and as Kang Leng (group_ceo).
12. Ship as v37.

---

## Open Questions Worth Confirming with Chandy

A few items the chat session didn't fully settle:

- **Function naming consistency across BUs** — when ISI Energy launches, does it have its own "Operations" function (BU-specific) or does "Operations" mean the same thing across the group? This affects whether `functions` should also be BU-scoped or remain global. Current sketch assumes global.
- **What happens when the only HRBP for a BU is deactivated?** The reassignment flow handles open items, but who becomes the BU's HRBP afterwards? Probably needs admin intervention — flag this case in the deactivation modal if detected.
- **Reactivation flow** — the sketch shows a "Reactivate" button on inactive rows. Is reactivation a simple status flip back to `active`, or does it need a new joined date and a fresh employee record? Treat as simple status flip for v37; revisit if HR feedback changes that.

---

*End of brief. The sketch and migration are alongside this file. Read all three before starting integration.*

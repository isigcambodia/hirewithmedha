# Hire with Medhā — "Hired" Pipeline Stage Specification

**For: Claude Code (frontend implementation)**
**Migration: v36 (already applied to DB)**
**Date: 2026-05-16**

---

## 1. What's being built

A 6th column "Hired" at the end of the candidate kanban pipeline. When a
recruiter marks an offer as accepted, the system:

1. Moves the accepted candidate to `candidate_stage = 'hired'`
2. Auto-closes the parent requisition
3. Auto-rejects other candidates in the pipeline
4. Records who filled the req for analytics

This is an evolution, not a redesign. The 5 existing stages
(sourcing → screening → interview → preemployment → offer) stay exactly as
they are. The new "Hired" column displays candidates who've been hired.

---

## 2. Data contract (already in place after v36 migration)

### 2.1 Tables and columns relevant to this feature

**`public.applications`** (per-candidate stage tracking):

| Column                  | Type        | Notes                                                                                    |
|-------------------------|-------------|------------------------------------------------------------------------------------------|
| `id`                    | uuid        | PK                                                                                       |
| `requisition_id`        | uuid        | FK → requisitions                                                                        |
| `candidate_id`          | uuid        | FK → candidates                                                                          |
| `candidate_stage`       | text        | CHECK in (`'sourcing'`,`'screening'`,`'interview'`,`'preemployment'`,`'offer'`,`'hired'`,`'rejected'`,`'withdrawn'`) |
| `stage_changed_at`      | timestamptz | Updated on every stage transition                                                        |
| `status`                | text        | Top-level application status (e.g. `'active'`, `'rejected'`)                             |
| `offer_status`          | text        | CHECK in (`'draft'`,`'sent'`,`'accepted'`,`'declined'`,`'rescinded'`,`'expired'`)         |
| `offer_salary`          | numeric     |                                                                                          |
| `offer_grade`           | text        |                                                                                          |
| `offer_start_date`      | date        |                                                                                          |
| `offer_sent_at`         | timestamptz |                                                                                          |

**`public.requisitions`** (the req closing side):

| Column                       | Type        | Notes                                                                                     |
|------------------------------|-------------|-------------------------------------------------------------------------------------------|
| `id`                         | uuid        | PK                                                                                        |
| `workflow_status`            | text        | CHECK includes `'closed'`                                                                  |
| `closed_at`                  | timestamptz | **HISTORICAL DATA: 585 rows have this as NULL** — see §5                                  |
| `closed_reason`              | text        | **NEW in v36.** CHECK in (`'filled'`,`'cancelled'`,`'rejected'`,`'withdrawn'`)              |
| `filled_by_application_id`   | uuid        | **NEW in v36.** FK → applications.id (the hired application)                                |
| `cancel_reason`              | text        | Existed pre-v36. Free text. May have data on some historical closes — unverified at writing time |
| `requester_id`               | uuid        | FK → profiles                                                                              |
| `tenant_id`                  | uuid        | Multi-tenant scope                                                                        |

### 2.2 What v36 added

```sql
alter table public.requisitions
  add column closed_reason text
  check (closed_reason in ('filled','cancelled','rejected','withdrawn'));

alter table public.requisitions
  add column filled_by_application_id uuid
  references public.applications(id) on delete set null;

create index req_closed_reason_idx
  on public.requisitions(tenant_id, closed_reason)
  where closed_reason is not null;
```

### 2.3 What the v36 migration deliberately did NOT do

- **No backfill of historical data.** All 585 pre-existing closed reqs have
  `closed_reason = NULL` and `filled_by_application_id = NULL`. This is by
  design — we don't trust the import to be uniform enough to mass-classify.
- **No `applications.candidate_stage` schema change.** The value `'hired'`
  was already allowed in this column since the v2 patch.

---

## 3. The trigger behavior

When a recruiter changes `applications.offer_status` from `'sent'` to
`'accepted'`, the frontend must perform these 4 operations, ideally in a
transaction or sequentially with rollback discipline:

### 3.1 Step 1 — Move the accepted application to "hired"

```sql
update public.applications
set candidate_stage  = 'hired',
    stage_changed_at = now()
where id = :accepted_application_id
  and candidate_stage = 'offer';  -- guard: only move if currently at offer
```

### 3.2 Step 2 — Close the parent requisition

```sql
update public.requisitions
set workflow_status            = 'closed',
    closed_at                  = now(),
    closed_reason              = 'filled',
    filled_by_application_id   = :accepted_application_id
where id = :req_id
  and workflow_status not in ('closed','cancelled','rejected');
```

The `NOT IN` guard handles the unlikely race where two recruiters accept
two offers simultaneously — only the first succeeds in closing the req,
the second's UPDATE affects zero rows (the frontend should detect this and
warn).

### 3.3 Step 3 — Auto-reject other active candidates

```sql
update public.applications
set candidate_stage  = 'rejected',
    status           = 'rejected',
    stage_changed_at = now()
where requisition_id   = :req_id
  and id              != :accepted_application_id
  and candidate_stage not in ('hired','rejected','withdrawn');
```

This sweeps everyone still in any active stage (sourcing, screening,
interview, preemployment, offer) into rejected. Both `candidate_stage` and
top-level `status` are updated so the candidate disappears from the kanban
AND is filterable in audit views.

### 3.4 Step 4 — Activity log entry

Add an entry to the `activities` table (or whatever the audit log is called
post-refactor):

> "Requisition filled by *Candidate Name*. *N* other candidate(s) auto-rejected."

Include `actor_id = currentAuthUser.id`, `req_id`, and `created_at = now()`.

---

## 4. Render-side behavior

### 4.1 Kanban pipeline (6 columns now)

```
[Sourcing] → [Screening] → [Interview] → [Pre-employment] → [Offer] → [Hired]
```

The "Hired" column displays applications where `candidate_stage = 'hired'`
within the current requisition's scope. After auto-close, the req's detail
page should remain accessible (read-only feel is appropriate — no new
candidates added, no further stage changes).

### 4.2 What NOT to show in the kanban

Applications with `status = 'rejected'` should NOT appear in any pipeline
column. They live in an out-of-flow state. If you want a separate "Rejected"
view (a tab, a filter, etc.), that's a future feature — out of scope for v36.

### 4.3 Width considerations

The current 5-column kanban already requires horizontal scrolling on
typical desktop widths. Adding a 6th column will worsen this. Options:
- Accept the scroll (simplest)
- Make columns narrower
- Collapse "Hired" by default with an expand toggle (uncommon for kanban)

Recommendation: accept the scroll. The Hired column is the end-state and
users won't need to interact with it as often.

---

## 5. Historical data asymmetry — IMPORTANT

The system has **585 historical closed requisitions** that predate this
migration. They have specific shape characteristics that all queries must
handle gracefully:

| Field                       | Historical value          | New-data value          |
|-----------------------------|---------------------------|-------------------------|
| `closed_at`                 | NULL                      | `now()` on close        |
| `closed_reason`             | NULL                      | `'filled'` on hire      |
| `filled_by_application_id`  | NULL                      | FK to hired application |
| `applications.candidate_stage = 'hired'` count | 583 of 585 | exactly 1 |

### 5.1 Implications for queries

**Wrong:** "Sort closed reqs by close date" using `order by closed_at desc`
→ 585 historical rows will sort last because they're all NULL.

**Better:** `order by coalesce(closed_at, created_at) desc nulls last`

**Wrong:** "Show me which candidate filled this req" using only
`filled_by_application_id`
→ 583 historical reqs have a hired candidate but no `filled_by_application_id`.

**Better:**
```sql
select coalesce(
  (select c.* from candidates c
   join applications a on a.candidate_id = c.id
   where a.id = r.filled_by_application_id),
  (select c.* from candidates c
   join applications a on a.candidate_id = c.id
   where a.requisition_id = r.id and a.candidate_stage = 'hired'
   limit 1)
) as hired_candidate
from requisitions r
where r.id = :req_id;
```

I.e. prefer `filled_by_application_id` when set; fall back to the
`candidate_stage = 'hired'` join for historical reqs.

**Analytics — "fill rate":** Only meaningful for new-data going forward.
For historical data, fill-rate-by-`closed_reason` doesn't work because all
585 closed_reason values are NULL. The historical fill rate is effectively
"all 585 closed reqs filled" (or 583 if you trust `candidate_stage='hired'`
as the signal).

### 5.2 The 2 known outliers

Two closed reqs created on 2026-05-04 do NOT have any hired candidate
linked. Both are "Operator, Crane" job titles. They look like duplicate
submissions that were closed without proper disposition.

These will remain NULL in the new fields and will not match either query
pattern above. The frontend should handle "closed req with no hired
candidate" gracefully (don't crash, just show "no hire recorded").

### 5.3 Going forward

After v36, the data semantics of `closed_reason IS NULL` change:

- **Before today:** "this is historical imported data"
- **After today:** "either historical data OR an unusual close path that
  didn't go through the offer-acceptance trigger" (e.g. manual close,
  cancellation without setting cancel_reason)

If anyone runs analytics 6 months from now, they need to know this
inflection point. Worth a note in the engineering log.

---

## 6. Edge cases to handle

| Scenario | Expected behavior |
|----------|-------------------|
| Recruiter accepts offer, network fails mid-transaction | Step 1 succeeds, Step 2 fails — application has `candidate_stage='hired'` but req is still active. Frontend should detect and retry, OR provide a manual "close req" button to recover. |
| Recruiter accepts offer for a req that's already closed (race) | Step 2's `NOT IN` guard returns 0 rows. Show user "this req was already closed by another action" toast. |
| Candidate `offer_status` reverts from `'accepted'` to `'declined'` (rare but possible) | The system should NOT automatically un-hire. The "hired" state is one-way. Recruiter would need to manually reopen the req if appropriate. |
| Recruiter tries to add a candidate to a closed req | Block at the UI. The req is closed; no new candidates. |
| Historical closed req (NULL closed_reason) opened in the UI | Display normally. Show whatever hired candidate exists via the `candidate_stage='hired'` join. Don't crash on the NULL columns. |
| Auto-reject sweep finds no other candidates | Fine — UPDATE affects 0 rows. The activity log entry should say "0 other candidates auto-rejected" or omit that detail. |

---

## 7. Out of scope for v36

These are intentional non-goals — flag if asked but don't build:

- **Un-hiring / reopening a closed req.** One-way transition.
- **"Rejected candidates" view.** No new UI for the auto-rejected pile.
- **Backfill of historical `closed_reason`.** Decision was made to leave
  585 rows with NULL rather than risk misclassification.
- **Email/notification triggers on hire.** Email infrastructure is parked
  for a separate session.
- **"Hires & Onboarding" page changes.** That page already reads from
  `requisitions where workflow_status='closed'` — it should continue to
  work without modification. If new fields are useful to that page,
  that's a follow-up enhancement.
- **CEO delegation / approval-on-behalf flows.** Unrelated to this stage.

---

## 8. Acceptance tests (manual)

Before declaring v36 done, verify all of these in a real browser:

1. **Happy path:** Create a req, push it through all approvals, add a
   candidate, advance through all 5 stages, mark offer as 'accepted'.
   - ✅ Candidate moves to Hired column
   - ✅ Req status becomes 'closed' with closed_reason='filled'
   - ✅ filled_by_application_id is set
   - ✅ Activity log shows the close entry

2. **Auto-reject path:** Same as above, but with 2 candidates in the
   pipeline (one in interview, one in offer). Mark the offer candidate as
   accepted.
   - ✅ Accepted candidate moves to Hired
   - ✅ The interview-stage candidate is auto-rejected (status='rejected',
        candidate_stage='rejected')
   - ✅ Kanban no longer shows the rejected candidate

3. **Historical data renders cleanly:** Open one of the 585 historical
   closed reqs in the requester or admin view.
   - ✅ Page renders without errors
   - ✅ Hired candidate is visible (via the fallback join)
   - ✅ NULL closed_at and closed_reason don't crash the UI

4. **Race condition:** (Optional, hard to reproduce manually) Two
   browser windows, both at the offer-acceptance step. Click accept in
   both quickly.
   - ✅ Only one succeeds; the other shows a "this req is already closed"
        message rather than silently failing.

---

## 9. Definition of done

- The kanban renders a 6th "Hired" column for all open and closed reqs
- Accepting an offer correctly performs all 4 trigger steps
- Auto-rejection of other candidates works
- "Hires & Onboarding" page continues to function (unchanged)
- All 4 acceptance tests pass
- Historical data still renders without errors
- No linter or test errors introduced

---

## 10. Questions Claude Code may want to ask back

If during implementation any of these come up, they're legitimate
clarifications to surface back to Chandy:

- **Should the auto-rejection sweep include candidates already in
  `candidate_stage = 'preemployment'`?** (Spec says yes — they're in the
  pipeline, they get swept. But it's worth confirming with the team.)
- **Should the activity log entry name each auto-rejected candidate
  individually, or just give a count?** (Spec says count for brevity.)
- **What text should the toast say when a recruiter tries to accept an
  offer on an already-closed req?** (Spec doesn't define exact wording.)
- **Should the "Hired" kanban card show the offer amount and start date,
  or stay minimal like the other cards?** (Spec doesn't specify.)

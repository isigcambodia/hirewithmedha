# V37 Interview Sub-Steps — Implementation Spec

**Author:** Chandy (Medhā Consulting)  
**Date:** May 16, 2026  
**Migration:** `v37_interview_substeps.sql`  
**Target:** Claude Code implementation  

---

## 1. Feature Overview

Add visible progress tracking within the **Interview** stage using generic sub-steps: **Step 1 → Step 2 → Final**.

**Business driver:** Interview stage often spans 2-3 separate interview rounds. Current system shows only "Interview: 15d in stage" with no visibility into which interview round is complete. This creates opacity for recruiters and requesters.

**Solution:** Generic, flexible sub-steps that work across all roles/grades without rigid configuration.

---

## 2. Database Schema

The migration adds 4 columns to `applications`:

```sql
interview_step          TEXT        -- 'step_1', 'step_2', 'final', or NULL
interview_step_1_at     TIMESTAMPTZ -- When Step 1 was completed
interview_step_2_at     TIMESTAMPTZ -- When Step 2 was completed
interview_final_at      TIMESTAMPTZ -- When Final was completed
```

**Constraint:** `interview_step IN ('step_1', 'step_2', 'final')` or NULL

---

## 3. UI/UX Requirements

### 3.1 Candidate Card Display (Recruiter View)

**When candidate is in Interview stage:**

Show current interview step as a badge below the candidate name:

```
┌─────────────────────────┐
│ Yin Channa              │
│ Referral - 15d in stage │
│ Interview: Step 1       │  ← NEW: Interview step badge
│                         │
│ [→ Step 2] [Feedback]   │  ← NEW: Step advancement button
│           [×]           │
└─────────────────────────┘
```

**Step badge styling:**
- Step 1: neutral/gray badge
- Step 2: neutral/gray badge  
- Final: accent color badge (e.g., blue/teal) to indicate last step

**Step advancement buttons:**
- **On Step 1:** Show `[→ Step 2]` and `[→ Final]` buttons
- **On Step 2:** Show `[→ Final]` and `[← Step 1]` buttons
- **On Final:** Show `[→ Pre-emp]` and `[← Step 2]` buttons

Buttons should be small, inline, labeled clearly.

### 3.2 Stage Transition Enforcement

**Moving TO Interview stage:**
- Auto-set `interview_step = 'step_1'`
- Set `interview_step_1_at = NOW()`
- Show "Interview: Step 1" immediately

**Moving FROM Interview to Pre-Employment:**
- Only allow if `interview_step = 'final'`
- If not on Final step, show error toast: "Complete Final Interview before moving to Pre-Employment"
- Disable "Pre-emp" button if not on Final (visual cue)

**Moving FROM Interview to other stages (Screening, Sourcing):**
- Clear all interview step data: `interview_step = NULL`, all timestamps = NULL
- Ensures fresh start if candidate returns to Interview later

### 3.3 Step Transitions (Within Interview Stage)

**Forward progression:**
- Step 1 → Step 2: Update `interview_step = 'step_2'`, `interview_step_2_at = NOW()`
- Step 2 → Final: Update `interview_step = 'final'`, `interview_final_at = NOW()`
- Step 1 → Final (skip Step 2): Update `interview_step = 'final'`, `interview_final_at = NOW()` (leave `step_2_at` as NULL)

**Backward movement (with confirmation):**
- Final → Step 2: Show confirmation modal FIRST
- Step 2 → Step 1: Show confirmation modal FIRST

**Confirmation modal content:**
```
┌─────────────────────────────────────────┐
│  Move candidate back to [Step]?         │
│                                          │
│  This will clear their [Current Step]   │
│  completion. This action can be undone  │
│  by advancing them forward again.       │
│                                          │
│  Optional: Reason for moving back       │
│  [text input field]                     │
│                                          │
│      [Cancel]    [Move Back]            │
└─────────────────────────────────────────┘
```

**Modal behavior:**
- "Cancel" button (default, neutral color) — dismiss modal, no changes
- "Move Back" button (destructive red) — confirm regression
- Optional reason field — saved to activity log metadata if provided
- Pressing ESC or clicking outside dismisses modal (same as Cancel)

**After confirmation:**
- Final → Step 2: Update `interview_step = 'step_2'`, `interview_final_at = NULL`
- Step 2 → Step 1: Update `interview_step = 'step_1'`, `interview_step_2_at = NULL`

**Button visibility logic:**
```javascript
// Pseudo-code for button display
if (interview_step === 'step_1') {
  showButtons: ['→ Step 2', '→ Final', 'Feedback', 'Reject']
}
else if (interview_step === 'step_2') {
  showButtons: ['← Step 1', '→ Final', 'Feedback', 'Reject']
}
else if (interview_step === 'final') {
  showButtons: ['← Step 2', '→ Pre-emp', 'Feedback', 'Reject']
  enablePreEmpButton: true
}
```

### 3.4 Other Stages (Non-Interview)

**No changes to candidate cards in:**
- Sourcing
- Screening  
- Pre-Employment
- Offer
- Hired

Interview sub-steps only appear when `candidate_stage = 'interview'`.

---

## 4. State Transition Rules

### 4.1 Entry to Interview Stage

```
FROM any stage → TO Interview
  SET interview_step = 'step_1'
  SET interview_step_1_at = NOW()
  CREATE activity: "Moved to Interview - Step 1"
```

### 4.2 Within Interview Stage

```
Step 1 → Step 2:
  SET interview_step = 'step_2'
  SET interview_step_2_at = NOW()
  CREATE activity: "Advanced to Interview Step 2"

Step 2 → Final:
  SET interview_step = 'final'
  SET interview_final_at = NOW()
  CREATE activity: "Completed Final Interview"

Step 1 → Final (skip):
  SET interview_step = 'final'
  SET interview_final_at = NOW()
  CREATE activity: "Completed Final Interview (skipped Step 2)"

Final → Step 2 (backwards):
  SHOW confirmation modal first (UI layer)
  After user confirms:
    SET interview_step = 'step_2'
    SET interview_final_at = NULL
    CREATE activity: "Socheata moved candidate back to Interview Step 2"
    INCLUDE reason in metadata if provided in modal

Step 2 → Step 1 (backwards):
  SHOW confirmation modal first (UI layer)
  After user confirms:
    SET interview_step = 'step_1'
    SET interview_step_2_at = NULL
    CREATE activity: "Socheata moved candidate back to Interview Step 1"
    INCLUDE reason in metadata if provided in modal
```

### 4.3 Exit from Interview Stage

```
FROM Interview → TO Pre-Employment:
  VALIDATE interview_step = 'final'
  IF NOT final, BLOCK with error message
  IF final, allow move (keep interview step data for history)

FROM Interview → TO other stages (Screening, Sourcing, Rejected):
  CLEAR interview step data:
    SET interview_step = NULL
    SET interview_step_1_at = NULL
    SET interview_step_2_at = NULL
    SET interview_final_at = NULL
  CREATE activity: "Moved to [stage]"
```

---

## 5. Validation Logic

### 5.1 Pre-Employment Gate

```javascript
function canMoveToPreEmployment(application) {
  if (application.candidate_stage !== 'interview') {
    return { allowed: false, reason: "Candidate must be in Interview stage" };
  }
  if (application.interview_step !== 'final') {
    return { 
      allowed: false, 
      reason: "Complete Final Interview before moving to Pre-Employment" 
    };
  }
  return { allowed: true };
}
```

**UI enforcement:**
- Disable "Pre-emp" button when not on Final step
- Show tooltip on disabled button: "Complete Final Interview first"
- Show error toast if user somehow triggers the action

### 5.2 Step Transition Validation

```javascript
function canAdvanceStep(currentStep, targetStep) {
  const validTransitions = {
    'step_1': ['step_2', 'final'],
    'step_2': ['step_1', 'final'],
    'final': ['step_2']
  };
  return validTransitions[currentStep]?.includes(targetStep) ?? false;
}
```

---

## 6. Activity Logging

Log all interview step changes to `activities` table. **Include WHO performed the action** (user_id and user_name).

**Step advancement:**
```javascript
{
  type: 'interview_step_advanced',
  description_en: 'Socheata advanced candidate to Interview Step 2',
  description_km: '[Khmer translation]',
  metadata: {
    previous_step: 'step_1',
    new_step: 'step_2',
    performed_by_user_id: '...',
    performed_by_user_name: 'Socheata',
    timestamp: '2026-05-16T10:30:00Z'
  }
}
```

**Step regression (backwards):**
```javascript
{
  type: 'interview_step_regressed',
  description_en: 'Socheata moved candidate back to Interview Step 1',
  description_km: '[Khmer translation]',
  metadata: {
    previous_step: 'step_2',
    new_step: 'step_1',
    performed_by_user_id: '...',
    performed_by_user_name: 'Socheata',
    reason: 'Additional screening required'  // From confirmation modal (optional)
  }
}
```

**Final interview completion:**
```javascript
{
  type: 'interview_step_completed',
  description_en: 'Chanlida marked Final Interview as complete',
  description_km: '[Khmer translation]',
  metadata: {
    step: 'final',
    skipped_steps: ['step_2'],  // If Step 2 was skipped
    performed_by_user_id: '...',
    performed_by_user_name: 'Chanlida',
    timestamp: '2026-05-16T14:45:00Z'
  }
}
```

---

## 7. Translation Keys (EN + KM)

Add to existing translation system:

```javascript
{
  // Step badges
  "interview.step_1": { en: "Step 1", km: "ជំហានទី ១" },
  "interview.step_2": { en: "Step 2", km: "ជំហានទី ២" },
  "interview.final": { en: "Final", km: "ចុងក្រោយ" },
  
  // Step advancement buttons
  "interview.advance_to_step_2": { en: "→ Step 2", km: "→ ជំហានទី ២" },
  "interview.advance_to_final": { en: "→ Final", km: "→ ចុងក្រោយ" },
  "interview.back_to_step_1": { en: "← Step 1", km: "← ជំហានទី ១" },
  "interview.back_to_step_2": { en: "← Step 2", km: "← ជំហានទី ២" },
  
  // Validation messages
  "interview.error_not_final": { 
    en: "Complete Final Interview before moving to Pre-Employment",
    km: "[Khmer: Complete Final Interview before moving to Pre-Employment]"
  },
  "interview.tooltip_complete_final": {
    en: "Complete Final Interview first",
    km: "[Khmer: Complete Final Interview first]"
  },
  
  // Confirmation modal (backwards movement)
  "interview.confirm_move_back_title": {
    en: "Move candidate back to {step}?",
    km: "[Khmer: Move candidate back to {step}?]"
  },
  "interview.confirm_move_back_body": {
    en: "This will clear their {currentStep} completion. This action can be undone by advancing them forward again.",
    km: "[Khmer: This will clear their {currentStep} completion. This action can be undone by advancing them forward again.]"
  },
  "interview.confirm_move_back_reason_label": {
    en: "Optional: Reason for moving back",
    km: "[Khmer: Optional: Reason for moving back]"
  },
  "interview.confirm_move_back_cancel": {
    en: "Cancel",
    km: "បោះបង់"
  },
  "interview.confirm_move_back_confirm": {
    en: "Move Back",
    km: "[Khmer: Move Back]"
  }
}
```

---

## 8. Edge Cases & Special Scenarios

### 8.1 Candidate Returns to Interview

**Scenario:** Candidate in Interview → moved to Screening for re-assessment → moved back to Interview

**Behavior:** 
- When moving OUT of Interview (to Screening): Clear all interview step data
- When returning TO Interview: Start fresh at Step 1 with new timestamp
- Rationale: New interview cycle = fresh tracking

### 8.2 Bulk Operations

**Scenario:** Recruiter selects multiple candidates and wants to advance them all to Step 2

**Current implementation:** Hire with Medhā doesn't support bulk stage moves yet

**Future consideration:** If bulk moves are added later, ensure:
- Only candidates currently in Interview can be bulk-advanced
- All candidates in selection must be at the same step
- Validation applies to entire batch

### 8.3 Historical Data

**Scenario:** Candidate hired before v37 deployment

**Behavior:**
- Applications hired before v37: `interview_step = NULL`, all timestamps = NULL
- No retroactive step assignment
- Analytics queries should handle NULL gracefully (e.g., "Unknown interview progression")

### 8.4 Direct SQL Updates

**Scenario:** Admin manually updates interview step via Supabase dashboard

**Safeguard:**
- Database constraint ensures only valid values: 'step_1', 'step_2', 'final', or NULL
- Recommend: Add trigger to auto-update timestamps if interview_step changes (optional, not critical for v37)

---

## 9. Analytics Opportunities (Future)

The timestamps enable powerful analytics:

```sql
-- Average time spent in each interview step
SELECT 
  AVG(interview_step_2_at - interview_step_1_at) as avg_step1_duration,
  AVG(interview_final_at - interview_step_2_at) as avg_step2_duration,
  AVG(interview_final_at - interview_step_1_at) as avg_total_interview_duration
FROM applications
WHERE interview_final_at IS NOT NULL;

-- Interview completion rate by step
SELECT 
  COUNT(CASE WHEN interview_step_1_at IS NOT NULL THEN 1 END) as reached_step1,
  COUNT(CASE WHEN interview_step_2_at IS NOT NULL THEN 1 END) as reached_step2,
  COUNT(CASE WHEN interview_final_at IS NOT NULL THEN 1 END) as reached_final
FROM applications
WHERE candidate_stage = 'interview' OR candidate_stage IN ('pre_employment', 'offer', 'hired');

-- Bottleneck identification
-- (Which step has longest average duration? Where do candidates get stuck?)
```

These analytics can inform process improvements but are NOT required for v37 implementation.

---

## 10. Acceptance Tests

### Test 1: Auto-start at Step 1
1. Move candidate from Screening → Interview
2. **Expected:** Candidate card shows "Interview: Step 1" badge immediately
3. **Expected:** `interview_step = 'step_1'`, `interview_step_1_at` is set

### Test 2: Step advancement (forward)
1. Candidate in Interview - Step 1
2. Click "→ Step 2" button
3. **Expected:** Badge updates to "Interview: Step 2"
4. **Expected:** `interview_step = 'step_2'`, `interview_step_2_at` is set
5. **Expected:** Activity logged: "Advanced to Interview Step 2"

### Test 3: Skip to Final
1. Candidate in Interview - Step 1
2. Click "→ Final" button
3. **Expected:** Badge updates to "Interview: Final"
4. **Expected:** `interview_step = 'final'`, `interview_final_at` is set, `interview_step_2_at` is NULL
5. **Expected:** Activity logged: "Completed Final Interview (skipped Step 2)"

### Test 4: Backwards movement (with confirmation)
1. Candidate in Interview - Final
2. Click "← Step 2" button
3. **Expected:** Confirmation modal appears with title "Move candidate back to Step 2?"
4. **Expected:** Modal has optional reason field and "Cancel" / "Move Back" buttons
5. Enter reason: "Need additional technical assessment"
6. Click "Move Back"
7. **Expected:** Modal closes, badge updates to "Interview: Step 2"
8. **Expected:** `interview_step = 'step_2'`, `interview_final_at = NULL`
9. **Expected:** Activity logged: "Socheata moved candidate back to Interview Step 2" with reason in metadata

### Test 4b: Backwards movement cancellation
1. Candidate in Interview - Final
2. Click "← Step 2" button
3. **Expected:** Confirmation modal appears
4. Click "Cancel" (or press ESC)
5. **Expected:** Modal closes, candidate stays in Interview - Final
6. **Expected:** No database changes, no activity logged

### Test 5: Pre-Employment gate (blocking)
1. Candidate in Interview - Step 2 (NOT Final)
2. Try to move to Pre-Employment
3. **Expected:** Error toast: "Complete Final Interview before moving to Pre-Employment"
4. **Expected:** Candidate stays in Interview - Step 2

### Test 6: Pre-Employment gate (allowed)
1. Candidate in Interview - Final
2. Click "→ Pre-emp" button
3. **Expected:** Candidate moves to Pre-Employment stage
4. **Expected:** Interview step data preserved (for historical record)

### Test 7: Exit Interview to other stage (reset)
1. Candidate in Interview - Step 2
2. Move to Screening (backwards move)
3. **Expected:** `interview_step = NULL`, all timestamps = NULL
4. Move back to Interview
5. **Expected:** Auto-starts at Step 1 again (fresh cycle)

### Test 8: Button visibility
1. Candidate in Step 1: Show "→ Step 2", "→ Final" (no back button)
2. Candidate in Step 2: Show "← Step 1", "→ Final"
3. Candidate in Final: Show "← Step 2", "→ Pre-emp"
4. Pre-emp button disabled when NOT on Final

### Test 9: Bilingual display
1. Switch language to Khmer
2. **Expected:** Step badges show "ជំហានទី ១", "ជំហានទី ២", "ចុងក្រោយ"
3. **Expected:** Buttons show Khmer labels
4. **Expected:** Error messages in Khmer

### Test 10: Existing Interview candidates (migration)
1. After applying v37 migration, check existing Interview-stage candidates
2. **Expected:** All set to Step 1 with `interview_step_1_at` timestamp
3. **Expected:** Display correctly in UI

---

## 11. Implementation Checklist

**Backend (SQL):**
- [ ] Apply `v37_interview_substeps.sql` migration to Supabase

**Frontend (Code):**
- [ ] Add step badge display to candidate cards (Interview stage only)
- [ ] Add step advancement/regression buttons with correct visibility logic
- [ ] Implement step transition handlers (update DB + timestamps)
- [ ] Add Pre-Employment gate validation (check interview_step = 'final')
- [ ] Implement auto-start Step 1 on entry to Interview
- [ ] Implement reset (clear step data) on exit to non-Pre-Emp stages
- [ ] Add activity logging for all step transitions
- [ ] Add translation keys for EN + KM
- [ ] Add error toasts and disabled button tooltips
- [ ] Test all 10 acceptance scenarios

**Optional enhancements (defer to v38+):**
- [ ] Interview step filter on recruiter dashboard ("Show only Final Interview candidates")
- [ ] Analytics dashboard showing step conversion rates
- [ ] Bulk step advancement for multiple candidates
- [ ] Configurable step labels per role (instead of generic Step 1/2/Final)

---

## 12. Open Questions for Chandy

*(Resolved on May 16, 2026)*

**Q1:** Should activity logs include WHO performed the step transition?
- **Answer:** ✅ YES — Include user in activity logs (e.g., "Socheata advanced candidate to Interview Step 2")
- **Implementation:** Add `user_id` or `user_name` to activity metadata

**Q2:** Should there be a confirmation modal when moving backwards (Final → Step 2)?
- **Answer:** ✅ CONFIRMATION FIRST — Show modal before allowing regression
- **Implementation:** Modal text: "Move candidate back to [Step]? This will clear their Final Interview completion."
- **Buttons:** "Cancel" (default) / "Move Back" (destructive red)

**Q3:** When candidate is moved to Pre-Employment, should we preserve the interview step data forever?
- **Answer:** ✅ KEEP FOREVER — Preserve for analytics purposes (future feature)
- **Implementation:** Do NOT clear interview step data when moving to Pre-Employment, Offer, Hired, or Rejected

**Q4:** Should the step badge show "days in current step" or "days in Interview stage" overall?
- **Answer:** ✅ OVERALL DURATION — Show total days in Interview stage (e.g., "Interview - 15d")
- **Implementation:** Use existing "days in stage" calculation, not per-step duration
- **Future enhancement (v38+):** Add per-step duration if analytics show value

**Q5:** If a candidate is rejected while in Interview - Step 2, should we preserve the step data?
- **Answer:** ✅ YES — Keep for funnel analysis
- **Implementation:** Do NOT clear interview step data on rejection; preserve for analytics (helps understand drop-off points)

---

## 13. References

- **Migration file:** `v37_interview_substeps.sql`
- **Related features:** v36 Hired stage (6th kanban column)
- **Database table:** `applications` (schema in Supabase)
- **Translation system:** Existing EN/KM bilingual setup
- **Activity logging:** Existing `activities` table pattern

---

**End of Spec**

*Last updated: May 16, 2026*  
*All open questions resolved — Ready for Claude Code implementation*  
*Decisions confirmed: User tracking in activities, confirmation modals for regression, preserve step data for analytics*

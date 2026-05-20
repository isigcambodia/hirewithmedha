# v42 — Lookup Tables Integration Spec

## Summary
Replace hardcoded Function, Department, Section, Role, and Grade dropdowns with backend-driven data from five new Supabase lookup tables. The Role dropdown should display **only the job title name** (e.g., "Engineer, Electrical & Automation") — not the composite format with function and grade suffix. The Grade dropdown should display the grade number (e.g., "4") and is an independent field, not cascaded from any other dropdown.

## Database Tables (already created by v42 migration)

| Table | Rows | Parent FK | Purpose |
|---|---|---|---|
| `lookup_functions` | 6 | — | Top-level org unit |
| `lookup_departments` | 34 | `function_id → lookup_functions` | Department within function |
| `lookup_sections` | 104 | `department_id → lookup_departments` | Section within department |
| `lookup_job_titles` | 186 | — (flat list) | Job title / role name |
| `lookup_grades` | 13 | — (flat list) | Grade level (1–9, 11, 12, 14, 15) |

All tables are tenant-scoped (`tenant_id`) and have `is_active` (boolean) and `sort_order` (int) columns.

## Querying

Use `sb` (not `supabase`) — the Supabase client is imported as `sb` from `config.js`.

### Load functions
```js
const { data } = await sb
  .from('lookup_functions')
  .select('id, name')
  .eq('tenant_id', tenantId)
  .eq('is_active', true)
  .order('sort_order');
```

### Load departments (filtered by selected function)
```js
const { data } = await sb
  .from('lookup_departments')
  .select('id, name')
  .eq('function_id', selectedFunctionId)
  .eq('is_active', true)
  .order('sort_order');
```

### Load sections (filtered by selected department)
```js
const { data } = await sb
  .from('lookup_sections')
  .select('id, name')
  .eq('department_id', selectedDepartmentId)
  .eq('is_active', true)
  .order('sort_order');
```

### Load job titles (flat, no cascade)
```js
const { data } = await sb
  .from('lookup_job_titles')
  .select('id, name')
  .eq('tenant_id', tenantId)
  .eq('is_active', true)
  .order('name');  // alphabetical is more useful for 186 titles
```

### Load grades (flat, no cascade)
```js
const { data } = await sb
  .from('lookup_grades')
  .select('id, name')
  .eq('tenant_id', tenantId)
  .eq('is_active', true)
  .order('sort_order');  // numeric order: 1, 2, 3, ..., 9, 11, 12, 14, 15
```

## Frontend Behavior

### Cascade logic (same as current, now data-driven)
1. **Function** dropdown loads on form mount
2. **Department** dropdown reloads when Function changes; clears Department + Section selection
3. **Section** dropdown reloads when Department changes; clears Section selection. Section remains **optional** — some departments have no sections
4. **Role / Job Title** dropdown loads independently on form mount — it is NOT cascaded from Function/Department/Section

### Role dropdown change
- **Current behavior**: displays composite format like "Engineer, Electrical & Automation — Supply Chain 3" (title + function + grade)
- **New behavior**: display only the `name` field from `lookup_job_titles`, e.g. "Engineer, Electrical & Automation"
- Remove any code that assembles the composite role string from multiple tables

### What the requisitions table stores
The `requisitions` table continues to store **text values** in its existing columns (`function`, `department`, `section`, `job_title` / `role`). No FK columns are added to `requisitions`. When saving:
```js
{
  function: selectedFunctionName,      // "Supply Chain" (text)
  department: selectedDepartmentName,  // "Engineering" (text)
  section: selectedSectionName,        // "Electrical & Automation" (text, nullable)
  job_title: selectedJobTitleName,     // "Engineer, Electrical & Automation" (text)
  grade: selectedGradeName             // "4" (text)
}
```
This means older requisitions with slightly different names (e.g., "Engineering & Equipment" vs "Engineering") are unaffected — they keep their original text.

### Search / filter considerations
Anywhere the UI filters requisitions by function/department (e.g., kanban view, reports), the filter dropdowns should also be populated from the lookup tables. But the matching still happens on text values in `requisitions`, so the filter should use `.eq('function', selectedName)` etc.

## Edge Cases

1. **Department with no sections**: Section dropdown should show placeholder "No sections" or be hidden/disabled. Do NOT force section selection.
2. **Empty search on job titles**: With 186 titles, consider making the Role dropdown searchable (type-ahead filter). If the current UI already has this, keep it.
3. **Stale data**: If a function/department/section/title is deactivated (`is_active = false`), it should not appear in dropdowns for new requisitions, but existing requisitions referencing the old text are unaffected.

## Files likely affected
- `js/views.js` — requisition form rendering (Organization section, Role section)
- `js/storage.js` — if dropdown data was previously hardcoded there
- Any module that builds the composite role string for display

## NOT in scope
- Admin UI to manage lookup tables (add/edit/deactivate entries) — future feature
- Migrating existing requisition text columns to FK references — not needed
- Khmer translations for lookup values — not in the employee master data; can be added later as a `name_km` column

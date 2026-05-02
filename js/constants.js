// ============================================================
// CONSTANTS — pure data, no app-state dependencies
// ============================================================
// ORG_STRUCTURE is intentionally `let`-style mutable in spirit: the bootstrap
// code at startup wipes its keys and rebuilds from the DB. Mutating properties
// on a const-bound object works fine here because consumers all read live.

export const ORG_STRUCTURE = {
  'Sales': { 'Regional Sales': ['Cambodia North', 'Cambodia South', 'Phnom Penh'], 'Key Accounts': ['Enterprise', 'Government'] },
  'Engineering': { 'Software': ['Backend', 'Frontend', 'DevOps'], 'Hardware': ['Design', 'Testing'] },
  'Operations': { 'Production': ['Plant A', 'Plant B'], 'Logistics': ['Warehouse', 'Distribution'] },
  'Finance': { 'Accounting': ['AR', 'AP', 'General Ledger'], 'FP&A': ['Budgeting', 'Analysis'] },
  'HR': { 'Talent Acquisition': ['Recruitment', 'Employer Branding'], 'HR Operations': ['Payroll', 'Benefits'] }
};

export const EXISTING_ROLES = [
  { id: 'R001', title: 'Senior Sales Manager', function: 'Sales', grade: 'G8' },
  { id: 'R002', title: 'Sales Executive', function: 'Sales', grade: 'G5' },
  { id: 'R003', title: 'Software Engineer', function: 'Engineering', grade: 'G6' },
  { id: 'R004', title: 'DevOps Engineer', function: 'Engineering', grade: 'G7' },
  { id: 'R005', title: 'Operations Manager', function: 'Operations', grade: 'G7' },
  { id: 'R006', title: 'Accountant', function: 'Finance', grade: 'G5' },
  { id: 'R007', title: 'Finance Manager', function: 'Finance', grade: 'G8' },
  { id: 'R008', title: 'HR Specialist', function: 'HR', grade: 'G5' }
];

// ROLES defines the role categories used for dashboards and the admin
// role-switcher. Labels are fallbacks; the UI uses translated ROLES_LABELS at
// render time. All user identity now flows from real Supabase Auth UUIDs
// (state.realUsersByUuid) — there are no demo/hardcoded users anymore.
export const ROLES = {
  requester:     { label: 'Requester' },
  hrbp:          { label: 'HRBP' },
  function_head: { label: 'Function Head' },
  ceo:           { label: 'CEO' },
  head_ta:       { label: 'Head of TA' },
  recruiter:     { label: 'Recruiter' }
};

// Resources required for new hires — order preserved for display
export const RESOURCE_TYPES = [
  { key: 'email',   tKey: 'res_email' },
  { key: 'laptop',  tKey: 'res_laptop' },
  { key: 'desktop', tKey: 'res_desktop' },
  { key: 'tablet',  tKey: 'res_tablet' },
  { key: 'phone',   tKey: 'res_phone' },
  { key: 'car',     tKey: 'res_car' },
  { key: 'fuel',    tKey: 'res_fuel' },
  { key: 'other',   tKey: 'res_other' }
];

export const STATUS_CONFIG = {
  hrbp_review: { label: 'Pending HRBP Review', color: '#1e40af', bg: '#eef2ff' },
  fh_approval: { label: 'Pending Function Head', color: '#1e40af', bg: '#eef2ff' },
  ceo_approval: { label: 'Pending CEO', color: '#b45309', bg: '#fef5e7' },
  ta_assignment: { label: 'Pending TA Assignment', color: '#1e40af', bg: '#eef2ff' },
  active_sourcing: { label: 'Active Sourcing', color: '#2d7a4f', bg: '#eaf5ee' },
  pending_close: { label: 'Offer Accepted — Pending Close', color: '#2d7a4f', bg: '#eaf5ee' },
  closed: { label: 'Closed — Filled', color: '#73726c', bg: '#f3f1ea' },
  rejected: { label: 'Rejected', color: '#b91c1c', bg: '#fdecec' },
  revisions_requested: { label: 'Revisions Requested', color: '#b45309', bg: '#fef5e7' },
  on_hold: { label: 'On Hold', color: '#6b4fbb', bg: '#f0ebfa' },
  cancelled: { label: 'Cancelled', color: '#73726c', bg: '#f3f1ea' }
};

export const ICONS = {
  plus: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 8 7 12 13 5"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>',
  rotate: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 8 3 3 8 3"/><path d="M3 8a5 5 0 0 0 9 3"/><polyline points="13 8 13 13 8 13"/><path d="M13 8a5 5 0 0 0-9-3"/></svg>',
  back: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="10 3 5 8 10 13"/></svg>',
  pause: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="3" height="10"/><rect x="9" y="3" width="3" height="10"/></svg>',
  doc: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  warning: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  empty: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="8" width="28" height="34" rx="2"/><line x1="16" y1="18" x2="32" y2="18"/><line x1="16" y1="26" x2="32" y2="26"/><line x1="16" y1="34" x2="24" y2="34"/></svg>'
};

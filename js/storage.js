// ============================================================
// STORAGE — Supabase-backed. Signatures match prototype API so
// the rest of the code (saveData('requisitions', ...)) keeps working.
// ============================================================
import { sb } from './config.js';
import { state } from './state.js';
import { dbg } from './helpers.js';
import { ORG_STRUCTURE, EXISTING_ROLES } from './constants.js';
import { closeModal } from './utils.js';

// UI callbacks — index.html wires these at startup so storage stays UI-agnostic.
let _render = null;
let _navigateTo = null;
export function setOnDataChanged(fn) { _render = fn; }
export function setNavigateTo(fn) { _navigateTo = fn; }
function _doRender() { if (_render) _render(); }
function _doNavigate(view) { if (_navigateTo) _navigateTo(view); }


// ---- MAPPERS: DB row (snake_case) <-> prototype object (camelCase) ----

export function reqFromDb(row) {
  // Resolve dept names from IDs using deptMaps
  const fn = row.department_id     ? state.deptMaps.byId[row.department_id]?.name     : null;
  const sf = row.sub_function_id   ? state.deptMaps.byId[row.sub_function_id]?.name   : null;
  const un = row.unit_id           ? state.deptMaps.byId[row.unit_id]?.name           : null;
  return {
    _dbId: row.id,                               // UUID for future writes
    id: row.req_code,                            // prototype uses req_code as id
    roleId: row.role_id ? state.roleLibMaps.byId[row.role_id]?.legacyId : null,
    roleTitle: row.job_title,
    isNewRole: !!row.is_new_role,
    // Business Unit (top-level dimension above function)
    buId: row.bu_id || null,
    function: fn,
    subFunction: sf,
    unit: un,
    // Exec workflow — when HRBP/Head of TA raises on behalf of a Function Head or CEO,
    // this captures who the actual exec authority is.
    raisedOnBehalfOfEmpId: row.raised_on_behalf_of_employee_id || null,
    grade: row.grade,
    isReplacement: !!row.is_replacement,
    isPlanned: row.is_planned !== false,
    justification: row.justification,
    hrbpJustification: row.hrbp_justification,
    fhJustification: row.fh_justification,
    ceoJustification: row.ceo_justification,
    // Real Supabase UUIDs — getUserName() resolves these via realUsersByUuid.
    // If a UUID isn't in our tenant (shouldn't happen in production), getUser
    // returns null and display code shows "Unknown" gracefully.
    requesterId: row.requester_id || null,
    immediateSupervisorId: row.immediate_supervisor_id || null,
    hiringManagerId: row.hiring_manager_id || null,
    // Real UUIDs for ownership checks (multi-user filtering, etc.)
    realRequesterId: row._requester_real || null,
    realSupervisorId: row._supervisor_real || null,
    realHiringManagerId: row._hm_real || null,
    // Employee-table refs (canonical supervisor/HM after Phase B import).
    // realSupervisorEmpId / realHmEmpId mirror the DB value so approvers
    // don't accidentally overwrite them during updates.
    supervisorEmpId: row.immediate_supervisor_employee_id || null,
    hmEmpId: row.hiring_manager_employee_id || null,
    realSupervisorEmpId: row.immediate_supervisor_employee_id || null,
    realHmEmpId: row.hiring_manager_employee_id || null,
    jdFilename: row.jd_filename,
    jdStoragePath: row.jd_storage_path,
    jdUploadedAt: row.jd_uploaded_at,
    status: row.workflow_status,
    approvalPath: row.approval_path || 'standard',
    submittedAt: row.submitted_at,
    hrbpApprovedAt: row.hrbp_approved_at,
    fhApprovedAt: row.fh_approved_at,
    ceoApprovedAt: row.ceo_approved_at,
    taAssignedAt: row.ta_assigned_at,
    assignedRecruiters: row._recruiters_legacy || [],
    targetFillDate: row.target_fill_date,
    rejectionReason: row.rejection_reason,
    revisionNotes: row.revision_notes,
    holdReason: row.hold_reason,
    holdUntil: row.hold_until,
    cancelReason: row.cancel_reason,
    resourcesRequired: row.resources_required || { items: [], other: null },
    updatedAt: row.updated_at,
  };
}

/* ===== ENTITY RESOLVER (defensive) =====
   Robustly look up a department/sub_function/unit ID from a name.
   Handles:
   - Empty/null input → returns null
   - Missing deptMaps → logs warning, returns null
   - Case-insensitive fallback if exact match fails
   - Whitespace trimming
   Logs to console with [ENTITY-RESOLVE] prefix when something goes wrong.
*/
export function resolveDeptId(level, rawName) {
  // No selection? Nothing to resolve. Not an error.
  if (!rawName || (typeof rawName === 'string' && rawName.trim() === '')) {
    return null;
  }

  const name = String(rawName).trim();

  // Bail loudly if the dept cache wasn't built — this is the bug we're hunting.
  if (!state.deptMaps || !state.deptMaps.byName || Object.keys(state.deptMaps.byName).length === 0) {
    console.warn('[ENTITY-RESOLVE] state.deptMaps not loaded; cannot resolve', level, '→', name,
      '— req will be saved with NULL for this field. Re-load the page and try again.');
    return null;
  }

  // Exact match (the original code path)
  const exact = state.deptMaps.byName[`${level}:${name}`];
  if (exact?.id) return exact.id;

  // Case-insensitive fallback — in case the form value differs in casing/spacing
  // from what's stored in the departments table.
  const target = name.toLowerCase();
  for (const key of Object.keys(state.deptMaps.byName)) {
    const [keyLevel, keyName] = key.split(':');
    if (keyLevel === level && keyName.toLowerCase().trim() === target) {
      console.warn(`[ENTITY-RESOLVE] case/whitespace mismatch resolved: form sent "${name}" → matched DB "${keyName}"`);
      return state.deptMaps.byName[key].id;
    }
  }

  // Truly unresolvable. Log the available names for debugging.
  const availableNames = Object.keys(state.deptMaps.byName).filter(k => k.startsWith(level + ':')).slice(0, 8);
  console.warn(`[ENTITY-RESOLVE] could not resolve ${level} "${name}". First few available ${level}s:`, availableNames);
  return null;
}

export function reqToDb(r) {
  // Map camelCase -> snake_case for INSERT/UPDATE
  // Use the robust resolver (handles missing deptMaps, case mismatches, etc.)
  const fnId = resolveDeptId('function',     r.function);
  const sfId = resolveDeptId('sub_function', r.subFunction);
  const unId = resolveDeptId('unit',         r.unit);
  // Look up the role by legacyId first (unique per row). Fall back to byTitle for
  // legacy reqs that still use the title-only path.
  const roleLibId = r.roleId
    ? (state.roleLibMaps.byLegacyId?.[r.roleId]?.id || state.roleLibMaps.byTitle?.[r.roleTitle]?.id || null)
    : null;
  // CRITICAL: preserve the real requester/supervisor/HM across updates.
  // - For NEW reqs (no _dbId), default to currentAuthUser
  // - For EXISTING reqs, use the realRequesterId that was loaded from the DB
  // Never overwrite these fields on approve/reject/assign — the approver is NOT the requester.
  const isNewReq = !r._dbId;
  const requesterUuid = isNewReq
    ? state.currentAuthUser?.id
    : (r.realRequesterId || null);
  const supervisorUuid = isNewReq
    ? state.currentAuthUser?.id
    : (r.realSupervisorId || null);
  const hmUuid = isNewReq
    ? state.currentAuthUser?.id
    : (r.realHiringManagerId || null);
  // ⭐ Same rule for the employee_id columns: new reqs carry the picker values;
  // existing reqs preserve whatever was in the DB (don't let approvers overwrite).
  const supEmpIdForDb = isNewReq
    ? (r.supervisorEmpId || null)
    : (r.realSupervisorEmpId || null);
  const hmEmpIdForDb = isNewReq
    ? (r.hmEmpId || null)
    : (r.realHmEmpId || null);
  // Diagnostic: warn if a new req is being saved without a requester_id.
  // Catches the auth-state bug where currentAuthUser was null at save time.
  if (isNewReq && !requesterUuid) {
    console.warn('[reqToDb] NEW req has no requester_id', {
      currentAuthUser_present: !!state.currentAuthUser,
      currentAuthUser_id: state.currentAuthUser?.id,
      currentMember_present: !!state.currentMember,
      currentMember_role: state.currentMember?.role,
      r_id: r.id,
    });
  }
  return {
    req_code: r.id,
    job_title: r.roleTitle,
    role_id: roleLibId,
    is_new_role: r.isNewRole,
    grade: r.grade,
    bu_id: r.buId || null,
    department_id: fnId,
    sub_function_id: sfId,
    unit_id: unId,
    raised_on_behalf_of_employee_id: r.raisedOnBehalfOfEmpId || null,
    is_replacement: r.isReplacement,
    is_planned: r.isPlanned,
    justification: r.justification,
    hrbp_justification: r.hrbpJustification,
    fh_justification: r.fhJustification,
    ceo_justification: r.ceoJustification,
    requester_id: requesterUuid,
    immediate_supervisor_id: supervisorUuid,
    hiring_manager_id: hmUuid,
    immediate_supervisor_employee_id: supEmpIdForDb,
    hiring_manager_employee_id: hmEmpIdForDb,
    jd_filename: r.jdFilename,
    workflow_status: r.status,
    approval_path: r.approvalPath || 'standard',
    status: 'open',
    submitted_at: r.submittedAt,
    hrbp_approved_at: r.hrbpApprovedAt,
    fh_approved_at: r.fhApprovedAt,
    ceo_approved_at: r.ceoApprovedAt,
    ta_assigned_at: r.taAssignedAt,
    target_fill_date: r.targetFillDate,
    rejection_reason: r.rejectionReason,
    revision_notes: r.revisionNotes,
    hold_reason: r.holdReason,
    hold_until: r.holdUntil,
    cancel_reason: r.cancelReason,
    resources_required: r.resourcesRequired || { items: [], other: null },
    tenant_id: state.currentTenantId,
  };
}

export function candFromDb(row, appRow) {
  // Merge candidate row with its application row (one-to-one in prototype model)
  const c = {
    _dbId: row.id,
    _appDbId: appRow?.id,
    id: `CAN-${row.id.slice(0, 8)}`,              // human-ish short id
    reqId: appRow?._req_legacy,                   // filled by loader
    name: row.full_name,
    email: row.email,
    phone: row.phone,
    source: (row.source || '').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()),
    cvFilename: row.cv_filename,
    cvStoragePath: row.cv_storage_path,
    cvUploadedAt: row.cv_uploaded_at,
    notes: row.notes,
    // Demographics — read straight from DB columns
    gender: row.gender || null,
    dateOfBirth: row.date_of_birth || null,
    yearsExperience: row.years_experience ?? null,
    educationLevel: row.education_level || null,
    nationality: row.nationality || null,
    // Gap 2 — Sourcing economics fields (per-hire variable costs)
    agencyName: row.agency_name || null,
    agencyFeeUsd: row.agency_fee_usd != null ? Number(row.agency_fee_usd) : null,
    referralEmployeeId: row.referral_employee_id || null,
    referralBonusUsd: row.referral_bonus_usd != null ? Number(row.referral_bonus_usd) : null,
    directCostUsd: row.direct_cost_usd != null ? Number(row.direct_cost_usd) : null,
    stage: appRow?.candidate_stage || 'sourcing',
    addedAt: appRow?.applied_at || row.created_at,
    stageChangedAt: appRow?.stage_changed_at || row.created_at,
    status: appRow?.status === 'active' ? 'active' : (appRow?.status || 'active'),
    interview: null,
    feedback: [],
    preEmploymentChecks: {
      reference: !!appRow?.checks_reference,
      background: !!appRow?.checks_background,
      criminal: !!appRow?.checks_criminal,
      education: !!appRow?.checks_education,
      coi: !!appRow?.checks_coi,
      coiStoragePath: appRow?.coi_storage_path || null,
      coiFilename: appRow?.coi_filename || null,
      coiUploadedAt: appRow?.coi_uploaded_at || null,
      notes: appRow?.checks_notes || ''
    },
    offer: appRow?.offer_status ? {
      salary: appRow.offer_salary,
      grade: appRow.offer_grade,
      startDate: appRow.offer_start_date,
      benefits: appRow.offer_benefits,
      notes: appRow.offer_notes,
      sentAt: appRow.offer_sent_at,
      status: appRow.offer_status
    } : null
  };
  return c;
}

export function activityFromDb(row) {
  const reqByDbId = state.requisitions.find(r => r._dbId === row.entity_id);
  return {
    reqId: reqByDbId?.id || row.entity_id,
    date: row.created_at,
    text: (row.metadata?.text) || row.action.replace(/_/g, ' '),
    visibleTo: ['all']
  };
}

// ---- Main loader: fetch everything from Supabase into in-memory arrays ----
export async function loadEverything() {
  const t = state.currentTenantId;

  // Parallel fetch
  const [deptsRes, rolesRes, reqsRes, candsRes, appsRes, ivRes, ivfRes, reqRecRes, actRes, membersRes, empsRes, onboardingsRes, channelCostsRes, businessUnitsRes] = await Promise.all([
    sb.from('departments').select('*').eq('tenant_id', t),
    sb.from('role_library').select('*').eq('tenant_id', t).eq('is_active', true),
    sb.from('requisitions').select('*').eq('tenant_id', t).is('deleted_at', null).order('created_at'),
    sb.from('candidates').select('*').eq('tenant_id', t).is('deleted_at', null),
    sb.from('applications').select('*').eq('tenant_id', t),
    sb.from('interviews').select('*').eq('tenant_id', t),
    sb.from('interview_feedback').select('*').eq('tenant_id', t),
    sb.from('requisition_recruiters').select('*'),
    sb.from('activity_log').select('*').eq('tenant_id', t).order('created_at', { ascending: false }).limit(200),
    // Fetch all active tenant members with their profiles — so getUserName can resolve real UUIDs
    // Use explicit FK hint (!tenant_members_user_id_fkey) so PostgREST knows
    // which relationship to use for the embedded profiles join.
    sb.from('tenant_members')
      .select('user_id, role, profiles!tenant_members_user_id_fkey(id, full_name, email)')
      .eq('tenant_id', t).eq('status', 'active'),
    // Employees: source of truth for Supervisor/HM pickers. Includes people
    // without logins (most of the 745). Name resolution + dropdowns pull from here.
    sb.from('employees').select('id, employee_code, name_en, name_kh, position_title, grade, function_id, department_id, company_email, user_id, company, is_function_head, is_ceo').eq('tenant_id', t).eq('status', 'Active').order('name_en'),
    // Gap 3 — Onboarding records. Always fetched (table may be empty initially).
    sb.from('onboarding').select('*').eq('tenant_id', t).is('deleted_at', null),
    // Gap 2 — Periodic channel costs (e.g. "LinkedIn Recruiter Q1 = $4,500")
    sb.from('sourcing_channel_costs').select('*').eq('tenant_id', t).is('deleted_at', null).order('period_start', { ascending: false }),
    // Business Units — top-level dimension for cross-BU reporting (e.g. ISI Steel, Brown Coffee)
    // Sort by sort_order (ISI Group=1 first), then alphabetical by name.
    sb.from('business_units').select('*').eq('tenant_id', t).is('deleted_at', null).eq('is_active', true).order('sort_order').order('name'),
  ]);

  // Build the real-users lookup from tenant_members + profiles
  state.realUsersByUuid = {};
  let _membersData = membersRes.data || [];
  // Detect if the embedded join failed (profiles came back null even though
  // we have member rows). If so, fall back to fetching profiles separately.
  const embeddedJoinFailed = _membersData.length > 0 && _membersData.every(m => !m.profiles);
  if (embeddedJoinFailed) {
    console.warn('[hwm] embedded profiles join returned null, falling back to separate fetch');
    const userIds = _membersData.map(m => m.user_id);
    const { data: profilesData } = await sb.from('profiles')
      .select('id, full_name, email')
      .in('id', userIds);
    const profileById = {};
    (profilesData || []).forEach(p => { profileById[p.id] = p; });
    _membersData = _membersData.map(m => ({ ...m, profiles: profileById[m.user_id] || null }));
  }
  _membersData.forEach(m => {
    if (m.profiles) {
      state.realUsersByUuid[m.user_id] = {
        id: m.user_id,
        name: m.profiles.full_name || m.profiles.email || 'Unknown',
        email: m.profiles.email,
        role: m.role,
      };
    }
  });
  dbg('[hwm] state.realUsersByUuid populated with', Object.keys(state.realUsersByUuid).length, 'users');

  // Build dept maps
  state.deptMaps = { byName: {}, byId: {} };
  (deptsRes.data || []).forEach(d => {
    state.deptMaps.byId[d.id] = d;
    state.deptMaps.byName[`${d.level}:${d.name}`] = d;
  });

  // ⭐ Build REAL_ORG_STRUCTURE from DB, overwriting the hardcoded ORG_STRUCTURE.
  // Walks the parent_id tree: function → sub_function → unit
  // Shape: { 'Commercial': { 'Key Account': ['...sections...'], 'Marketing': [] }, ... }
  const allDepts = deptsRes.data || [];
  const fns = allDepts.filter(d => d.level === 'function');
  const sfs = allDepts.filter(d => d.level === 'sub_function');
  const uns = allDepts.filter(d => d.level === 'unit');
  const newOrg = {};
  fns.forEach(fn => {
    newOrg[fn.name] = {};
    sfs.filter(sf => sf.parent_id === fn.id).forEach(sf => {
      newOrg[fn.name][sf.name] = uns
        .filter(un => un.parent_id === sf.id)
        .map(un => un.name)
        .sort();
    });
  });
  // Sort function names and dept names alphabetically for consistent UI
  const sortedOrg = {};
  Object.keys(newOrg).sort().forEach(fn => {
    sortedOrg[fn] = {};
    Object.keys(newOrg[fn]).sort().forEach(sf => {
      sortedOrg[fn][sf] = newOrg[fn][sf];
    });
  });
  // Replace ORG_STRUCTURE contents in-place (keep reference)
  Object.keys(ORG_STRUCTURE).forEach(k => delete ORG_STRUCTURE[k]);
  Object.assign(ORG_STRUCTURE, sortedOrg);
  dbg('[hwm] ORG_STRUCTURE rebuilt from DB:', Object.keys(ORG_STRUCTURE).length, 'functions');

  // Build role library maps
  state.roleLibMaps = { byTitle: {}, byId: {}, byLegacyId: {} };
  (rolesRes.data || []).forEach((r, i) => {
    const legacyId = `R${String(i + 1).padStart(3, '0')}`;
    r.legacyId = legacyId;
    // byTitle may collide across variants; last-write-wins is intentional for
    // legacy fallback. byLegacyId is guaranteed unique per row.
    state.roleLibMaps.byTitle[r.title] = r;
    state.roleLibMaps.byId[r.id] = r;
    state.roleLibMaps.byLegacyId[legacyId] = r;
  });
  // Overwrite EXISTING_ROLES (the prototype's dropdown source) with DB data
  EXISTING_ROLES.length = 0;
  (rolesRes.data || []).forEach(r => {
    EXISTING_ROLES.push({
      id: r.legacyId,
      title: r.title,
      function: state.deptMaps.byId[r.function_id]?.name || '',
      grade: r.grade
    });
  });

  // ⭐ Build employee lookup maps from the master-file import. The `list` is
  // used as the autocomplete source for Supervisor/HM pickers. byId and
  // byCode resolve selected values back to the canonical employee record.
  // byUserId lets us reverse-lookup: given a login UUID, find the employee.
  state.employeeMaps = { byId: {}, byCode: {}, byUserId: {}, list: [] };
  (empsRes?.data || []).forEach(e => {
    state.employeeMaps.byId[e.id] = e;
    state.employeeMaps.byCode[e.employee_code] = e;
    if (e.user_id) state.employeeMaps.byUserId[e.user_id] = e;
    state.employeeMaps.list.push(e);
  });
  dbg('[hwm] employees loaded:', state.employeeMaps.list.length);

  // Build the recruiters-per-req lookup (M:N table)
  const recsByReq = {};
  (reqRecRes.data || []).forEach(rec => {
    (recsByReq[rec.requisition_id] = recsByReq[rec.requisition_id] || []).push(rec.user_id);
  });

  // Transform requisitions
  state.requisitions = (reqsRes.data || []).map(row => {
    // Recruiter assignments — only real tenant-member UUIDs are kept; unknown
    // UUIDs would indicate a stale row and are dropped rather than masked.
    row._recruiters_legacy = (recsByReq[row.id] || []).filter(uid => state.realUsersByUuid[uid]);
    // Preserve the REAL UUIDs from the DB for ownership filtering.
    row._requester_real = row.requester_id;
    row._supervisor_real = row.immediate_supervisor_id;
    row._hm_real = row.hiring_manager_id;
    return reqFromDb(row);
  });

  // Transform candidates — merge with applications
  const appsByCandReq = {};
  (appsRes.data || []).forEach(a => {
    const k = `${a.candidate_id}__${a.requisition_id}`;
    appsByCandReq[k] = a;
  });
  // Also need to know req code for each application
  const reqByDbId = {};
  state.requisitions.forEach(r => { reqByDbId[r._dbId] = r.id; });

  state.candidates = [];
  (appsRes.data || []).forEach(a => {
    const candRow = (candsRes.data || []).find(c => c.id === a.candidate_id);
    if (!candRow) return;
    a._req_legacy = reqByDbId[a.requisition_id];
    const c = candFromDb(candRow, a);
    // Attach interview (first one for this app, if any)
    const iv = (ivRes.data || []).find(i => i.application_id === a.id);
    if (iv) {
      c.interview = {
        datetime: iv.scheduled_at,
        type: ({phone:'Phone',video:'Video Call',onsite:'In-person',panel:'Panel',take_home:'Take-home',technical:'Technical',cultural:'Cultural'})[iv.interview_type] || iv.interview_type,
        interviewers: [],  // will be populated from interview_interviewers table when wired
        location: iv.location_or_link || '',
        notes: iv.summary || ''
      };
      // Attach feedback
      c.feedback = (ivfRes.data || []).filter(f => f.interview_id === iv.id).map(f => ({
        interviewerId: null,
        rating: ({strong_hire:'Strong Yes',hire:'Yes',maybe:'Maybe',no_hire:'No',strong_no_hire:'Strong No'})[f.recommendation] || f.recommendation,
        notes: f.strengths || '',
        submittedAt: f.submitted_at
      }));
    }
    state.candidates.push(c);
  });

  // Transform activity log
  state.activities = (actRes.data || []).map(activityFromDb);

  // Gap 3 — Onboarding records. Stored DB-shape is camelCased here for consistency
  // with the rest of the in-memory model (camelCase). Empty array if none.
  state.onboardings = (onboardingsRes?.data || []).map(onboardingFromDb);

  // Gap 2 — Channel costs (periodic LinkedIn / job board / agency subscriptions, etc.)
  state.channelCosts = (channelCostsRes?.data || []).map(channelCostFromDb);

  // Business Units — already sorted by sort_order then name from the query.
  state.businessUnits = (businessUnitsRes?.data || []);
}

// Gap 3 — DB row → in-memory shape (camelCase). Symmetric with onboardingToDb.
export function onboardingFromDb(row) {
  return {
    _dbId: row.id,
    applicationId: row.application_id,
    candidateId: row.candidate_id,
    requisitionId: row.requisition_id,
    intendedStartDate: row.intended_start_date,
    actualStartDate: row.actual_start_date,
    startStatus: row.start_status,
    startLoggedAt: row.start_logged_at,
    startLoggedBy: row.start_logged_by,
    probationEndDate: row.probation_end_date,
    probationOutcome: row.probation_outcome,
    probationLoggedAt: row.probation_logged_at,
    probationLoggedBy: row.probation_logged_by,
    probationNotes: row.probation_notes,
    exitDate: row.exit_date,
    exitReason: row.exit_reason,
    exitInitiator: row.exit_initiator,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Gap 3 — In-memory → DB shape. Used by saveOnboardingRecord.
export function onboardingToDb(o) {
  return {
    tenant_id: state.currentTenantId,
    application_id: o.applicationId,
    candidate_id: o.candidateId,
    requisition_id: o.requisitionId,
    intended_start_date: o.intendedStartDate || null,
    actual_start_date: o.actualStartDate || null,
    start_status: o.startStatus || null,
    start_logged_at: o.startLoggedAt || null,
    start_logged_by: o.startLoggedBy || null,
    probation_end_date: o.probationEndDate || null,
    probation_outcome: o.probationOutcome || null,
    probation_logged_at: o.probationLoggedAt || null,
    probation_logged_by: o.probationLoggedBy || null,
    probation_notes: (o.probationNotes && o.probationNotes.trim()) || null,
    exit_date: o.exitDate || null,
    exit_reason: (o.exitReason && o.exitReason.trim()) || null,
    exit_initiator: o.exitInitiator || null,
    notes: (o.notes && o.notes.trim()) || null,
  };
}

// Gap 3 — Save (insert if no _dbId, otherwise update). Returns the in-memory row.
export async function saveOnboardingRecord(o) {
  const payload = onboardingToDb(o);
  if (o._dbId) {
    const { data, error } = await sb.from('onboarding').update(payload).eq('id', o._dbId).select();
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error('Update blocked by database policy.');
    }
    return o;
  } else {
    const { data, error } = await sb.from('onboarding').insert(payload).select().single();
    if (error) throw error;
    o._dbId = data.id;
    o.createdAt = data.created_at;
    o.updatedAt = data.updated_at;
    return o;
  }
}

// Gap 3 — Auto-create an onboarding row when an offer is accepted. Idempotent —
// if a row already exists for this application_id, returns it without re-creating.
// Called from offerResponse() right after the requisition save succeeds.
export async function autoCreateOnboardingForHire(candidate) {
  // Sanity checks
  if (!candidate?._appDbId) {
    console.warn('[onboarding] candidate has no application _dbId — cannot auto-create');
    return null;
  }
  if (!candidate.offer?.startDate) {
    console.warn('[onboarding] no offer start date — cannot auto-create');
    return null;
  }

  // Idempotent: check if one already exists for this application
  const existing = state.onboardings.find(o => o.applicationId === candidate._appDbId);
  if (existing) return existing;

  // Compute probation_end_date = start_date + 30 days (Cambodia standard)
  const startDate = new Date(candidate.offer.startDate);
  const probationEnd = new Date(startDate);
  probationEnd.setDate(probationEnd.getDate() + 30);

  const newRow = {
    applicationId: candidate._appDbId,
    candidateId: candidate._dbId || null,
    requisitionId: state.requisitions.find(r => r.id === candidate.reqId)?._dbId || null,
    intendedStartDate: candidate.offer.startDate,
    probationEndDate: probationEnd.toISOString().slice(0, 10),
    probationOutcome: 'pending',
  };
  try {
    await saveOnboardingRecord(newRow);
    state.onboardings.push(newRow);
    return newRow;
  } catch (e) {
    console.error('[onboarding] auto-create failed:', e);
    // Don't toast — this is a background task. Failure here shouldn't block the offer flow.
    return null;
  }
}

// ============================================================
// GAP 2 — CHANNEL COST helpers
// ============================================================
// One row per "We paid $X for source Y from date A to date B".

export function channelCostFromDb(row) {
  return {
    _dbId: row.id,
    source: row.source,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    costUsd: Number(row.cost_usd),
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function channelCostToDb(c) {
  return {
    tenant_id: state.currentTenantId,
    source: c.source,
    period_start: c.periodStart,
    period_end: c.periodEnd,
    cost_usd: c.costUsd,
    notes: (c.notes && c.notes.trim()) || null,
    created_by: c.createdBy || state.currentAuthUser?.id || null,
  };
}

export async function saveChannelCostRecord(c) {
  const payload = channelCostToDb(c);
  if (c._dbId) {
    const { data, error } = await sb.from('sourcing_channel_costs').update(payload).eq('id', c._dbId).select();
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error('Update blocked by database policy.');
    }
    return c;
  } else {
    const { data, error } = await sb.from('sourcing_channel_costs').insert(payload).select().single();
    if (error) throw error;
    c._dbId = data.id;
    c.createdAt = data.created_at;
    c.updatedAt = data.updated_at;
    return c;
  }
}

export async function deleteChannelCostRecord(c) {
  // Soft delete — set deleted_at instead of hard DELETE
  if (!c._dbId) return;
  const { error } = await sb.from('sourcing_channel_costs')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', c._dbId);
  if (error) throw error;
}

// ---- The drop-in replacement for saveData ----
// The prototype calls saveData('requisitions', state.requisitions), saveData('candidates', state.candidates), etc.
// We intercept and persist whichever entity was just mutated.
// Strategy: diff recent changes by checking in-memory arrays against DB.
// Simpler strategy used here: full upsert of all rows in the given entity.
// This is NOT efficient for a big dataset but is perfectly fine for the prototype's scale (~5-20 reqs).

export async function saveData(key, value) {
  if (!state.currentTenantId) return;
  try {
    if (key === 'requisitions') await saveRequisitions(value);
    else if (key === 'candidates') await saveCandidates(value);
    else if (key === 'activities') await saveActivitiesTail(value);
    else if (key === 'currentLang') localStorage.setItem('hwm_lang', value);
  } catch (e) {
    console.error('saveData failed:', key, e);
    toast('Save failed: ' + (e.message || e), true);
  }
}

export async function saveRequisitions(list) {
  // For each req in list, upsert to DB
  for (const r of list) {
    const dbPayload = reqToDb(r);
    // Defensive: if any entity ID came back null despite a form value, query DB directly.
    await enrichEntityIdsFromDb(r, dbPayload);
    if (r._dbId) {
      // Update existing
      const { error } = await sb.from('requisitions').update(dbPayload).eq('id', r._dbId);
      if (error) throw error;
    } else {
      // New requisition
      const { data, error } = await sb.from('requisitions').insert(dbPayload).select().single();
      if (error) throw error;
      r._dbId = data.id;
    }
  }
  toast('Saved');
}

// Targeted insert/update for ONE requisition. Faster than saveRequisitions when
// you know exactly which row changed. Also lets callers await the result so
// downstream activity logging sees the freshly-set _dbId.
/* ===== ENTITY ID FALLBACK FROM DB =====
   If reqToDb returned null IDs for fields that the form actually filled,
   query the departments table directly as a last resort. This handles the
   case where deptMaps somehow didn't load but the database still has valid data.
   Mutates dbPayload in place. Safe no-op if everything already resolved.
*/
export async function enrichEntityIdsFromDb(r, dbPayload) {
  // Build list of (formValue, level, payloadKey) tuples that need backfill.
  const checks = [
    { formValue: r.function,    level: 'function',     key: 'department_id'   },
    { formValue: r.subFunction, level: 'sub_function', key: 'sub_function_id' },
    { formValue: r.unit,        level: 'unit',         key: 'unit_id'         },
  ];

  // Only check ones where the form had a value but the payload is null.
  const needBackfill = checks.filter(c =>
    c.formValue && String(c.formValue).trim() !== '' && !dbPayload[c.key]
  );

  if (needBackfill.length === 0) return; // happy path

  console.warn('[ENTITY-DB-FALLBACK] reqToDb returned null for', needBackfill.map(c => c.level).join(', '),
    '— querying departments table directly');

  for (const c of needBackfill) {
    try {
      const { data, error } = await sb.from('departments')
        .select('id, name, level')
        .eq('tenant_id', state.currentTenantId)
        .eq('level', c.level)
        .ilike('name', String(c.formValue).trim())  // case-insensitive
        .is('deleted_at', null)
        .limit(1);
      if (error) {
        console.error('[ENTITY-DB-FALLBACK] query failed for', c.level, error.message);
        continue;
      }
      if (data && data.length > 0) {
        dbPayload[c.key] = data[0].id;
        dbg('[ENTITY-DB-FALLBACK] resolved', c.level, '"' + c.formValue + '" →', data[0].id);
      } else {
        console.warn('[ENTITY-DB-FALLBACK] no match in DB for', c.level, '"' + c.formValue + '"');
      }
    } catch (e) {
      console.error('[ENTITY-DB-FALLBACK] unexpected error', e);
    }
  }
}

export async function saveSingleRequisition(r) {
  const dbPayload = reqToDb(r);
  // Defensive: if any entity ID came back null despite a form value, query DB directly.
  await enrichEntityIdsFromDb(r, dbPayload);
  if (r._dbId) {
    // .select() after .update() returns the rows that were affected. If RLS
    // silently blocks the update, this returns an empty array — we catch that
    // here and throw a clear error rather than reporting a false "Saved".
    const { data, error } = await sb.from('requisitions').update(dbPayload).eq('id', r._dbId).select();
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error('Update blocked by database policy. You may not have permission for this action.');
    }
  } else {
    const { data, error } = await sb.from('requisitions').insert(dbPayload).select().single();
    if (error) throw error;
    r._dbId = data.id;
  }
  toast('Saved');
  return r;
}

// Helper for state-mutation actions (approve/reject/hold/cancel/etc). Persists
// the specific requisition, logs activity, and navigates on success. On error,
// shows a toast and leaves the user on the current view so they can retry.
// Any action function that previously did `saveData('requisitions', state.requisitions); logActivity(...); _doNavigate('dashboard')`
// can now just do `await persistReqChange(r, 'activity text')`.
export async function persistReqChange(r, activityText, options = {}) {
  try {
    await saveSingleRequisition(r);
    if (activityText) {
      logActivity(r.id, activityText);
      await saveData('activities', state.activities);
    }
    if (options.closeModal !== false) closeModal();
    if (options.nextView !== null) _doNavigate(options.nextView || 'dashboard');
    return true;
  } catch (e) {
    console.error('persistReqChange failed:', e);
    toast('Failed to save: ' + (e.message || e), true);
    return false;
  }
}

// Targeted insert/update for ONE candidate + its application row. Mirror of
// saveSingleRequisition but for candidates. Awaitable.
export async function saveSingleCandidate(c) {
  const candPayload = {
    tenant_id: state.currentTenantId,
    full_name: c.name,
    // ⭐ Coerce empty strings to null. The DB has a unique constraint on (tenant, email);
    // sending '' for two empty-email candidates would falsely trigger a duplicate. NULL is ignored.
    email: (c.email && String(c.email).trim()) ? String(c.email).trim() : null,
    phone: (c.phone && String(c.phone).trim()) ? String(c.phone).trim() : null,
    source: (c.source || '').toLowerCase().replace(/ /g, '_') || 'other',
    cv_filename: c.cvFilename,
    notes: c.notes,
    created_by: state.currentAuthUser?.id,
    // Demographics — null if not provided
    gender: c.gender || null,
    date_of_birth: c.dateOfBirth || null,
    years_experience: (c.yearsExperience === undefined || c.yearsExperience === null || c.yearsExperience === '') ? null : c.yearsExperience,
    education_level: c.educationLevel || null,
    nationality: c.nationality || null,
    // Gap 2 — Sourcing economics. All optional; coerce empty/undefined → null.
    agency_name: (c.agencyName && String(c.agencyName).trim()) || null,
    agency_fee_usd: (c.agencyFeeUsd === '' || c.agencyFeeUsd == null) ? null : Number(c.agencyFeeUsd),
    referral_employee_id: c.referralEmployeeId || null,
    referral_bonus_usd: (c.referralBonusUsd === '' || c.referralBonusUsd == null) ? null : Number(c.referralBonusUsd),
    direct_cost_usd: (c.directCostUsd === '' || c.directCostUsd == null) ? null : Number(c.directCostUsd),
  };
  if (c._dbId) {
    const { error } = await sb.from('candidates').update(candPayload).eq('id', c._dbId);
    if (error) throw error;
  } else {
    const { data, error } = await sb.from('candidates').insert(candPayload).select().single();
    if (error) throw error;
    c._dbId = data.id;
  }

  // Application row (one-to-one per candidate+req pair)
  const req = state.requisitions.find(r => r.id === c.reqId);
  if (!req || !req._dbId) { toast('Saved'); return c; }
  const appPayload = {
    tenant_id: state.currentTenantId,
    requisition_id: req._dbId,
    candidate_id: c._dbId,
    candidate_stage: c.stage,
    status: c.status || 'active',
    applied_at: c.addedAt,
    stage_changed_at: c.stageChangedAt,
    created_by: state.currentAuthUser?.id,
    checks_reference: !!c.preEmploymentChecks?.reference,
    checks_background: !!c.preEmploymentChecks?.background,
    checks_criminal: !!c.preEmploymentChecks?.criminal,
    checks_education: !!c.preEmploymentChecks?.education,
    checks_coi: !!c.preEmploymentChecks?.coi,
    coi_storage_path: c.preEmploymentChecks?.coiStoragePath || null,
    coi_filename: c.preEmploymentChecks?.coiFilename || null,
    coi_uploaded_at: c.preEmploymentChecks?.coiUploadedAt || null,
    checks_notes: c.preEmploymentChecks?.notes || null,
    offer_salary: c.offer?.salary ?? null,
    offer_grade: c.offer?.grade ?? null,
    offer_start_date: c.offer?.startDate ?? null,
    offer_benefits: c.offer?.benefits ?? null,
    offer_notes: c.offer?.notes ?? null,
    offer_sent_at: c.offer?.sentAt ?? null,
    offer_status: c.offer?.status ?? null,
  };
  if (c._appDbId) {
    const { error } = await sb.from('applications').update(appPayload).eq('id', c._appDbId);
    if (error) throw error;
  } else {
    const { data, error } = await sb.from('applications').insert(appPayload).select().single();
    if (error) throw error;
    c._appDbId = data.id;
  }
  toast('Saved');
  return c;
}

// Wrapper for candidate-side mutations (moveCandidate, rejectCandidate, etc).
/* ===== ERROR TRANSLATOR =====
   Convert cryptic Supabase / Postgres / Storage errors into messages
   recruiters will understand. Returns { title, hint } where hint may be ''.
*/
export function friendlyError(e) {
  const code = e?.code || '';
  const msg = (e?.message || String(e) || '').toLowerCase();

  // 23505 = unique constraint violation
  if (code === '23505' || msg.includes('duplicate key value')) {
    if (msg.includes('cand_tenant_email_uidx') || msg.includes('email')) {
      return {
        title: 'A candidate with this email already exists',
        hint: 'Please check your candidate list, or use a different email if this is a different person.'
      };
    }
    if (msg.includes('phone')) {
      return { title: 'A candidate with this phone number already exists', hint: '' };
    }
    return { title: 'This record already exists', hint: 'Please check for duplicates and try again.' };
  }

  // Storage size limit
  if (msg.includes('exceeded the maximum allowed size') || msg.includes('payload too large')) {
    return {
      title: 'CV file is too large',
      hint: 'Please compress the PDF or upload a smaller version (under 5 MB recommended).'
    };
  }

  // RLS / auth
  if (msg.includes('row level security') || msg.includes('blocked by database policy')) {
    return {
      title: 'You don\'t have permission to do this',
      hint: 'Contact your administrator if you believe this is an error.'
    };
  }

  // Network / fetch
  if (msg.includes('failed to fetch') || msg.includes('network')) {
    return { title: 'Connection problem', hint: 'Check your internet and try again.' };
  }

  // Default — pass through original message
  return { title: e?.message || 'Save failed', hint: '' };
}

export async function persistCandidateChange(c, activityText, options = {}) {
  try {
    await saveSingleCandidate(c);
    if (activityText) {
      logActivity(c.reqId, activityText);
      await saveData('activities', state.activities);
    }
    if (options.closeModal !== false) closeModal();
    if (options.render !== false) _doRender();
    return true;
  } catch (e) {
    console.error('persistCandidateChange failed:', e);
    const f = friendlyError(e);
    toast(f.hint ? `${f.title} — ${f.hint}` : f.title, true);
    return false;
  }
}

export async function saveCandidates(list) {
  for (const c of list) {
    const candPayload = {
      tenant_id: state.currentTenantId,
      full_name: c.name,
      // ⭐ Coerce empty strings to null (see saveSingleCandidate for rationale).
      email: (c.email && String(c.email).trim()) ? String(c.email).trim() : null,
      phone: (c.phone && String(c.phone).trim()) ? String(c.phone).trim() : null,
      source: (c.source || '').toLowerCase().replace(/ /g, '_') || 'other',
      cv_filename: c.cvFilename,
      notes: c.notes,
      created_by: state.currentAuthUser?.id,
      // Demographics — null if not provided
      gender: c.gender || null,
      date_of_birth: c.dateOfBirth || null,
      years_experience: (c.yearsExperience === undefined || c.yearsExperience === null || c.yearsExperience === '') ? null : c.yearsExperience,
      education_level: c.educationLevel || null,
      nationality: c.nationality || null,
      // Gap 2 — Sourcing economics
      agency_name: (c.agencyName && String(c.agencyName).trim()) || null,
      agency_fee_usd: (c.agencyFeeUsd === '' || c.agencyFeeUsd == null) ? null : Number(c.agencyFeeUsd),
      referral_employee_id: c.referralEmployeeId || null,
      referral_bonus_usd: (c.referralBonusUsd === '' || c.referralBonusUsd == null) ? null : Number(c.referralBonusUsd),
      direct_cost_usd: (c.directCostUsd === '' || c.directCostUsd == null) ? null : Number(c.directCostUsd),
    };
    if (c._dbId) {
      await sb.from('candidates').update(candPayload).eq('id', c._dbId);
    } else {
      const { data, error } = await sb.from('candidates').insert(candPayload).select().single();
      if (error) throw error;
      c._dbId = data.id;
    }

    // Application side
    const req = state.requisitions.find(r => r.id === c.reqId);
    if (!req || !req._dbId) continue;
    const appPayload = {
      tenant_id: state.currentTenantId,
      requisition_id: req._dbId,
      candidate_id: c._dbId,
      candidate_stage: c.stage,
      status: c.status || 'active',
      applied_at: c.addedAt,
      stage_changed_at: c.stageChangedAt,
      created_by: state.currentAuthUser?.id,
      checks_reference: !!c.preEmploymentChecks?.reference,
      checks_background: !!c.preEmploymentChecks?.background,
      checks_criminal: !!c.preEmploymentChecks?.criminal,
      checks_education: !!c.preEmploymentChecks?.education,
      checks_coi: !!c.preEmploymentChecks?.coi,
      coi_storage_path: c.preEmploymentChecks?.coiStoragePath || null,
      coi_filename: c.preEmploymentChecks?.coiFilename || null,
      coi_uploaded_at: c.preEmploymentChecks?.coiUploadedAt || null,
      checks_notes: c.preEmploymentChecks?.notes || null,
      offer_salary: c.offer?.salary ?? null,
      offer_grade: c.offer?.grade ?? null,
      offer_start_date: c.offer?.startDate ?? null,
      offer_benefits: c.offer?.benefits ?? null,
      offer_notes: c.offer?.notes ?? null,
      offer_sent_at: c.offer?.sentAt ?? null,
      offer_status: c.offer?.status ?? null,
    };
    if (c._appDbId) {
      await sb.from('applications').update(appPayload).eq('id', c._appDbId);
    } else {
      const { data, error } = await sb.from('applications').insert(appPayload).select().single();
      if (error) throw error;
      c._appDbId = data.id;
    }
  }
  toast('Saved');
}

export async function saveActivitiesTail(list) {
  // Only persist the newest activity (the one at index 0 that logActivity just unshifted)
  // If it already has _dbId we skip.
  const head = list[0];
  if (!head || head._dbId) return;
  const req = state.requisitions.find(r => r.id === head.reqId);
  if (!req || !req._dbId) return;
  const { data, error } = await sb.from('activity_log').insert({
    tenant_id: state.currentTenantId,
    actor_id: state.currentAuthUser?.id,
    entity_type: 'requisition',
    entity_id: req._dbId,
    action: 'note',
    metadata: { text: head.text }
  }).select().single();
  if (!error && data) head._dbId = data.id;
}

// Compatibility stub — legacy code paths used loadData('key', default)
export async function loadData(key, defaultValue) {
  if (key === 'currentLang') return localStorage.getItem('hwm_lang') || defaultValue;
  // Everything else is loaded via loadEverything() on boot
  return defaultValue;
}

// ---- Toast helper ----
export function toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderLeftColor = isErr ? 'var(--danger)' : 'var(--brand-orange)';
  el.style.opacity = '1';
  el.style.transform = 'translateY(0)';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(10px)';
  }, 2400);
}



export function logActivity(reqId, text) {
  state.activities.unshift({ reqId, date: new Date().toISOString(), text, visibleTo: ['all'] });
  saveData('activities', state.activities);
}

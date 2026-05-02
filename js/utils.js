// ============================================================
// UTILS — small UI/data helpers shared across role views
// ============================================================
import { state } from './state.js';
import { esc, escJs } from './helpers.js';
import { ICONS, RESOURCE_TYPES, STATUS_CONFIG } from './constants.js';
import { t, getStatusLabel } from './i18n.js';

// Gap 2 — Cost fields are restricted to Head of TA (and admins, who can view-as-head_ta).
// This helper centralizes the check so adding a new cost-related UI element
// only requires one role gate to remember.
export function isHeadOfTA() {
  return state.currentRole === 'head_ta' || state.currentMember?.role === 'admin';
}

// BU lookup: turn a buId into its display name. Returns 'Unknown' if missing.
// Used by detail views and lists to show BU context next to function/department.
export function getBuName(buId) {
  if (!buId) return null;
  return (state.businessUnits || []).find(b => b.id === buId)?.name || null;
}

// ============================================================
// EXEC WORKFLOW helpers
// ============================================================

// Roles that can raise reqs on behalf of execs. Used to gate the New Req
// button on HRBP / Head of TA dashboards.
export function canRaiseReqOnBehalf() {
  return ['hrbp', 'head_ta'].includes(state.currentRole) || state.currentMember?.role === 'admin';
}

// Returns list of employees marked as Function Head or CEO (for the
// "On behalf of" dropdown). Sorted with CEO first.
export function getExecAuthorities() {
  const list = (state.employeeMaps.list || []).filter(e => e.is_function_head || e.is_ceo);
  // CEO first, then FHs alphabetically
  return list.sort((a, b) => {
    if (a.is_ceo && !b.is_ceo) return -1;
    if (b.is_ceo && !a.is_ceo) return 1;
    return (a.name_en || '').localeCompare(b.name_en || '');
  });
}

// Detect if a req is an exec hire (HM is FH or CEO). Drives the routing.
// Returns one of: 'normal', 'fh_hire' (HM is a FH), 'ceo_hire' (HM is the CEO).
export function detectExecHireType(hmEmpId) {
  if (!hmEmpId) return 'normal';
  const hm = (state.employeeMaps.list || []).find(e => e.id === hmEmpId);
  if (!hm) return 'normal';
  if (hm.is_ceo) return 'ceo_hire';
  if (hm.is_function_head) return 'fh_hire';
  return 'normal';
}

// ============================================================
// UTILITIES
// ============================================================
// Resolve a user id to a display object. Checks real Supabase users (from
// tenant_members + profiles) FIRST, then falls back to employee master records
// (for supervisors/HMs who don't have a login). Returns null for unknown IDs;
// callers should use getUserName() which shows "Unknown" in that case.
export function getUser(id) {
  if (!id) return null;
  // 1. Real logged-in tenant member (auth.users.id)
  if (state.realUsersByUuid[id]) return state.realUsersByUuid[id];
  // 2. Employee from the master file (employees.id) — for supervisors/HMs
  //    who don't have a login. Normalize to the same shape as a user record.
  if (state.employeeMaps.byId[id]) {
    const e = state.employeeMaps.byId[id];
    return {
      id: e.id,
      name: e.name_en,
      role: 'employee',
      dept: e.position_title || '',
      email: e.company_email || '',
      _employee: true,
    };
  }
  return null;
}
export function getUserName(id) {
  const u = getUser(id);
  return u?.name || 'Unknown';
}
export function getUserInitials(id) {
  const u = getUser(id);
  if (!u?.name) return '?';
  return u.name.split(/\s+/).map(n => n[0]).filter(Boolean).join('').substring(0, 2).toUpperCase();
}

// Resolve the role label for a user UUID. Used by getRequesterDisplay to
// show "Tim Raksa (HRBP)" instead of just "Tim Raksa". Returns null if
// the user / role can't be resolved.
export function getUserRoleLabel(uuid) {
  if (!uuid) return null;
  const u = state.realUsersByUuid?.[uuid];
  if (!u?.role) return null;
  const labels = {
    requester: 'Requester',
    hrbp: 'HRBP',
    function_head: 'Function Head',
    ceo: 'CEO',
    head_ta: 'Head of TA',
    recruiter: 'Recruiter',
    admin: 'Admin',
  };
  return labels[u.role] || u.role;
}

// Display the requester for a requisition, with on-behalf-of context.
// - Normal req:        "Tim Raksa (HRBP)"
// - On-behalf-of req:  "Tim Raksa (HRBP, on behalf of Kang Samnang)"
// - Unknown user:      "Unknown" (no role tag, no on-behalf decoration)
export function getRequesterDisplay(r) {
  const requesterName = getUserName(r.requesterId);
  const roleLabel = getUserRoleLabel(r.requesterId);
  // Build "Name (RoleLabel)" or just "Name" if role unknown
  const base = roleLabel ? `${requesterName} (${roleLabel}` : requesterName;
  // If raised on behalf of an exec, append context to the parens
  if (r.raisedOnBehalfOfEmpId) {
    const exec = (state.employeeMaps.list || []).find(e => e.id === r.raisedOnBehalfOfEmpId);
    const execName = exec ? (exec.name_en || exec.name_kh) : 'an executive';
    return roleLabel
      ? `${base}, on behalf of ${execName})`
      : `${requesterName} (on behalf of ${execName})`;
  }
  // Normal req — close the parens if we opened them
  return roleLabel ? `${base})` : requesterName;
}

// Return tenant members whose role is in the given list. Only real Supabase
// users are considered — the demo USERS array has been retired.
export function getUsersWithRoles(roleList) {
  return Object.values(state.realUsersByUuid).filter(u => roleList.includes(u.role));
}

// ⭐ Resolve a requisition's supervisor/HM for display. Prefers the canonical
// employee record (supervisorEmpId/hmEmpId) over the legacy user_id columns.
// Falls back to legacy getUserName lookup for reqs created before Phase B.
export function getSupervisorName(r) {
  if (r.supervisorEmpId && state.employeeMaps.byId[r.supervisorEmpId]) {
    return state.employeeMaps.byId[r.supervisorEmpId].name_en;
  }
  return getUserName(r.immediateSupervisorId);
}
export function getHiringManagerName(r) {
  if (r.hmEmpId && state.employeeMaps.byId[r.hmEmpId]) {
    return state.employeeMaps.byId[r.hmEmpId].name_en;
  }
  return getUserName(r.hiringManagerId);
}

export function daysSince(dateStr) { if (!dateStr) return 0; return Math.floor((new Date() - new Date(dateStr)) / (24*60*60*1000)); }
export function daysUntil(dateStr) { if (!dateStr) return 0; return Math.floor((new Date(dateStr) - new Date()) / (24*60*60*1000)); }
export function formatDate(d) { if (!d) return '—'; return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
export function formatDateTime(d) { if (!d) return '—'; return new Date(d).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }

export function getSLAClass(days, target) {
  if (target === 0) return '';
  if (days <= target) return 'sla-good';
  if (days <= target * 1.5) return 'sla-warning';
  return 'sla-bad';
}
export function getSLATarget(status) {
  return { hrbp_review: 2, fh_approval: 2, ceo_approval: 5, ta_assignment: 2 }[status] || 0;
}
export function calculateTargetFillDate(grade, approvalDate) {
  const g = parseInt(grade.replace('G',''));
  let days = 30;
  if (g >= 6 && g <= 7) days = 45;
  else if (g >= 8) days = 60;
  const d = new Date(approvalDate);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}
export function getStageDate(r) {
  if (r.status === 'hrbp_review') return r.submittedAt;
  if (r.status === 'fh_approval') return r.hrbpApprovedAt;
  if (r.status === 'ceo_approval') return r.fhApprovedAt;
  if (r.status === 'ta_assignment') return r.ceoApprovedAt || r.fhApprovedAt;
  if (r.status === 'active_sourcing') return r.taAssignedAt;
  return r.submittedAt;
}
export function getCurrentOwner(r) {
  if (r.status === 'hrbp_review') return t('role_hrbp');
  if (r.status === 'fh_approval') return t('role_function_head');
  if (r.status === 'ceo_approval') return t('role_ceo');
  if (r.status === 'ta_assignment') return t('role_head_ta');
  if (r.status === 'active_sourcing') return r.assignedRecruiters.length === 0 ? 'Unassigned' : r.assignedRecruiters.map(getUserName).join(', ');
  if (r.status === 'pending_close') return t('role_hrbp');
  if (r.status === 'on_hold') return getUserName(r.requesterId);
  if (r.status === 'cancelled') return '—';
  return '—';
}

export function statusBadge(status) {
  const cfg = STATUS_CONFIG[status] || { label: status, color: '#73726c', bg: '#f3f1ea' };
  const label = getStatusLabel(status);
  return `<span class="stage-tag" style="background: ${cfg.bg}; color: ${cfg.color};"><span class="stage-tag-dot" style="background: ${cfg.color};"></span>${label}</span>`;
}

// Render the resources-required block for any detail view (requester/HRBP/FH/CEO/Head TA).
// Returns an HTML string. Empty resources render as a muted "none requested" hint.
export function renderResourcesBlock(r) {
  const res = r.resourcesRequired || { items: [], other: null };
  const items = Array.isArray(res.items) ? res.items : [];
  if (items.length === 0) {
    return `
      <div class="detail-block">
        <div class="detail-label">${t('lbl_resources_detail')}</div>
        <div class="detail-value" style="color: var(--ink-3); font-style: italic;">${t('resources_none')}</div>
      </div>
    `;
  }
  const pillStyle = 'display:inline-flex; align-items:center; gap:0.35rem; padding:0.25rem 0.6rem; background: var(--brand-orange-soft); color: var(--brand-navy); border: 1px solid var(--brand-orange-border); border-radius: 999px; font-size: 0.85rem; margin: 0.15rem 0.3rem 0.15rem 0;';
  const chips = items
    .filter(k => k !== 'other')
    .map(k => {
      const entry = RESOURCE_TYPES.find(x => x.key === k);
      const label = entry ? t(entry.tKey) : k;
      return `<span style="${pillStyle}">${label}</span>`;
    })
    .join('');
  const otherChip = items.includes('other') && res.other
    ? `<span style="${pillStyle}">${t('res_other')}: ${res.other}</span>`
    : '';
  return `
    <div class="detail-block">
      <div class="detail-label">${t('lbl_resources_detail')}</div>
      <div class="detail-value" style="line-height: 2;">${chips}${otherChip}</div>
    </div>
  `;
}

// generateReqId / generateCandidateId now live in js/helpers.js

// ============================================================
// MODAL
// ============================================================
export function openModal(html) {
  document.getElementById('modalContent').innerHTML = html;
  document.getElementById('modalOverlay').classList.add('active');
}
export function closeModal() { document.getElementById('modalOverlay').classList.remove('active'); }
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'modalOverlay') closeModal();
});

export function renderReqRow(r) {
  const days = daysSince(getStageDate(r));
  const target = getSLATarget(r.status);
  const slaClass = target > 0 ? getSLAClass(days, target) : '';
  const dSuffix = t('txt_days').charAt(0);

  // For active_sourcing reqs, compute per-stage candidate counts so the Requester
  // can see progress at a glance without clicking into the detail view.
  let pipelineChips = '';
  if (r.status === 'active_sourcing') {
    const reqCands = state.candidates.filter(c => c.reqId === r.id && c.status === 'active');
    const counts = {
      sourcing:     reqCands.filter(c => c.stage === 'sourcing').length,
      screening:    reqCands.filter(c => c.stage === 'screening').length,
      interview:    reqCands.filter(c => c.stage === 'interview').length,
      preemployment:reqCands.filter(c => c.stage === 'preemployment').length,
      offer:        reqCands.filter(c => c.stage === 'offer').length,
    };
    const labels = {
      sourcing: t('metric_sourcing'),
      screening: t('stage_screening') || 'Screening',
      interview: t('metric_interviews'),
      preemployment: t('btn_pre_emp'),
      offer: t('btn_offer'),
    };
    const nonZero = Object.entries(counts).filter(([, n]) => n > 0);
    if (reqCands.length === 0) {
      pipelineChips = `<div class="role-meta" style="margin-top: 0.25rem; color: var(--ink-4);">No candidates yet</div>`;
    } else {
      pipelineChips = `<div class="role-meta" style="margin-top: 0.25rem;">${nonZero.map(([k, n]) => `${labels[k]}: <strong>${n}</strong>`).join(' · ')}</div>`;
    }
  }

  return `
    <tr class="clickable" onclick="viewReq('${escJs(r.id)}')">
      <td>
        <span class="req-id">${esc(r.id)}</span>
        ${r.approvalPath === 'ceo_required' ? '<span class="badge badge-ceo" style="margin-left: 0.4rem;">CEO</span>' : ''}
      </td>
      <td>
        <div class="role-title">${esc(r.roleTitle)}</div>
        <div class="role-meta">${esc([getBuName(r.buId), r.function, r.grade].filter(Boolean).join(" · "))}</div>
        ${pipelineChips}
      </td>
      <td>${statusBadge(r.status)}</td>
      <td><span class="text-sm">${esc(getCurrentOwner(r))}</span></td>
      <td>
        <div class="sla-indicator ${slaClass}">
          <span class="sla-value">${days}${dSuffix}</span>
          ${target > 0 ? `<span class="sla-target">/ ${target}${dSuffix}</span>` : ''}
        </div>
      </td>
    </tr>
  `;
}


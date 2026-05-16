// ============================================================
// TELEGRAM NOTIFICATIONS — client side
// ============================================================
// IMPORTANT: the backend (DB schema, RPCs, Edge Functions, Database
// Webhook) is ALREADY DEPLOYED on Supabase project uwaamlyvvzuhoznlrbhz.
// This file is written to match that deployed contract exactly — do not
// "fix" it to some other shape without checking the live DB. The
// contract is captured in docs/v41_telegram_contract.md.
//
//   RPCs (SECURITY DEFINER, callable by authenticated):
//     telegram_mint_link_token()            -> link code (text)
//     telegram_unlink()                     -> void
//     telegram_toggle_notifications(enabled) -> void
//
//   notification_queue columns the client writes:
//     tenant_id            uuid
//     recipient_profile_id uuid   (== profiles.id == tenant_members.user_id)
//     event_type           text   (see EVENT_* below)
//     event_data           jsonb  (rendered into a message by telegram-notify)
//
//   profiles columns (read for status):
//     telegram_chat_id, telegram_username, telegram_notifications_enabled
//
// Two responsibilities: (1) the connect/disconnect/toggle UI, and (2)
// dispatchWorkflowNotification(), called from persistReqChange /
// persistCandidateChange after a successful save. Everything is
// best-effort: a notification failure must never break the workflow
// action that triggered it.

import { sb, TELEGRAM_BOT_USERNAME } from './config.js';
import { state } from './state.js';
import { esc } from './helpers.js';
import { openModal, closeModal, getUserName } from './utils.js';
import { toast } from './storage.js';

const tg = { linked: false, username: null, enabled: true, loaded: false };

export async function loadTelegramStatus() {
  try {
    const uid = state.currentAuthUser?.id;
    if (!uid) return;
    const { data } = await sb
      .from('profiles')
      .select('telegram_chat_id, telegram_username, telegram_notifications_enabled')
      .eq('id', uid)
      .single();
    tg.linked = !!data?.telegram_chat_id;
    tg.username = data?.telegram_username || null;
    tg.enabled = data?.telegram_notifications_enabled !== false;
    tg.loaded = true;
  } catch (e) {
    console.warn('[notify] loadTelegramStatus failed', e);
  }
}

// ------------------------------------------------------------
// Connection UI
// ------------------------------------------------------------
export function renderNotificationsView() {
  const main = document.getElementById('mainView');
  if (!main) return;

  const botConfigured = !!TELEGRAM_BOT_USERNAME && TELEGRAM_BOT_USERNAME !== 'CHANGE_ME';

  const statusRow = tg.linked
    ? `<div style="display:flex; align-items:center; gap:0.5rem; color: var(--brand-ironclad, #2d7a4f); font-weight:600;">
         <span style="font-size:18px;">✅</span>
         <span>Connected${tg.username ? ' as ' + esc(tg.username) : ''}</span>
       </div>`
    : `<div style="display:flex; align-items:center; gap:0.5rem; color: var(--ink-3, #73726c);">
         <span style="font-size:18px;">○</span><span>Not connected</span>
       </div>`;

  const actions = tg.linked
    ? `<div style="display:flex; gap:0.6rem; flex-wrap:wrap; align-items:center;">
         <label style="display:flex; align-items:center; gap:0.4rem; font-size:13px; cursor:pointer;">
           <input type="checkbox" id="tgEnabledToggle" ${tg.enabled ? 'checked' : ''}
             onchange="toggleTelegramNotifications(this.checked)">
           Send me notifications
         </label>
         <button class="role-btn" onclick="disconnectTelegram()"
           style="border:1px solid var(--rule-dark); padding:6px 12px; border-radius:6px; cursor:pointer; background:transparent;">
           Disconnect
         </button>
       </div>`
    : (botConfigured
        ? `<button class="role-btn" onclick="connectTelegram()"
             style="background: var(--brand-navy, #011e41); color:#fff; border:none; padding:9px 16px; border-radius:6px; cursor:pointer; font-weight:500;">
             Connect Telegram
           </button>`
        : `<div style="background: var(--danger-bg,#fdecec); color: var(--danger,#b91c1c); padding:0.7rem 0.9rem; border-radius:6px; font-size:13px; border-left:3px solid var(--danger,#b91c1c);">
             Telegram bot not configured. Set <code>TELEGRAM_BOT_USERNAME</code> in <code>js/config.js</code>.
           </div>`);

  main.innerHTML = `
    <div style="max-width: 640px; margin: 1.5rem auto;">
      <button class="role-btn" onclick="setView('dashboard')"
        style="border:1px solid var(--rule-dark); padding:5px 12px; border-radius:6px; cursor:pointer; background:transparent; margin-bottom:1.25rem;">
        ← Dashboard
      </button>
      <div style="background: var(--paper,#fff); border:1px solid var(--rule,#e5e3da); border-radius:10px; padding:1.5rem;">
        <h2 style="margin:0 0 0.4rem; font-size:1.2rem;">Telegram notifications</h2>
        <p style="margin:0 0 1.25rem; color: var(--ink-3,#73726c); font-size:13.5px; line-height:1.5;">
          Get a Telegram message the moment something needs you: an approval in your
          queue, a status change on your requisition, a candidate moving stage, or an
          interview being scheduled.
        </p>
        <div style="display:flex; justify-content:space-between; align-items:center; gap:1rem; padding:0.9rem 0; border-top:1px solid var(--rule,#e5e3da); flex-wrap:wrap;">
          ${statusRow}
          ${actions}
        </div>
      </div>
    </div>`;
}

// telegram_mint_link_token() may return the code as plain text, a
// single-row table, or json — be tolerant of all three.
function extractToken(data) {
  if (!data) return null;
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) {
    const row = data[0];
    return typeof row === 'string' ? row : (row?.token || row?.code || null);
  }
  return data.token || data.code || null;
}

export async function connectTelegram() {
  try {
    toast('Generating secure link…');
    const { data, error } = await sb.rpc('telegram_mint_link_token');
    if (error) throw error;
    const token = extractToken(data);
    if (!token) throw new Error('no token returned');

    const url = `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${encodeURIComponent(token)}`;
    openModal(`
      <div style="max-width:460px;">
        <h3 style="margin:0 0 0.6rem;">Connect Telegram</h3>
        <p style="color: var(--ink-3,#73726c); font-size:13.5px; line-height:1.5; margin:0 0 1rem;">
          Tap the button — Telegram opens our bot, press <b>Start</b> and you're
          connected. This code works once and expires in 15 minutes.
        </p>
        <a href="${esc(url)}" target="_blank" rel="noopener"
          style="display:inline-block; background: var(--brand-navy,#011e41); color:#fff; text-decoration:none; padding:10px 18px; border-radius:6px; font-weight:500;">
          Open Telegram &amp; connect
        </a>
        <p style="font-size:13px; color: var(--ink-3,#73726c); margin:1.1rem 0 0.3rem;">
          Or message <b>@${esc(TELEGRAM_BOT_USERNAME)}</b> manually:
        </p>
        <code style="display:inline-block; background: var(--rule,#f3f1ea); padding:6px 10px; border-radius:5px; font-size:14px; user-select:all;">/start ${esc(token)}</code>
        <div style="margin-top:1.25rem; text-align:right;">
          <button class="role-btn" onclick="closeModal(); refreshTelegramAfterConnect()"
            style="border:1px solid var(--rule-dark); padding:6px 14px; border-radius:6px; cursor:pointer; background:transparent;">
            Done
          </button>
        </div>
      </div>`);
    window.open(url, '_blank', 'noopener');
  } catch (e) {
    console.error('connectTelegram failed', e);
    toast('Could not start linking: ' + (e.message || e), true);
  }
}

export async function refreshTelegramAfterConnect() {
  await loadTelegramStatus();
  if (state.currentView === 'notifications') renderNotificationsView();
}

export async function disconnectTelegram() {
  try {
    const { error } = await sb.rpc('telegram_unlink');
    if (error) throw error;
    tg.linked = false;
    tg.username = null;
    toast('Telegram disconnected');
    renderNotificationsView();
  } catch (e) {
    console.error('disconnectTelegram failed', e);
    toast('Could not disconnect: ' + (e.message || e), true);
  }
}

export async function toggleTelegramNotifications(enabled) {
  try {
    const { error } = await sb.rpc('telegram_toggle_notifications', { enabled: !!enabled });
    if (error) throw error;
    tg.enabled = !!enabled;
    toast(enabled ? 'Notifications on' : 'Notifications paused');
  } catch (e) {
    console.error('toggleTelegramNotifications failed', e);
    toast('Could not update preference: ' + (e.message || e), true);
    await loadTelegramStatus();
    if (state.currentView === 'notifications') renderNotificationsView();
  }
}

// ------------------------------------------------------------
// Recipient routing — realUsersByUuid is keyed by tenant_members.user_id
// which equals profiles.id (== notification_queue.recipient_profile_id).
// ------------------------------------------------------------
function usersWithRole(roles) {
  return Object.values(state.realUsersByUuid || {})
    .filter(u => roles.includes(u.role))
    .map(u => u.id);
}
function requesterIds(r) {
  return [r?.realRequesterId, r?.requesterId].filter(Boolean);
}
function recruiterIds(r) {
  return Array.isArray(r?.assignedRecruiters) ? r.assignedRecruiters.filter(Boolean) : [];
}
function reqRoleTitle(r) {
  return r?.roleTitle || r?.title || r?.id || 'Requisition';
}
function reqDept(r) {
  return r?.function || r?.subFunction || r?.unit || '';
}

// req.status -> { event_type, audience, roles? }
// Maps the app's workflow statuses onto the backend's documented
// event_type vocabulary (see docs/v41_telegram_contract.md).
const REQ_ROUTING = {
  hrbp_review:         { event: 'requisition_submitted',      audience: 'role', roles: ['hrbp'] },
  fh_approval:         { event: 'requisition_submitted',      audience: 'role', roles: ['function_head'] },
  ceo_approval:        { event: 'requisition_submitted',      audience: 'role', roles: ['ceo', 'group_ceo'] },
  ta_assignment:       { event: 'requisition_submitted',      audience: 'role', roles: ['head_ta'] },
  active_sourcing:     { event: 'requisition_approved',       audience: 'requester+recruiters' },
  rejected:            { event: 'requisition_rejected',       audience: 'requester' },
  revisions_requested: { event: 'requisition_status_changed', audience: 'requester' },
  on_hold:             { event: 'requisition_status_changed', audience: 'requester' },
  cancelled:           { event: 'requisition_status_changed', audience: 'requester' },
  closed:              { event: 'requisition_status_changed', audience: 'requester+recruiters' },
};

async function enqueue(rows) {
  const actor = state.currentAuthUser?.id || null;
  const known = state.realUsersByUuid || {};
  const seen = new Set();
  const clean = [];
  for (const row of rows) {
    const rid = row.recipient_profile_id;
    if (!rid || rid === actor) continue;       // never self-notify
    if (!known[rid]) continue;                  // guard the FK to profiles
    const k = rid + '|' + row.event_type;
    if (seen.has(k)) continue;
    seen.add(k);
    clean.push(row);
  }
  if (!clean.length) return;
  try {
    const { error } = await sb.from('notification_queue').insert(clean);
    if (error) console.warn('[notify] enqueue failed', error);
  } catch (e) {
    console.warn('[notify] enqueue threw', e);
  }
}

function buildRows(recipients, eventType, eventData) {
  return recipients.map(pid => ({
    tenant_id: state.currentTenantId,
    recipient_profile_id: pid,
    event_type: eventType,
    event_data: eventData,
  }));
}

// Called from storage.js after a successful save. `kind` is 'req' or
// 'candidate'. Never throws.
export async function dispatchWorkflowNotification(kind, entity, activityText) {
  try {
    if (!state.currentTenantId || !entity) return;

    if (kind === 'req') {
      const r = entity;
      const route = REQ_ROUTING[r.status];
      if (!route) return;

      let recipients = [];
      if (route.audience === 'role') recipients = usersWithRole(route.roles);
      else if (route.audience === 'requester') recipients = requesterIds(r);
      else if (route.audience === 'requester+recruiters') recipients = [...requesterIds(r), ...recruiterIds(r)];

      const eventData = {
        role_title: reqRoleTitle(r),
        department_name: reqDept(r),
        requester_name: getUserName(r.requesterId) || '',
        req_code: r.id || '',
        status: r.status,
        urgency: r.isPlanned === false ? 'Unplanned' : 'Planned',
        note: activityText || '',
      };
      await enqueue(buildRows(recipients, route.event, eventData));
      return;
    }

    if (kind === 'candidate') {
      const c = entity;
      const r = (state.requisitions || []).find(x => x.id === c.reqId);
      const recipients = [...requesterIds(r), ...recruiterIds(r)];
      if (!recipients.length) return;

      const txt = (activityText || '').toLowerCase();
      const eventType = (txt.includes('interview scheduled') || txt.includes('interview step'))
        ? 'interview_scheduled'
        : 'candidate_status_changed';

      const eventData = {
        candidate_name: c.name || 'Candidate',
        role_title: reqRoleTitle(r),
        req_code: r?.id || '',
        stage: c.stage || '',
        status: c.status || '',
        note: activityText || '',
      };
      await enqueue(buildRows(recipients, eventType, eventData));
      return;
    }
  } catch (e) {
    console.warn('[notify] dispatch failed', e);
  }
}

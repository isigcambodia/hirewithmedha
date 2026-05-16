// ============================================================
// TELEGRAM NOTIFICATIONS — client side
// ============================================================
// The backend (DB schema, RPCs, Edge Functions, Database Webhook) is
// ALREADY DEPLOYED on Supabase project uwaamlyvvzuhoznlrbhz. This file
// matches that deployed contract exactly — see
// docs/v41_telegram_contract.md. Do not run any SQL/Edge Function from
// this repo; there is none.
//
//   Link code:  supabase.functions.invoke('telegram-link-code')
//               -> { code, bot_username, deep_link, instructions,
//                    already_linked, linked_at }
//   Disconnect: rpc('telegram_unlink')
//   Toggle:     rpc('telegram_toggle_notifications', { enabled })
//   Status:     profiles.telegram_chat_id / _username / _linked_at /
//               _notifications_enabled  (polled every 3s while linking)
//
//   notification_queue insert (one row per recipient):
//     tenant_id, recipient_profile_id, event_type, event_data(jsonb)
//
// Connect/UI is a 3-state machine (not linked → pending → linked) with
// auto-polling. dispatchWorkflowNotification() (called from
// persistReqChange / persistCandidateChange) is best-effort and never
// blocks the workflow action.

import { sb, TELEGRAM_BOT_USERNAME } from './config.js';
import { state } from './state.js';
import { esc } from './helpers.js';
import { openModal, closeModal, getUserName } from './utils.js';
import { toast } from './storage.js';

const LINK_FUNCTION = 'telegram-link-code';
const POLL_MS = 3000;
const POLL_WINDOW_MS = 120000; // stop auto-polling after 2 min

const tg = {
  linked: false,
  username: null,
  enabled: true,
  linkedAt: null,
  loaded: false,
};

// Active pending-link attempt (State 2), or null.
let pending = null;        // { code, deepLink, instructions, expired }
let pollTimer = null;
let pollDeadline = 0;

export async function loadTelegramStatus() {
  try {
    const uid = state.currentAuthUser?.id;
    if (!uid) return;
    const { data } = await sb
      .from('profiles')
      .select('telegram_chat_id, telegram_username, telegram_linked_at, telegram_notifications_enabled')
      .eq('id', uid)
      .single();
    tg.linked = !!data?.telegram_chat_id;
    tg.username = data?.telegram_username || null;
    tg.linkedAt = data?.telegram_linked_at || null;
    tg.enabled = data?.telegram_notifications_enabled !== false;
    tg.loaded = true;
  } catch (e) {
    console.warn('[notify] loadTelegramStatus failed', e);
  }
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
}

// ------------------------------------------------------------
// 3-state view
// ------------------------------------------------------------
export function renderNotificationsView() {
  const main = document.getElementById('mainView');
  if (!main) return;

  const botConfigured = !!TELEGRAM_BOT_USERNAME && TELEGRAM_BOT_USERNAME !== 'CHANGE_ME';

  let body;
  if (tg.linked) {
    body = stateLinked();
  } else if (pending) {
    body = statePending();
  } else if (botConfigured) {
    body = stateNotLinked();
  } else {
    body = `<div style="background: var(--danger-bg,#fdecec); color: var(--danger,#b91c1c); padding:0.7rem 0.9rem; border-radius:6px; font-size:13px; border-left:3px solid var(--danger,#b91c1c);">
      Telegram bot not configured. Set <code>TELEGRAM_BOT_USERNAME</code> in <code>js/config.js</code>.
    </div>`;
  }

  main.innerHTML = `
    <div style="max-width: 640px; margin: 1.5rem auto;">
      <button class="role-btn" onclick="leaveNotifications()"
        style="border:1px solid var(--rule-dark); padding:5px 12px; border-radius:6px; cursor:pointer; background:transparent; margin-bottom:1.25rem;">
        ← Dashboard
      </button>
      <div style="background: var(--paper,#fff); border:1px solid var(--rule,#e5e3da); border-radius:10px; padding:1.5rem;">
        <h2 style="margin:0 0 0.4rem; font-size:1.2rem;">🔔 Telegram notifications</h2>
        <p style="margin:0 0 1rem; color: var(--ink-3,#73726c); font-size:13.5px; line-height:1.5;">
          Get real-time updates on your phone when requisitions are approved or
          rejected, candidates move stage, and interviews are scheduled.
        </p>
        <ul style="margin:0 0 1.25rem 1.1rem; padding:0; color: var(--ink-3,#73726c); font-size:13px; line-height:1.7;">
          <li>Requisition approvals &amp; rejections</li>
          <li>Candidate status updates</li>
          <li>Interview schedules</li>
        </ul>
        <p style="margin:0 0 1.25rem; color: var(--ink-4,#a8a69d); font-size:12px;">
          You won't be notified about actions you perform yourself.
        </p>
        <div style="border-top:1px solid var(--rule,#e5e3da); padding-top:1.1rem;">
          ${body}
        </div>
      </div>
    </div>`;
}

function stateNotLinked() {
  return `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap;">
      <div style="display:flex; align-items:center; gap:0.5rem; color: var(--ink-3,#73726c);">
        <span style="font-size:18px;">○</span><span>Not connected</span>
      </div>
      <button class="role-btn" onclick="connectTelegram()"
        style="background: var(--brand-navy,#011e41); color:#fff; border:none; padding:9px 16px; border-radius:6px; cursor:pointer; font-weight:500;">
        Connect Telegram
      </button>
    </div>`;
}

function statePending() {
  const code = esc(pending.code);
  const deep = esc(pending.deepLink);
  const expiredBanner = pending.expired
    ? `<div style="background: var(--warn-bg,#fef5e7); color: var(--warn,#b45309); padding:0.6rem 0.8rem; border-radius:6px; font-size:12.5px; margin:0.9rem 0;">
         Still waiting? Codes expire after 15 minutes.
         <button class="role-btn" onclick="connectTelegram()" style="margin-left:0.4rem; border:1px solid currentColor; padding:3px 9px; border-radius:5px; cursor:pointer; background:transparent;">Generate new code</button>
       </div>`
    : `<p style="font-size:12.5px; color: var(--ink-3,#73726c); margin:0.9rem 0 0;">⏳ Waiting for confirmation…</p>`;

  return `
    <h3 style="margin:0 0 0.3rem; font-size:1rem;">Link your account</h3>
    <p style="color: var(--ink-3,#73726c); font-size:13px; margin:0 0 0.9rem;">
      Tap the button — Telegram opens our bot, press <b>Start</b> and you're connected.
    </p>
    <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap; margin-bottom:0.9rem;">
      <code style="background: var(--rule,#f3f1ea); padding:8px 14px; border-radius:6px; font-size:18px; letter-spacing:2px; user-select:all;">${code}</code>
      <button class="role-btn" onclick="copyTelegramCode()"
        style="border:1px solid var(--rule-dark); padding:6px 12px; border-radius:6px; cursor:pointer; background:transparent;">Copy</button>
    </div>
    <a href="${deep}" target="_blank" rel="noopener"
      style="display:inline-block; background: var(--brand-navy,#011e41); color:#fff; text-decoration:none; padding:10px 18px; border-radius:6px; font-weight:500;">
      📱 Open in Telegram
    </a>
    <p style="font-size:12.5px; color: var(--ink-3,#73726c); margin:1rem 0 0;">
      Or open Telegram, find <b>@${esc(TELEGRAM_BOT_USERNAME)}</b> and send:
      <code style="background: var(--rule,#f3f1ea); padding:2px 6px; border-radius:4px;">/start ${code}</code>
    </p>
    ${expiredBanner}`;
}

function stateLinked() {
  return `
    <div style="display:flex; align-items:center; gap:0.5rem; color: var(--brand-ironclad,#2d7a4f); font-weight:600; margin-bottom:1rem;">
      <span style="font-size:18px;">✅</span>
      <span>Connected${tg.username ? ' as ' + esc(tg.username) : ''}${tg.linkedAt ? ' · since ' + esc(fmtDate(tg.linkedAt)) : ''}</span>
    </div>
    <label style="display:flex; align-items:center; gap:0.45rem; font-size:13px; cursor:pointer; margin-bottom:1rem;">
      <input type="checkbox" id="tgEnabledToggle" ${tg.enabled ? 'checked' : ''}
        onchange="toggleTelegramNotifications(this.checked)">
      Receive notifications
    </label>
    <button class="role-btn" onclick="disconnectTelegram()"
      style="border:1px solid var(--danger,#b91c1c); color: var(--danger,#b91c1c); padding:6px 14px; border-radius:6px; cursor:pointer; background:transparent;">
      Disconnect Telegram
    </button>
    <p style="font-size:12px; color: var(--ink-4,#a8a69d); margin:0.9rem 0 0;">
      You can also send <code>/stop</code> to @${esc(TELEGRAM_BOT_USERNAME)} to disconnect.
    </p>`;
}

// ------------------------------------------------------------
// Connect flow + polling
// ------------------------------------------------------------
export async function connectTelegram() {
  try {
    toast('Generating link code…');
    const { data, error } = await sb.functions.invoke(LINK_FUNCTION, { body: {} });
    if (error) throw error;
    if (!data || (!data.code && !data.deep_link)) throw new Error('unexpected response');

    if (data.already_linked) {
      await loadTelegramStatus();
      tg.linked = true;
      if (data.linked_at) tg.linkedAt = data.linked_at;
      pending = null;
      stopLinkPolling();
      if (state.currentView === 'notifications') renderNotificationsView();
      toast('Telegram already connected');
      return;
    }

    const code = data.code;
    pending = {
      code,
      deepLink: data.deep_link
        || `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${encodeURIComponent(code)}`,
      instructions: data.instructions || '',
      expired: false,
    };
    if (state.currentView === 'notifications') renderNotificationsView();
    startLinkPolling();
  } catch (e) {
    console.error('connectTelegram failed', e);
    toast('Could not generate link code. Please try again.', true);
  }
}

export function copyTelegramCode() {
  if (!pending?.code) return;
  try {
    navigator.clipboard?.writeText(pending.code);
    toast('Code copied');
  } catch {
    toast('Copy failed — select it manually', true);
  }
}

function startLinkPolling() {
  stopLinkPolling();
  pollDeadline = Date.now() + POLL_WINDOW_MS;
  pollTimer = setInterval(async () => {
    // Stop if the user navigated away from the page.
    if (state.currentView !== 'notifications') { stopLinkPolling(); return; }
    if (Date.now() > pollDeadline) {
      stopLinkPolling();
      if (pending) pending.expired = true;
      if (state.currentView === 'notifications') renderNotificationsView();
      return;
    }
    try {
      const uid = state.currentAuthUser?.id;
      if (!uid) return;
      const { data } = await sb
        .from('profiles')
        .select('telegram_chat_id, telegram_username, telegram_linked_at, telegram_notifications_enabled')
        .eq('id', uid)
        .single();
      if (data?.telegram_chat_id) {
        tg.linked = true;
        tg.username = data.telegram_username || null;
        tg.linkedAt = data.telegram_linked_at || null;
        tg.enabled = data.telegram_notifications_enabled !== false;
        pending = null;
        stopLinkPolling();
        toast('Telegram connected');
        if (state.currentView === 'notifications') renderNotificationsView();
      }
    } catch (e) {
      // Transient — keep polling until the deadline.
    }
  }, POLL_MS);
}

function stopLinkPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// Leaving the page must cancel any in-flight pending attempt + polling.
export function leaveNotifications() {
  stopLinkPolling();
  pending = null;
  if (window.setView) window.setView('dashboard');
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
    tg.linkedAt = null;
    pending = null;
    stopLinkPolling();
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

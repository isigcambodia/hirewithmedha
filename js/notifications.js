// ============================================================
// TELEGRAM NOTIFICATIONS — client side
// ============================================================
// Two responsibilities:
//
//  1. Connection UI (renderNotificationsView / connect / disconnect /
//     toggle). The user mints a one-time link token via the
//     create_telegram_link_token RPC and taps a t.me deep link; the
//     telegram-webhook Edge Function binds their chat to their profile.
//
//  2. Workflow dispatch. dispatchWorkflowNotification() is called from
//     persistReqChange / persistCandidateChange after a successful save.
//     It works out who cares about the event and drops one row per
//     recipient into notification_queue. A Supabase Database Webhook on
//     that table calls the telegram-notify Edge Function which actually
//     delivers the message. Everything here is best-effort: a failure
//     to enqueue must never break the workflow action that triggered it.
//
// This module deliberately does NOT import storage.js for anything other
// than toast() (a hoisted function), keeping the storage<->notifications
// cycle harmless.

import { sb, TELEGRAM_BOT_USERNAME } from './config.js';
import { state } from './state.js';
import { esc } from './helpers.js';
import { openModal, closeModal } from './utils.js';
import { toast } from './storage.js';

// ---- connection state cache (loaded at boot, refreshed on change) ----
const tg = {
  linked: false,
  username: null,
  enabled: true,
  loaded: false,
};

// Pull the current user's Telegram link state. The app already reads
// its own profile row at boot, so SELECT on own profile is permitted.
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
             Telegram bot not configured yet. Set <code>TELEGRAM_BOT_USERNAME</code> in <code>js/config.js</code>
             and finish the steps in <code>docs/v41_telegram_setup.md</code>.
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

export async function connectTelegram() {
  try {
    toast('Generating secure link…');
    const { data: token, error } = await sb.rpc('create_telegram_link_token');
    if (error || !token) throw error || new Error('no token');

    const url = `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${encodeURIComponent(token)}`;
    openModal(`
      <div style="max-width:440px;">
        <h3 style="margin:0 0 0.6rem;">Connect Telegram</h3>
        <p style="color: var(--ink-3,#73726c); font-size:13.5px; line-height:1.5; margin:0 0 1rem;">
          Tap the button below. Telegram opens with our bot — press <b>Start</b> and
          you're connected. This link expires in 15 minutes and works once.
        </p>
        <a href="${esc(url)}" target="_blank" rel="noopener"
          style="display:inline-block; background: var(--brand-navy,#011e41); color:#fff; text-decoration:none; padding:10px 18px; border-radius:6px; font-weight:500;">
          Open Telegram &amp; connect
        </a>
        <p style="font-size:12px; color: var(--ink-4,#a8a69d); margin:1rem 0 0; word-break:break-all;">
          Or open this link on the device with Telegram:<br>${esc(url)}
        </p>
        <div style="margin-top:1.25rem; text-align:right;">
          <button class="role-btn" onclick="closeModal(); refreshTelegramAfterConnect()"
            style="border:1px solid var(--rule-dark); padding:6px 14px; border-radius:6px; cursor:pointer; background:transparent;">
            Done
          </button>
        </div>
      </div>`);
    // Best effort: also try to navigate there directly on mobile.
    window.open(url, '_blank', 'noopener');
  } catch (e) {
    console.error('connectTelegram failed', e);
    toast('Could not start linking: ' + (e.message || e), true);
  }
}

// Called from the "Done" button — re-reads link state then re-renders
// the Notifications view so the user sees "Connected" without a reload.
export async function refreshTelegramAfterConnect() {
  await loadTelegramStatus();
  if (state.currentView === 'notifications') renderNotificationsView();
}

export async function disconnectTelegram() {
  try {
    const { error } = await sb.rpc('unlink_telegram');
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
    const { error } = await sb.rpc('set_telegram_enabled', { p_enabled: !!enabled });
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
// Recipient routing
// ------------------------------------------------------------
// realUsersByUuid is keyed by tenant_members.user_id, which equals
// profiles.id (== notification_queue.recipient_user_id). Each value:
// { id, name, email, role }.

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

// status -> { roles | requester/recruiters, title }
const REQ_STATUS_ROUTING = {
  hrbp_review:         { audience: 'role', roles: ['hrbp'],                    title: 'Approval needed — HRBP review' },
  fh_approval:         { audience: 'role', roles: ['function_head'],           title: 'Approval needed — Function Head' },
  ceo_approval:        { audience: 'role', roles: ['ceo', 'group_ceo'],        title: 'Approval needed — CEO' },
  ta_assignment:       { audience: 'role', roles: ['head_ta'],                 title: 'Approval needed — TA assignment' },
  revisions_requested: { audience: 'requester',               title: 'Revisions requested' },
  rejected:            { audience: 'requester',               title: 'Requisition rejected' },
  active_sourcing:     { audience: 'requester+recruiters',     title: 'Requisition approved — sourcing started' },
  on_hold:             { audience: 'requester',               title: 'Requisition put on hold' },
  cancelled:           { audience: 'requester',               title: 'Requisition cancelled' },
  closed:              { audience: 'requester+recruiters',     title: 'Requisition closed — filled' },
};

function reqTitle(r) {
  return r?.title || r?.roleTitle || r?.position || r?.id || 'Requisition';
}

// ------------------------------------------------------------
// Enqueue
// ------------------------------------------------------------
async function enqueue(rows) {
  // Dedup recipients, drop the actor (no self-notifications), drop empties.
  const actor = state.currentAuthUser?.id || null;
  const known = state.realUsersByUuid || {};
  const seen = new Set();
  const clean = [];
  for (const row of rows) {
    if (!row.recipient_user_id) continue;
    if (row.recipient_user_id === actor) continue;
    // Only enqueue for known tenant members — guards the FK to
    // profiles so one stale uuid can't fail the whole batch insert.
    if (!known[row.recipient_user_id]) continue;
    const k = row.recipient_user_id + '|' + row.event_type + '|' + row.title;
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

function buildRows(recipients, { eventType, title, body }) {
  const link = (typeof location !== 'undefined' && location.origin) ? location.origin : null;
  return recipients.map(uid => ({
    tenant_id: state.currentTenantId,
    recipient_user_id: uid,
    event_type: eventType,
    title,
    body,
    link_url: link,
  }));
}

// ------------------------------------------------------------
// Public dispatch — called from storage.js after a successful save.
// `kind` is 'req' or 'candidate'. Never throws.
// ------------------------------------------------------------
export async function dispatchWorkflowNotification(kind, entity, activityText) {
  try {
    if (!state.currentTenantId || !entity) return;

    if (kind === 'req') {
      const r = entity;
      const route = REQ_STATUS_ROUTING[r.status];
      if (!route) return;

      let recipients = [];
      if (route.audience === 'role') {
        recipients = usersWithRole(route.roles);
      } else if (route.audience === 'requester') {
        recipients = requesterIds(r);
      } else if (route.audience === 'requester+recruiters') {
        recipients = [...requesterIds(r), ...recruiterIds(r)];
      }

      const body = `${reqTitle(r)}${activityText ? '\n' + activityText : ''}`;
      await enqueue(buildRows(recipients, {
        eventType: 'req_' + r.status,
        title: route.title,
        body,
      }));
      return;
    }

    if (kind === 'candidate') {
      const c = entity;
      const r = (state.requisitions || []).find(x => x.id === c.reqId);
      const recipients = [...requesterIds(r), ...recruiterIds(r)];
      if (!recipients.length) return;

      const txt = (activityText || '').toLowerCase();
      let title = 'Candidate update';
      let eventType = 'candidate_stage';
      if (txt.includes('interview scheduled') || txt.includes('interview step')) {
        title = 'Interview scheduled';
        eventType = 'interview_scheduled';
      } else if (txt.includes('offer')) {
        title = 'Offer update';
        eventType = 'candidate_offer';
      } else if (c.status === 'rejected' || txt.includes('rejected')) {
        title = 'Candidate rejected';
        eventType = 'candidate_rejected';
      } else if (c.stage === 'hired' || txt.includes('hired') || txt.includes('filled')) {
        title = 'Candidate hired';
        eventType = 'candidate_hired';
      }

      const candName = c.name || c.fullName || 'Candidate';
      const body = `${candName} — ${reqTitle(r)}${activityText ? '\n' + activityText : ''}`;
      await enqueue(buildRows(recipients, { eventType, title, body }));
      return;
    }
  } catch (e) {
    // Notifications must never break the workflow action.
    console.warn('[notify] dispatch failed', e);
  }
}

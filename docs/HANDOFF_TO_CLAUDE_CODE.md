# Telegram Notifications - Backend Setup Complete ✅
## Handoff to Claude Code for Frontend Integration

**Date:** May 16, 2026  
**Project:** Hire with Medhā (ISI Group Talent)  
**Feature:** Telegram Bot Notifications  
**Bot:** @ISIGROUP_TA_BOT

---

## 🎉 BACKEND SETUP COMPLETE

All server-side infrastructure has been deployed and is operational.

### ✅ What's Been Completed

#### 1. Database Schema (v41_telegram_notifications.sql)
- **Status:** Deployed successfully via Supabase SQL Editor
- **Tables created:**
  - `telegram_link_tokens` - One-time 15-min link codes
  - `notification_queue` - Tenant-scoped outbox with RLS
- **Columns added to `profiles`:**
  - `telegram_chat_id`
  - `telegram_username`
  - `telegram_linked_at`
  - `telegram_notifications_enabled`
- **Functions created:**
  - `telegram_mint_link_token()` - Generate link codes
  - `telegram_unlink()` - Disconnect account
  - `telegram_toggle_notifications(enabled)` - Pause/resume
  - `telegram_get_pending_notifications(batch_size)` - Queue processor
  - `telegram_mark_notification(id, status, error)` - Update status
  - `telegram_cleanup_old_data()` - Maintenance

#### 2. Edge Functions Deployed
- **`telegram-webhook`** - Bot command handler
  - Handles: `/start <token>`, `/stop`, `/status`
  - URL: `https://uwaamlyvvzuhoznlrbhz.supabase.co/functions/v1/telegram-webhook`
  - Secret-gated (returns 200 always to prevent Telegram retry storms)
  
- **`telegram-notify`** - Notification dispatcher
  - Triggered by Database Webhook on `notification_queue` INSERT
  - Formats and sends Telegram messages
  - Marks notifications as sent/failed/skipped

#### 3. Secrets Configured
- ✅ `TELEGRAM_BOT_TOKEN` - Bot API token from BotFather
- ✅ `TELEGRAM_WEBHOOK_SECRET` - Random 32-char string for webhook auth
- ℹ️ `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` - Auto-provided by Supabase

#### 4. Webhooks Registered
- ✅ **Telegram Webhook** - Registered with Telegram API
  - Bot updates flow to: `telegram-webhook` Edge Function
  - Verified with `getWebhookInfo` - response: `{"ok":true}`

- ✅ **Database Webhook** - Created in Supabase
  - Name: `telegram-notify-trigger`
  - Table: `notification_queue`
  - Event: INSERT only
  - Target: `telegram-notify` Edge Function
  - Auto-triggers notification dispatch on queue entries

---

## 🔧 WHAT'S LEFT (Frontend Integration)

According to your original implementation (branch `claude/add-telegram-notifications-3CFY4`), the following frontend code was already committed:

### Files That Should Be in the Branch

1. **`js/notifications.js`** (NEW)
   - Notifications page UI
   - Connect/disconnect Telegram flow
   - Link token generation
   - Status display
   - Pause/resume toggle

2. **`js/storage.js`** (MODIFIED)
   - `dispatchWorkflowNotification()` hooked into:
     - `persistReqChange()` - For requisition state changes
     - `persistCandidateChange()` - For candidate state changes
   - Best-effort, never blocks workflow
   - Filters out self-notifications
   - Routes notifications based on event type

3. **`js/views.js`** (MODIFIED)
   - New route: `/notifications`
   - Renders notifications page

4. **`index.html`** (MODIFIED)
   - New nav button: "Notifications"
   - Loads notifications module

5. **`js/i18n.js`** (MODIFIED)
   - ~53 new translation keys (EN/KM)
   - Labels for connection status, buttons, messages

6. **`js/config.js`** (NEEDS UPDATE)
   - **ADD THIS LINE:**
   ```javascript
   TELEGRAM_BOT_USERNAME: 'ISIGROUP_TA_BOT'
   ```

### Integration Tasks

#### Task 1: Verify Branch Contents
```bash
git checkout claude/add-telegram-notifications-3CFY4
# Verify all files above are present and complete
```

#### Task 2: Update Config
Add to `js/config.js`:
```javascript
export const config = {
  // ... existing config ...
  
  TELEGRAM_BOT_USERNAME: 'ISIGROUP_TA_BOT'
};
```

#### Task 3: Merge or Deploy
- Option A: Merge branch to main
- Option B: Cherry-pick files if conflicts exist

#### Task 4: Test End-to-End Flow

**Test 1: Account Linking**
1. User opens app → Notifications page
2. Clicks "Connect Telegram"
3. Gets 8-char code (e.g., `A1B2C3D4`)
4. Opens Telegram → Finds `@ISIGROUP_TA_BOT`
5. Sends: `/start A1B2C3D4`
6. Bot replies: "✅ Account linked successfully!"
7. App shows: "Connected" status

**Test 2: Notification Dispatch**
1. User A submits a requisition
2. User B (approver) should receive Telegram notification
3. User B approves requisition
4. User A (requester) should receive approval notification
5. Recruiter adds candidate
6. Requester should receive candidate notification

**Test 3: Manual Queue Test** (SQL)
```sql
INSERT INTO notification_queue (
  tenant_id,
  recipient_profile_id,
  event_type,
  event_data
) VALUES (
  '5cd82d77-fe6e-4633-8f87-813b2cc5972c',
  '[TEST_USER_UUID]',
  'requisition_submitted',
  '{
    "role_title": "Test Engineer",
    "department_name": "QA",
    "requester_name": "Test User",
    "urgency": "High"
  }'::jsonb
);
-- Linked user should receive Telegram message within ~30 seconds
```

---

## 📋 Notification Routing Logic

Your original implementation routes notifications as follows:

### Who Gets Notified

**Approvers receive:**
- ✅ `requisition_submitted` - When they're the approver for that role's function

**Requesters receive:**
- ✅ `requisition_approved` - When their requisition is approved
- ✅ `requisition_rejected` - When their requisition is rejected
- ✅ `requisition_status_changed` - When status changes
- ✅ `candidate_status_changed` - For their requisition's candidates
- ✅ `interview_scheduled` - For their requisition's candidates

**Recruiters receive:**
- ✅ `requisition_approved` - So they can start recruiting
- ✅ `candidate_status_changed` - For candidates they're managing

**Important:** Users never receive notifications for actions they performed themselves (filtered by acting user UUID).

---

## 🐛 Troubleshooting

### If bot doesn't respond to /start:
```bash
# Check Edge Function logs
supabase functions logs telegram-webhook --limit 50
```

### If notifications aren't sent:
```sql
-- Check queue status
SELECT * FROM notification_queue 
WHERE status = 'pending' 
ORDER BY created_at DESC 
LIMIT 10;

-- Check failed notifications
SELECT * FROM notification_queue 
WHERE status = 'failed' 
ORDER BY created_at DESC 
LIMIT 10;
```

```bash
# Check notify function logs
supabase functions logs telegram-notify --limit 50
```

### If webhook isn't triggering:
- Verify in Supabase Dashboard → Database → Webhooks
- Check that webhook status is "Active"
- Try manual INSERT to queue to test

---

## 🔐 Security Notes

- ✅ RLS policies protect `notification_queue` - users can only see their own
- ✅ Link tokens expire after 15 minutes
- ✅ All DB operations use SECURITY DEFINER functions with input validation
- ✅ Webhook secret protects against unauthorized Telegram API calls
- ✅ Edge Functions validate all inputs before processing

---

## 📊 Project Info

- **Supabase Project:** `uwaamlyvvzuhoznlrbhz`
- **Tenant ID:** `5cd82d77-fe6e-4633-8f87-813b2cc5972c`
- **Bot Username:** `@ISIGROUP_TA_BOT`
- **Bot Link:** https://t.me/ISIGROUP_TA_BOT
- **Branch:** `claude/add-telegram-notifications-3CFY4`

---

## ✅ Ready for Integration

Backend is fully operational. Frontend code should be in the branch. Your tasks:

1. [ ] Verify branch has all frontend files
2. [ ] Add bot username to config.js
3. [ ] Merge/deploy frontend changes
4. [ ] Test account linking flow
5. [ ] Test notification dispatch
6. [ ] Verify all event types work correctly

---

## 🚀 Next Steps

Once frontend is integrated, consider:
- Setting up periodic cleanup: `SELECT telegram_cleanup_old_data();`
- Monitoring notification queue for failed sends
- Adding user preferences for notification types
- Testing with all user roles (requester, approver, recruiter, head_ta)

---

**Backend Status: READY** ✅  
**Waiting on: Frontend Integration** 🔧  
**Estimated Integration Time: 15-30 minutes**

Good luck! The backend is solid and tested. Frontend should be straightforward.

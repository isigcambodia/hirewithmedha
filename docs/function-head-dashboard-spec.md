# Function Head Dashboard Redesign - Implementation Specification

## Overview
Redesign the Function Head dashboard from a single-purpose "approval queue" view to a comprehensive command center that provides ongoing visibility into their function's hiring pipeline, even when there are no pending approvals.

## Reference Design
See the mockup image created in the conversation showing:
- 6-card metrics grid
- Active requisitions table with filters
- Recent activity feed

## Current State
**File:** `js/views.js` - Function `renderFunctionHeadView()`
**Current behavior:**
- Shows 2 metrics: "Pending approval" count and "Your SLA"
- Displays approval queue (empty when caught up)
- No visibility into requisitions after approval

## Target State
Transform into a three-section dashboard:
1. **Expanded metrics** (6 cards)
2. **Active requisitions table** (always visible)
3. **Recent activity feed** (latest updates)

---

## Section 1: Expanded Metrics Grid

### Layout
- 6 metric cards in responsive grid (`grid-template-columns: repeat(auto-fit, minmax(160px, 1fr))`)
- Each card: label (13px, secondary text) + value (24px/500) + subtext (12px, tertiary)
- Background: `var(--color-background-secondary)`, no border, `border-radius: var(--border-radius-md)`, padding 1rem
- Grid gap: 12px
- Margin bottom: 32px

### Metric Cards

#### Card 1: Pending Approval (existing)
```
Label: "Pending approval" / "ការអនុម័តរង់ចាំ"
Value: COUNT of requisitions in approval_queue for current user
Subtext: "{count} over SLA" / "{count} លើស SLA"
```

**Query:**
```sql
SELECT COUNT(*) FROM approval_queue 
WHERE approver_id = $userId 
AND tenant_id = $tenantId;
```

#### Card 2: Your SLA (existing)
```
Label: "Your SLA" / "SLA របស់អ្នក"
Value: "2d" (hardcoded for now - future: configurable)
Subtext: "per requisition" / "ក្នុងមួយតម្រូវការ"
```

#### Card 3: Active Requisitions
```
Label: "Active requisitions" / "តម្រូវការសកម្ម"
Value: COUNT of requisitions for this function NOT in 'draft' or 'hired'/'closed' status
Subtext: "{count} filled this quarter" / "{count} បំពេញក្នុងត្រីមាសនេះ"
```

**Query:**
```sql
-- Active count
SELECT COUNT(*) FROM requisitions 
WHERE function_head_id = $userId 
AND tenant_id = $tenantId
AND status NOT IN ('draft', 'hired', 'closed');

-- Filled this quarter
SELECT COUNT(*) FROM requisitions
WHERE function_head_id = $userId
AND tenant_id = $tenantId
AND closed_reason = 'hired'
AND closed_at >= date_trunc('quarter', CURRENT_DATE);
```

#### Card 4: Candidates in Pipeline
```
Label: "Candidates in pipeline" / "បេក្ខជនក្នុងបណ្តាញ"
Value: COUNT of applications across all active requisitions for this function
Subtext: "across all roles" / "នៅទូទាំងតួនាទី"
```

**Query:**
```sql
SELECT COUNT(DISTINCT a.id) 
FROM applications a
JOIN requisitions r ON a.requisition_id = r.id
WHERE r.function_head_id = $userId
AND r.tenant_id = $tenantId
AND r.status NOT IN ('draft', 'hired', 'closed')
AND a.candidate_stage IS NOT NULL;
```

#### Card 5: Average Time-to-Fill
```
Label: "Avg time-to-fill" / "ពេលបំពេញមធ្យម"
Value: ROUND(AVG(closed_at - created_at)) in days for hired reqs
Subtext: "{delta}d vs last quarter" / "{delta}ថ្ងៃ vs ត្រីមាសមុន"
```

**Query:**
```sql
-- This quarter
SELECT ROUND(AVG(EXTRACT(day FROM (closed_at - created_at))))::int
FROM requisitions
WHERE function_head_id = $userId
AND tenant_id = $tenantId
AND closed_reason = 'hired'
AND closed_at >= date_trunc('quarter', CURRENT_DATE);

-- Last quarter (for comparison)
SELECT ROUND(AVG(EXTRACT(day FROM (closed_at - created_at))))::int
FROM requisitions
WHERE function_head_id = $userId
AND tenant_id = $tenantId
AND closed_reason = 'hired'
AND closed_at >= date_trunc('quarter', CURRENT_DATE - interval '3 months')
AND closed_at < date_trunc('quarter', CURRENT_DATE);
```

#### Card 6: Offer Acceptance Rate
```
Label: "Offer acceptance" / "ការទទួលយកការផ្តល់ជូន"
Value: PERCENTAGE of offers accepted
Subtext: "{accepted} of {total} accepted" / "{accepted} ក្នុងចំណោម {total} ទទួលយក"
```

**Query:**
```sql
-- Count applications that reached "offer" stage
SELECT 
  COUNT(*) FILTER (WHERE a.candidate_stage = 'offer') as total_offers,
  COUNT(*) FILTER (WHERE r.filled_by_application_id = a.id) as accepted_offers
FROM applications a
JOIN requisitions r ON a.requisition_id = r.id
WHERE r.function_head_id = $userId
AND r.tenant_id = $tenantId
AND a.candidate_stage = 'offer'
AND r.closed_at >= date_trunc('quarter', CURRENT_DATE);
```

---

## Section 2: Active Requisitions Table

### Layout
- Section header with title and filter buttons
- White background table container with border and rounded corners
- Table structure: position | status | recruiter | candidates | days open | actions

### Section Header
```html
<div class="section-header">
  <h2>Your requisitions / តម្រូវការរបស់អ្នក</h2>
  <div class="filter-buttons">
    <button data-filter="all">All ({total})</button>
    <button data-filter="sourcing">Sourcing ({count})</button>
    <button data-filter="screening">Screening ({count})</button>
    <button data-filter="interview">Interview ({count})</button>
  </div>
</div>
```

### Table Structure
```html
<table class="requisitions-table">
  <thead>
    <tr>
      <th>Position / តួនាទី</th>
      <th>Status / ស្ថានភាព</th>
      <th>Recruiter / អ្នកជ្រើសរើស</th>
      <th>Candidates / បេក្ខជន</th>
      <th>Days open / ថ្ងៃបើក</th>
      <th></th>
    </tr>
  </thead>
  <tbody>
    <!-- Rows populated from data -->
  </tbody>
</table>
```

### Data Query
```sql
SELECT 
  r.id,
  r.position_title,
  r.grade,
  r.employment_type,
  r.candidate_stage,
  r.created_at,
  e.full_name as recruiter_name,
  COUNT(DISTINCT a.id) as candidate_count,
  EXTRACT(day FROM (CURRENT_TIMESTAMP - r.created_at))::int as days_open
FROM requisitions r
LEFT JOIN employees e ON r.assigned_recruiter_id = e.user_id
LEFT JOIN applications a ON a.requisition_id = r.id AND a.candidate_stage IS NOT NULL
WHERE r.function_head_id = $userId
AND r.tenant_id = $tenantId
AND r.status NOT IN ('draft', 'hired', 'closed')
GROUP BY r.id, r.position_title, r.grade, r.employment_type, r.candidate_stage, r.created_at, e.full_name
ORDER BY r.created_at DESC;
```

### Row Template
```javascript
// Each row
{
  position: {
    title: "Senior QC Engineer",
    subtitle: "Grade 4 • Full-time" // "ថ្នាក់ 4 • ពេញម៉ោង"
  },
  status: {
    stage: "interview", // sourcing | screening | interview | offer
    label: "Interview" // Localized
  },
  recruiter: "Chanlida",
  candidates: 5,
  daysOpen: 18,
  action: "View" // "មើល"
}
```

### Status Badge Colors
- **Sourcing:** `background: var(--color-background-info); color: var(--color-text-info)`
- **Screening:** `background: #EEEDFE; color: #3C3489` (purple)
- **Interview:** `background: #FAEEDA; color: #633806` (amber)
- **Offer:** `background: var(--color-background-success); color: var(--color-text-success)`

### Filter Behavior
- Default: show all active requisitions
- Filter buttons update table to show only matching `candidate_stage`
- Update button count badges when filtering
- Use CSS `display: none` to hide non-matching rows (no re-query needed)

### Click Actions
- **View button:** Navigate to requisition detail view (reuse existing routing)
- **Row click:** Same as View button

---

## Section 3: Recent Activity Feed

### Layout
- Section header: "Recent activity" / "សកម្មភាពថ្មីៗ"
- White panel with border, rounded corners
- Activity items: icon + content (title + meta)
- Each item has bottom border except last

### Data Query
```sql
SELECT 
  al.id,
  al.action_type,
  al.created_at,
  r.position_title,
  a.candidate_name
FROM activity_log al
LEFT JOIN requisitions r ON al.requisition_id = r.id
LEFT JOIN applications a ON al.application_id = a.id
WHERE r.function_head_id = $userId
AND r.tenant_id = $tenantId
ORDER BY al.created_at DESC
LIMIT 10;
```

### Activity Item Template
```javascript
{
  icon: "ti-user-check", // Tabler icon class
  iconBg: "var(--color-background-info)", // Icon circle background
  iconColor: "var(--color-text-info)", // Icon color
  title: "Candidate moved to Interview stage", // Localized based on action_type
  meta: "Senior QC Engineer • 2 hours ago" // Position + relative time
}
```

### Icon Mapping by Action Type
- **candidate_stage_change → Interview:** `ti-user-check`, info color
- **candidate_stage_change → Screening:** `ti-users`, info color
- **candidate_stage_change → Offer:** `ti-check`, success color
- **application_created:** `ti-users`, info color
- **requisition_closed (hired):** `ti-check`, success color
- **interview_scheduled:** `ti-calendar`, info color
- **Default:** `ti-bell`, info color

### Relative Time Display
Use `utils.js` helper or create new one:
```javascript
function getRelativeTime(timestamp) {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  if (diffMins < 60) return `${diffMins} minutes ago`;
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return then.toLocaleDateString();
}
```

**Khmer translations:**
- "minutes ago" → "នាទីមុន"
- "hours ago" → "ម៉ោងមុន"
- "Yesterday" → "ម្សិលមិញ"
- "days ago" → "ថ្ងៃមុន"

---

## Implementation Details

### File Modifications

#### `js/views.js`
1. **Update `renderFunctionHeadView()` function:**
   - Add new metrics queries (Cards 3-6)
   - Create `renderMetricsGrid()` helper
   - Create `renderRequisitionsTable()` helper
   - Create `renderActivityFeed()` helper
   - Add filter button event handlers
   - Add row click handlers

2. **New helper functions to add:**
```javascript
function renderMetricsGrid(metrics) {
  // Returns HTML for 6 metric cards
}

function renderRequisitionsTable(requisitions) {
  // Returns HTML for table with all rows
}

function renderActivityFeed(activities) {
  // Returns HTML for activity items
}

function formatRelativeTime(timestamp, lang) {
  // Returns localized relative time string
}
```

#### `js/storage.js`
Add new query functions if they don't exist:
```javascript
async function getFunctionHeadMetrics(userId, tenantId) {
  // Fetch all 6 metrics in parallel
}

async function getFunctionHeadRequisitions(userId, tenantId, filter = null) {
  // Fetch active requisitions with counts
}

async function getFunctionHeadActivity(userId, tenantId, limit = 10) {
  // Fetch recent activity log entries
}
```

#### `js/utils.js`
Add utility functions if needed:
```javascript
function formatDaysDelta(current, previous) {
  const delta = current - previous;
  return delta >= 0 ? `+${delta}d` : `${delta}d`;
}

function formatPercentage(numerator, denominator) {
  if (denominator === 0) return '0%';
  return `${Math.round((numerator / denominator) * 100)}%`;
}
```

### CSS Additions

Add to existing stylesheet (likely in `index.html` or separate CSS file):

```css
/* Metrics Grid */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 32px;
}

.metric-card {
  background: var(--color-background-secondary);
  border-radius: var(--border-radius-md);
  padding: 1rem;
}

.metric-label {
  font-size: 13px;
  color: var(--color-text-secondary);
  margin: 0 0 8px;
}

.metric-value {
  font-size: 24px;
  font-weight: 500;
  margin: 0;
}

.metric-subtext {
  font-size: 12px;
  color: var(--color-text-tertiary);
  margin: 4px 0 0;
}

/* Section Header */
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 16px;
}

.section-title {
  font-size: 16px;
  font-weight: 500;
  margin: 0;
}

.filter-buttons {
  display: flex;
  gap: 8px;
}

.filter-btn {
  font-size: 13px;
  padding: 6px 12px;
  background: transparent;
  border: 0.5px solid var(--color-border-secondary);
  border-radius: var(--border-radius-md);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background 0.2s;
}

.filter-btn:hover {
  background: var(--color-background-secondary);
}

.filter-btn.active {
  background: var(--color-background-info);
  color: var(--color-text-info);
  border-color: var(--color-border-info);
}

/* Requisitions Table */
.table-container {
  background: var(--color-background-primary);
  border: 0.5px solid var(--color-border-tertiary);
  border-radius: var(--border-radius-lg);
  overflow: hidden;
  margin-bottom: 24px;
}

.requisitions-table {
  width: 100%;
  font-size: 14px;
  border-collapse: collapse;
}

.requisitions-table thead {
  background: var(--color-background-secondary);
  border-bottom: 0.5px solid var(--color-border-tertiary);
}

.requisitions-table th {
  text-align: left;
  padding: 10px 16px;
  font-weight: 500;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.requisitions-table td {
  padding: 12px 16px;
  border-top: 0.5px solid var(--color-border-tertiary);
}

.requisitions-table tbody tr {
  cursor: pointer;
  transition: background 0.2s;
}

.requisitions-table tbody tr:hover {
  background: var(--color-background-secondary);
}

.position-title {
  font-weight: 500;
  margin: 0 0 2px;
}

.position-subtitle {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin: 0;
}

/* Status Badges */
.status-badge {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
}

.status-sourcing {
  background: var(--color-background-info);
  color: var(--color-text-info);
}

.status-screening {
  background: #EEEDFE;
  color: #3C3489;
}

.status-interview {
  background: #FAEEDA;
  color: #633806;
}

.status-offer {
  background: var(--color-background-success);
  color: var(--color-text-success);
}

.candidate-count {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--color-text-secondary);
}

/* Activity Feed */
.activity-panel {
  background: var(--color-background-primary);
  border: 0.5px solid var(--color-border-tertiary);
  border-radius: var(--border-radius-lg);
  padding: 16px;
  margin-top: 24px;
}

.activity-item {
  display: flex;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 0.5px solid var(--color-border-tertiary);
}

.activity-item:last-child {
  border-bottom: none;
}

.activity-icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--color-background-info);
  color: var(--color-text-info);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.activity-content {
  flex: 1;
}

.activity-title {
  font-size: 14px;
  margin: 0 0 2px;
}

.activity-meta {
  font-size: 12px;
  color: var(--color-text-tertiary);
  margin: 0;
}
```

---

## Bilingual Support

### New Translation Keys Needed

Add to existing translations object:

```javascript
const translations = {
  en: {
    // Metrics
    'metrics.active_requisitions': 'Active requisitions',
    'metrics.filled_this_quarter': 'filled this quarter',
    'metrics.candidates_pipeline': 'Candidates in pipeline',
    'metrics.across_roles': 'across all roles',
    'metrics.avg_time_fill': 'Avg time-to-fill',
    'metrics.vs_last_quarter': 'vs last quarter',
    'metrics.offer_acceptance': 'Offer acceptance',
    'metrics.of_accepted': 'of {total} accepted',
    
    // Table
    'table.your_requisitions': 'Your requisitions',
    'table.position': 'Position',
    'table.status': 'Status',
    'table.recruiter': 'Recruiter',
    'table.candidates': 'Candidates',
    'table.days_open': 'Days open',
    'table.view': 'View',
    
    // Filters
    'filter.all': 'All',
    'filter.sourcing': 'Sourcing',
    'filter.screening': 'Screening',
    'filter.interview': 'Interview',
    
    // Activity
    'activity.recent': 'Recent activity',
    'activity.moved_to_interview': 'Candidate moved to Interview stage',
    'activity.moved_to_screening': 'Candidate moved to Screening stage',
    'activity.moved_to_offer': 'Candidate moved to Offer stage',
    'activity.new_candidates': 'new candidates screened',
    'activity.offer_accepted': 'Offer accepted',
    'activity.interview_scheduled': 'Interview scheduled',
    
    // Time
    'time.minutes_ago': 'minutes ago',
    'time.hours_ago': 'hours ago',
    'time.yesterday': 'Yesterday',
    'time.days_ago': 'days ago',
  },
  km: {
    // Metrics
    'metrics.active_requisitions': 'តម្រូវការសកម្ម',
    'metrics.filled_this_quarter': 'បំពេញក្នុងត្រីមាសនេះ',
    'metrics.candidates_pipeline': 'បេក្ខជនក្នុងបណ្តាញ',
    'metrics.across_roles': 'នៅទូទាំងតួនាទី',
    'metrics.avg_time_fill': 'ពេលបំពេញមធ្យម',
    'metrics.vs_last_quarter': 'vs ត្រីមាសមុន',
    'metrics.offer_acceptance': 'ការទទួលយកការផ្តល់ជូន',
    'metrics.of_accepted': 'ក្នុងចំណោម {total} ទទួលយក',
    
    // Table
    'table.your_requisitions': 'តម្រូវការរបស់អ្នក',
    'table.position': 'តួនាទី',
    'table.status': 'ស្ថានភាព',
    'table.recruiter': 'អ្នកជ្រើសរើស',
    'table.candidates': 'បេក្ខជន',
    'table.days_open': 'ថ្ងៃបើក',
    'table.view': 'មើល',
    
    // Filters
    'filter.all': 'ទាំងអស់',
    'filter.sourcing': 'ស្វែងរក',
    'filter.screening': 'ត្រួតពិនិត្យ',
    'filter.interview': 'សម្ភាសន៍',
    
    // Activity
    'activity.recent': 'សកម្មភាពថ្មីៗ',
    'activity.moved_to_interview': 'បេក្ខជនបានផ្លាស់ទីទៅដំណាក់កាលសម្ភាសន៍',
    'activity.moved_to_screening': 'បេក្ខជនបានផ្លាស់ទីទៅដំណាក់កាលត្រួតពិនិត្យ',
    'activity.moved_to_offer': 'បេក្ខជនបានផ្លាស់ទីទៅដំណាក់កាលផ្តល់ជូន',
    'activity.new_candidates': 'បេក្ខជនថ្មីត្រូវបានត្រួតពិនិត្យ',
    'activity.offer_accepted': 'ការផ្តល់ជូនត្រូវបានទទួលយក',
    'activity.interview_scheduled': 'បានកំណត់ពេលសម្ភាសន៍',
    
    // Time
    'time.minutes_ago': 'នាទីមុន',
    'time.hours_ago': 'ម៉ោងមុន',
    'time.yesterday': 'ម្សិលមិញ',
    'time.days_ago': 'ថ្ងៃមុន',
  }
};
```

---

## Testing Checklist

### Functional Tests
- [ ] All 6 metric cards display correct values
- [ ] Metrics update when data changes
- [ ] Requisitions table shows all active roles
- [ ] Filter buttons correctly filter table rows
- [ ] Filter counts update dynamically
- [ ] Row click navigates to requisition detail
- [ ] View button navigates to requisition detail
- [ ] Activity feed shows recent 10 items
- [ ] Activity feed items display correct icons
- [ ] Relative time displays correctly

### Data Validation
- [ ] No errors when Function Head has 0 active requisitions
- [ ] No errors when Function Head has 0 pending approvals
- [ ] No errors when no activity in recent days
- [ ] Metrics calculate correctly with edge cases (0 offers, 0 filled roles)
- [ ] Days open calculation correct for different timezones

### Bilingual Tests
- [ ] All labels switch correctly between EN/KM
- [ ] Number formatting works in both languages
- [ ] Relative time displays in correct language
- [ ] Filter button labels translate
- [ ] Status badges translate

### Responsive Tests
- [ ] Metrics grid adapts to viewport width
- [ ] Table scrolls horizontally on narrow screens if needed
- [ ] Filter buttons wrap on mobile
- [ ] Activity feed remains readable on mobile

### Performance
- [ ] All queries execute in < 1s
- [ ] Page loads without blocking
- [ ] Filter actions are instant (no re-query)

---

## Success Criteria
1. Function Head sees engaging dashboard even with 0 pending approvals
2. All active requisitions visible at a glance with key metrics
3. Quick access to requisition details via click
4. Real-time visibility into hiring pipeline activity
5. Performance remains fast with 50+ active requisitions
6. Bilingual support works seamlessly

---

## Notes for Implementation
- Reuse existing CSS variables for consistency
- Leverage existing routing for requisition detail navigation
- Use existing Supabase client (`sb` from `config.js`)
- Follow existing error handling patterns
- Add proper loading states while fetching data
- Consider adding empty states for each section (e.g., "No activity yet")
- Use existing activity_log table for activity feed (no new schema needed)
- Ensure RLS policies allow Function Head to see their own requisitions' activity

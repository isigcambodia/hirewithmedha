// ============================================================
// SAFETY HELPERS — XSS escaping, gated debug logging, ID gen
// ============================================================
// All exports here are pure functions or simple constants with no app-state
// dependencies. Safe to import from anywhere.

// Build version marker — visible in console so we can verify which build a user has cached
export const HWM_BUILD = '2026-04-22-v35';

// HWM_DEBUG: chatty console.log / window.__debug only fire when this is true.
// Enable in browser console with: localStorage.setItem('hwm_debug','1') then reload.
export const HWM_DEBUG = (() => {
  try { return localStorage.getItem('hwm_debug') === '1'; } catch { return false; }
})();

export function dbg(...args) { if (HWM_DEBUG) console.log(...args); }

// esc: escape for HTML text content and double-quoted HTML attributes.
export function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// escJs: escape a value that will be interpolated inside a JS string literal that
// itself sits inside an HTML attribute (e.g. onclick="foo('${escJs(x)}')"). Encodes
// every non-alphanumeric char as \uXXXX so neither the HTML parser nor the JS
// parser can be tricked by quotes, backslashes, angle brackets, or whitespace.
export function escJs(s) {
  if (s == null) return '';
  return String(s).replace(/[^a-zA-Z0-9]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

// Collision-safe client-side IDs. The previous `length + 1` scheme reused IDs
// when rows were deleted or when two clients created records concurrently — the
// random suffix makes both cases safe while keeping the readable year prefix.
// (Authoritative IDs still come from the DB; these are local placeholders until
// the row is persisted.)
function _idSuffix(len = 6) {
  const bytes = new Uint8Array(len);
  (window.crypto || window.msCrypto).getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(36).padStart(2, '0').slice(-1).toUpperCase()).join('');
}

export function generateReqId() { return `REQ-2026-${_idSuffix(6)}`; }
export function generateCandidateId() { return `CAN-${_idSuffix(6)}`; }

// ============================================================
// GRADE DISPLAY
// ============================================================
// Grades are stored in the DB as plain numeric strings ("1" through "15";
// the CHECK constraint enforces ^\d+$). The UI displays them as Unicode
// circled digits — the circle alone gives enough visual context, so no
// "G" prefix anywhere. Mapping covers 1–20 to absorb any future grade
// additions without falling back to the parens form.
export const GRADE_ICONS = {
  '1':'①', '2':'②', '3':'③', '4':'④', '5':'⑤',
  '6':'⑥', '7':'⑦', '8':'⑧', '9':'⑨', '10':'⑩',
  '11':'⑪','12':'⑫','13':'⑬','14':'⑭','15':'⑮',
  '16':'⑯','17':'⑰','18':'⑱','19':'⑲','20':'⑳',
};

// gradeIcon: turn a grade string/number into its circled-digit display.
// Tolerates a leading "G" so any legacy in-memory data still renders correctly.
// Unknown values fall back to the bare number (no "G", no parens).
export function gradeIcon(grade) {
  if (grade == null || grade === '') return '';
  const key = String(grade).replace(/^G/i, '');
  return GRADE_ICONS[key] || key;
}

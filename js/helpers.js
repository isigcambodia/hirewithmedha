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

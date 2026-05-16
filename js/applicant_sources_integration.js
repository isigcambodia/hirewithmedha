// ============================================
// Applicant Sources Integration
// Backend-driven source management
// ============================================

import { sb } from './config.js';

/**
 * Load applicant sources from Supabase
 * @returns {Promise<Array>} Array of source objects
 */
export async function loadApplicantSources() {
  try {
    const { data, error } = await sb
      .from('applicant_sources')
      .select('code, name_en, name_km, display_order')
      .eq('is_active', true)
      .order('display_order');
    
    if (error) {
      console.error('Error loading applicant sources:', error);
      return getDefaultSources(); // Fallback to hardcoded
    }
    
    return data || [];
  } catch (err) {
    console.error('Failed to load applicant sources:', err);
    return getDefaultSources();
  }
}

/**
 * Fallback default sources (if backend fails)
 * @returns {Array} Default source objects
 */
function getDefaultSources() {
  return [
    { code: 'linkedin', name_en: 'LinkedIn', name_km: 'LinkedIn', display_order: 1 },
    { code: 'job_board', name_en: 'Job Board', name_km: 'ផ្ទាំងការងារ', display_order: 2 },
    { code: 'agency', name_en: 'Agency', name_km: 'ភ្នាក់ងារ', display_order: 3 },
    { code: 'career_site', name_en: 'Career Site', name_km: 'គេហទំព័រការងារ', display_order: 4 },
    { code: 'referral', name_en: 'Referral', name_km: 'ការណែនាំ', display_order: 5 },
    { code: 'employee_referral', name_en: 'Employee Referral', name_km: 'ការណែនាំពីបុគ្គលិក', display_order: 6 },
    { code: 'direct', name_en: 'Direct Application', name_km: 'ការដាក់ពាក្យផ្ទាល់', display_order: 7 },
    { code: 'walk_in', name_en: 'Walk-in', name_km: 'ចូលដោយផ្ទាល់', display_order: 8 },
    { code: 'job_fair', name_en: 'Job Fair', name_km: 'ពិព័រណ៍ការងារ', display_order: 9 },
    { code: 'campus_recruitment', name_en: 'Campus Recruitment', name_km: 'ការជ្រើសរើសពីសាលា', display_order: 10 },
    { code: 'facebook', name_en: 'Facebook', name_km: 'Facebook', display_order: 11 },
    { code: 'telegram', name_en: 'Telegram', name_km: 'Telegram', display_order: 12 },
    { code: 'other', name_en: 'Other', name_km: 'ផ្សេងៗ', display_order: 99 }
  ];
}

/**
 * Populate a source dropdown element
 * @param {HTMLSelectElement} selectElement - The select element to populate
 * @param {string} currentLang - Current language ('en' or 'km')
 * @param {string} selectedCode - Currently selected source code (optional)
 */
export async function populateSourceDropdown(selectElement, currentLang = 'en', selectedCode = null) {
  const sources = await loadApplicantSources();
  
  selectElement.innerHTML = sources.map(source => {
    const displayName = currentLang === 'km' ? source.name_km : source.name_en;
    const selected = source.code === selectedCode ? ' selected' : '';
    return `<option value="${source.code}"${selected}>${displayName}</option>`;
  }).join('');
}

/**
 * Get display name for a source code
 * @param {string} code - Source code
 * @param {string} lang - Language ('en' or 'km')
 * @returns {Promise<string>} Display name
 */
export async function getSourceDisplayName(code, lang = 'en') {
  const sources = await loadApplicantSources();
  const source = sources.find(s => s.code === code);
  
  if (!source) return code; // Fallback to code if not found
  
  return lang === 'km' ? source.name_km : source.name_en;
}

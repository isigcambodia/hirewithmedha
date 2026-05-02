// ============================================================
// APP STATE — single mutable object shared across modules
// ============================================================
// Every module that needs runtime state imports this object and reads/writes
// its properties (e.g. state.currentRole = 'hrbp'). The object is a const, but
// its properties are mutable. Initial values match the previous let-globals.

export const state = {
  // Auth / tenant
  currentTenantId: null,
  currentMember: null,    // tenant_members row
  currentAuthUser: null,  // auth user
  currentUserId: null,    // set by auth flow after login

  // UI
  currentRole: 'requester',
  currentView: 'dashboard',
  selectedReqId: null,
  // When non-null, the new-req form is in EDIT MODE for an existing requisition.
  // Used by the Revise & Resubmit flow when a requester revises a returned req.
  editingReqId: null,
  currentLang: 'en',

  // Lookup tables loaded once at startup
  deptMaps: { byName: {}, byId: {} },
  roleLibMaps: { byTitle: {}, byId: {} },
  employeeMaps: { byId: {}, byCode: {}, byUserId: {}, list: [] },
  businessUnits: [],
  realUsersByUuid: {},

  // Domain data, populated from Supabase
  requisitions: [],
  candidates: [],
  activities: [],
  onboardings: [],
  channelCosts: [],

  // Onboarding UI tab state
  onboardingTab: 'starts',
};

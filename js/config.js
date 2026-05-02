// ============================================================
// SUPABASE CONFIG
// ============================================================
// Anon (publishable) key only — RLS guards data server-side. Safe to commit.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL  = 'https://uwaamlyvvzuhoznlrbhz.supabase.co';
const SUPABASE_ANON = 'sb_publishable_ioqn20WRljfy8s0-3p6ZcQ_DTic4F5V';

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON);

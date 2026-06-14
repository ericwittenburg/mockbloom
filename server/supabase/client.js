// Supabase clients shared across the server.
//
// We expose two distinct clients because they serve different purposes:
//
//   - serviceClient: built from SUPABASE_SERVICE_ROLE_KEY. Bypasses Row Level Security,
//     so it can write files to Storage on behalf of a user without re-presenting their JWT.
//     This MUST never leak to the browser.
//
//   - userClientFor(jwt): built from SUPABASE_ANON_KEY plus the user's bearer token.
//     Every database statement made through this client is evaluated under that user's
//     identity, so RLS enforces ownership even if a route forgets to filter by user_id.
//     This is the defense-in-depth that justifies the schema's RLS policies.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing Supabase env vars. Required: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY'
  );
}

// Service-role client — used for Storage operations and JWT validation only.
const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Builds an RLS-respecting Supabase client tied to a single user's JWT.
// Use this for every database read/write in protected routes.
function userClientFor(jwt) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

module.exports = { serviceClient, userClientFor };

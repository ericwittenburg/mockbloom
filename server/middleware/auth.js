// Authentication middleware.
//
// Verifies the Supabase JWT on every protected route. Expects a header of the form:
//   Authorization: Bearer <jwt>
//
// On success: attaches `req.user` (the Supabase user object) and `req.jwt` (the raw token)
// so downstream handlers can build an RLS-scoped client.
//
// On failure: responds 401 with a JSON error and stops the chain.
//
// We call `auth.getUser(token)` instead of verifying the JWT locally so that revoked
// tokens are immediately rejected and we always honor Supabase's key rotation.

const { serviceClient } = require('../supabase/client');

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }

    const jwt = match[1];
    const { data, error } = await serviceClient.auth.getUser(jwt);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = data.user;
    req.jwt = jwt;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Authentication failed', detail: err.message });
  }
}

module.exports = { requireAuth };

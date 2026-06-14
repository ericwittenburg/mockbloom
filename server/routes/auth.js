// Auth routes: signup, login, logout.
//
// These wrap Supabase Auth so the frontend never talks to Supabase directly. The frontend
// receives `{ user, session }` back from signup/login; the `session.access_token` is the
// JWT that must be sent as `Authorization: Bearer <token>` on protected routes.

const express = require('express');
const { serviceClient } = require('../supabase/client');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/v1/auth/signup
// Body: { email, password }
// Returns: { user, session } — session may be null if email confirmation is enabled.
router.post('/signup', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const { data, error } = await serviceClient.auth.signUp({ email, password });
    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(201).json({ user: data.user, session: data.session });
  } catch (err) {
    return res.status(500).json({ error: 'Signup failed', detail: err.message });
  }
});

// POST /api/v1/auth/login
// Body: { email, password }
// Returns: { user, session } — store session.access_token in the frontend.
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const { data, error } = await serviceClient.auth.signInWithPassword({ email, password });
    if (error) {
      return res.status(401).json({ error: error.message });
    }

    return res.status(200).json({ user: data.user, session: data.session });
  } catch (err) {
    return res.status(500).json({ error: 'Login failed', detail: err.message });
  }
});

// POST /api/v1/auth/logout
// Requires: Authorization: Bearer <jwt>
// Revokes the session server-side. The frontend should also clear its stored token.
router.post('/logout', requireAuth, async (req, res) => {
  try {
    const { error } = await serviceClient.auth.admin.signOut(req.jwt);
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Logout failed', detail: err.message });
  }
});

module.exports = router;

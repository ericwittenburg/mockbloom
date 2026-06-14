// Mockups routes — generated JPEG output the user wants to keep.
//
// Storage layout (inside the MOCKUPS_BUCKET):
//   {user_id}/{uuid}.jpg
//
// Every GET response includes a fresh signed URL (1 hour) per item so the frontend
// can render thumbnails or trigger downloads directly from Supabase Storage.

const express = require('express');
const crypto = require('crypto');
const { serviceClient, userClientFor } = require('../supabase/client');
const { requireAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();

const BUCKET = process.env.MOCKUPS_BUCKET || 'mockups';
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

// Adds a signed URL to a row so the frontend can render the mockup directly.
async function withSignedUrl(row) {
  const { data, error } = await serviceClient
    .storage
    .from(BUCKET)
    .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
  if (error) {
    return { ...row, signedUrl: null, signedUrlError: error.message };
  }
  return { ...row, signedUrl: data.signedUrl };
}

// POST /api/v1/mockups
// Multipart form-data fields:
//   name (string, required) — display label, e.g. "Heather Aqua" or "Heather Aqua (Back)"
//   file (File,   required) — the generated JPEG
// Returns: { mockup }
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'file is required' });
    }

    const userId = req.user.id;
    const storagePath = `${userId}/${crypto.randomUUID()}.jpg`;

    // 1. Upload the JPEG to Storage.
    const uploadResult = await serviceClient
      .storage
      .from(BUCKET)
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype || 'image/jpeg',
        upsert: false
      });
    if (uploadResult.error) {
      return res.status(500).json({ error: 'Storage upload failed', detail: uploadResult.error.message });
    }

    // 2. Insert the database row via the user-scoped client (RLS enforces ownership).
    const db = userClientFor(req.jwt);
    const insert = await db
      .from('mockups')
      .insert({
        user_id: userId,
        name,
        storage_path: storagePath
      })
      .select()
      .single();

    if (insert.error) {
      await serviceClient.storage.from(BUCKET).remove([storagePath]).catch(() => {});
      return res.status(500).json({ error: 'Database insert failed', detail: insert.error.message });
    }

    const enriched = await withSignedUrl(insert.data);
    return res.status(201).json({ mockup: enriched });
  } catch (err) {
    return res.status(500).json({ error: 'Mockup save failed', detail: err.message });
  }
});

// GET /api/v1/mockups
// Returns: { mockups: [{ id, name, storage_path, signedUrl, created_at }, ...] }
// Sorted newest-first.
router.get('/', requireAuth, async (req, res) => {
  try {
    const db = userClientFor(req.jwt);
    const { data, error } = await db
      .from('mockups')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Database query failed', detail: error.message });
    }

    const enriched = await Promise.all(data.map(withSignedUrl));
    return res.status(200).json({ mockups: enriched });
  } catch (err) {
    return res.status(500).json({ error: 'Fetching mockups failed', detail: err.message });
  }
});

// DELETE /api/v1/mockups/:id
// Removes both the storage object and the database row.
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const db = userClientFor(req.jwt);

    const lookup = await db.from('mockups').select('storage_path').eq('id', id).single();
    if (lookup.error) {
      return res.status(404).json({ error: 'Mockup not found' });
    }

    const storagePath = lookup.data.storage_path;

    const dbDelete = await db.from('mockups').delete().eq('id', id);
    if (dbDelete.error) {
      return res.status(500).json({ error: 'Database delete failed', detail: dbDelete.error.message });
    }

    if (storagePath) {
      await serviceClient.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Mockup delete failed', detail: err.message });
  }
});

module.exports = router;

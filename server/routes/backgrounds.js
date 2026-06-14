// Backgrounds routes — optional background images composited behind shirt templates.
//
// Backgrounds live in the same TEMPLATES_BUCKET as templates but are stored under
// a `background/` subpath. The `backgrounds` database table is a sibling of `templates`
// — same shape, same ownership rules, no `kind` column because every row is a background.
//
// Storage layout:
//   {user_id}/background/{uuid}.{ext}

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { serviceClient, userClientFor } = require('../supabase/client');
const { requireAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();

const BUCKET = process.env.TEMPLATES_BUCKET || 'templates';
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

function extFor(originalName, mimetype) {
  const ext = path.extname(originalName || '').toLowerCase().replace('.', '');
  if (ext) return ext;
  if (mimetype === 'image/jpeg' || mimetype === 'image/jpg') return 'jpg';
  if (mimetype === 'image/png') return 'png';
  if (mimetype === 'image/webp') return 'webp';
  return 'bin';
}

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

// POST /api/v1/backgrounds
// Multipart form-data fields:
//   name (string, required)
//   file (File,   required)
// Returns: { background }
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
    const fileExt = extFor(req.file.originalname, req.file.mimetype);
    const storagePath = `${userId}/background/${crypto.randomUUID()}.${fileExt}`;

    const uploadResult = await serviceClient
      .storage
      .from(BUCKET)
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });
    if (uploadResult.error) {
      return res.status(500).json({ error: 'Storage upload failed', detail: uploadResult.error.message });
    }

    const db = userClientFor(req.jwt);
    const insert = await db
      .from('backgrounds')
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
    return res.status(201).json({ background: enriched });
  } catch (err) {
    return res.status(500).json({ error: 'Background upload failed', detail: err.message });
  }
});

// GET /api/v1/backgrounds
// Returns: { backgrounds: [...] }
router.get('/', requireAuth, async (req, res) => {
  try {
    const db = userClientFor(req.jwt);
    const { data, error } = await db
      .from('backgrounds')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'Database query failed', detail: error.message });
    }

    const enriched = await Promise.all(data.map(withSignedUrl));
    return res.status(200).json({ backgrounds: enriched });
  } catch (err) {
    return res.status(500).json({ error: 'Fetching backgrounds failed', detail: err.message });
  }
});

// DELETE /api/v1/backgrounds/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const db = userClientFor(req.jwt);

    const lookup = await db.from('backgrounds').select('storage_path').eq('id', id).single();
    if (lookup.error) {
      return res.status(404).json({ error: 'Background not found' });
    }

    const storagePath = lookup.data.storage_path;

    const dbDelete = await db.from('backgrounds').delete().eq('id', id);
    if (dbDelete.error) {
      return res.status(500).json({ error: 'Database delete failed', detail: dbDelete.error.message });
    }

    if (storagePath) {
      await serviceClient.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Background delete failed', detail: err.message });
  }
});

module.exports = router;

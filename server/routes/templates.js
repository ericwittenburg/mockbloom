// Templates routes — front shirts, back shirts, and neck labels.
//
// One row per image, discriminated by `kind`:
//   - 'front' — front-of-shirt template image
//   - 'back'  — back-of-shirt template image
//   - 'label' — neck label image
//
// Storage layout (inside the TEMPLATES_BUCKET):
//   {user_id}/{kind}/{uuid}.{ext}
//
// Every GET response includes a fresh signed URL (1 hour) for each item so the
// frontend can render images directly without re-hitting this API per asset.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { serviceClient, userClientFor } = require('../supabase/client');
const { requireAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();

const BUCKET = process.env.TEMPLATES_BUCKET || 'templates';
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour
const ALLOWED_KINDS = new Set(['front', 'back', 'label']);

// Extracts a safe file extension from the original upload filename.
function extFor(originalName, mimetype) {
  const ext = path.extname(originalName || '').toLowerCase().replace('.', '');
  if (ext) return ext;
  if (mimetype === 'image/jpeg' || mimetype === 'image/jpg') return 'jpg';
  if (mimetype === 'image/png') return 'png';
  if (mimetype === 'image/webp') return 'webp';
  return 'bin';
}

// Adds a signed URL to a row so the frontend can render the image directly.
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

// POST /api/v1/templates/upload-url
// Returns a short-lived signed URL so the browser can upload directly to Supabase Storage,
// bypassing the Render server entirely. File bytes never touch our API.
// Body: { name, kind, ext }
// Returns: { signedUploadUrl, path }
router.post('/upload-url', requireAuth, async (req, res) => {
  try {
    const { name, kind, ext } = req.body || {};
    if (!name || !kind || !ext) {
      return res.status(400).json({ error: 'name, kind, and ext are required' });
    }
    if (!ALLOWED_KINDS.has(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${[...ALLOWED_KINDS].join(', ')}` });
    }
    if (!/^[a-z0-9]{1,8}$/.test(ext)) {
      return res.status(400).json({ error: 'Invalid file extension' });
    }
    const storagePath = `${req.user.id}/${kind}/${crypto.randomUUID()}.${ext}`;
    const { data, error } = await serviceClient.storage.from(BUCKET).createSignedUploadUrl(storagePath);
    if (error) {
      return res.status(500).json({ error: 'Could not create upload URL', detail: error.message });
    }
    return res.status(200).json({ signedUploadUrl: data.signedUrl, path: storagePath });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/templates/register
// Called after a direct browser-to-Supabase upload. Records the template in the DB.
// Body: { name, kind, sortHue, path }
// Returns: { template }
router.post('/register', requireAuth, async (req, res) => {
  try {
    const { name, kind, path: storagePath, sortHue: sortHueRaw } = req.body || {};
    if (!name || !kind || !storagePath) {
      return res.status(400).json({ error: 'name, kind, and path are required' });
    }
    if (!ALLOWED_KINDS.has(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${[...ALLOWED_KINDS].join(', ')}` });
    }
    // Enforce that the path belongs to this user.
    if (!storagePath.startsWith(`${req.user.id}/`)) {
      return res.status(403).json({ error: 'Storage path does not belong to this user' });
    }
    const sortHue = sortHueRaw !== undefined && sortHueRaw !== '' && sortHueRaw !== null
      ? Number(sortHueRaw) : null;
    const db = userClientFor(req.jwt);
    const insert = await db
      .from('templates')
      .insert({
        user_id: req.user.id,
        name,
        kind,
        storage_path: storagePath,
        sort_hue: Number.isFinite(sortHue) ? sortHue : null
      })
      .select()
      .single();
    if (insert.error) {
      return res.status(500).json({ error: 'Database insert failed', detail: insert.error.message });
    }
    const enriched = await withSignedUrl(insert.data);
    return res.status(201).json({ template: enriched });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/templates
// Multipart form-data fields:
//   name      (string, required)  — display name, e.g. "Heather Aqua"
//   kind      (string, required)  — one of: front, back, label
//   sortHue   (number, optional)  — hue value computed by the frontend
//   file      (File,   required)  — the image
// Returns: { template }
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const { name, kind } = req.body || {};
    const sortHueRaw = req.body?.sortHue;

    if (!name || !kind) {
      return res.status(400).json({ error: 'name and kind are required' });
    }
    if (!ALLOWED_KINDS.has(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${[...ALLOWED_KINDS].join(', ')}` });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'file is required' });
    }

    const userId = req.user.id;
    const fileExt = extFor(req.file.originalname, req.file.mimetype);
    const storagePath = `${userId}/${kind}/${crypto.randomUUID()}.${fileExt}`;

    // 1. Upload bytes to Storage (service client bypasses storage RLS — path enforces ownership).
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

    // 2. Insert row via user-scoped client so RLS validates ownership.
    const db = userClientFor(req.jwt);
    const sortHue = sortHueRaw !== undefined && sortHueRaw !== '' && sortHueRaw !== null
      ? Number(sortHueRaw)
      : null;

    const insert = await db
      .from('templates')
      .insert({
        user_id: userId,
        name,
        kind,
        storage_path: storagePath,
        sort_hue: Number.isFinite(sortHue) ? sortHue : null
      })
      .select()
      .single();

    if (insert.error) {
      // Roll back the orphan in Storage so we don't accumulate garbage.
      await serviceClient.storage.from(BUCKET).remove([storagePath]).catch(() => {});
      return res.status(500).json({ error: 'Database insert failed', detail: insert.error.message });
    }

    const enriched = await withSignedUrl(insert.data);
    return res.status(201).json({ template: enriched });
  } catch (err) {
    return res.status(500).json({ error: 'Template upload failed', detail: err.message });
  }
});

// GET /api/v1/templates
// Optional query: ?kind=front | back | label
// Returns: { templates: [{ id, name, kind, sort_hue, storage_path, signedUrl, created_at }, ...] }
router.get('/', requireAuth, async (req, res) => {
  try {
    const db = userClientFor(req.jwt);
    let query = db.from('templates').select('*').order('sort_hue', { ascending: true, nullsFirst: false });

    const { kind } = req.query;
    if (kind) {
      if (!ALLOWED_KINDS.has(kind)) {
        return res.status(400).json({ error: `kind must be one of: ${[...ALLOWED_KINDS].join(', ')}` });
      }
      query = query.eq('kind', kind);
    }

    const { data, error } = await query;
    if (error) {
      return res.status(500).json({ error: 'Database query failed', detail: error.message });
    }

    const enriched = await Promise.all(data.map(withSignedUrl));
    return res.status(200).json({ templates: enriched });
  } catch (err) {
    return res.status(500).json({ error: 'Fetching templates failed', detail: err.message });
  }
});

// DELETE /api/v1/templates/:id
// Removes both the storage object and the database row.
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const db = userClientFor(req.jwt);

    // Look up the row first so we know what storage object to remove (and RLS confirms ownership).
    const lookup = await db.from('templates').select('storage_path').eq('id', id).single();
    if (lookup.error) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const storagePath = lookup.data.storage_path;

    const dbDelete = await db.from('templates').delete().eq('id', id);
    if (dbDelete.error) {
      return res.status(500).json({ error: 'Database delete failed', detail: dbDelete.error.message });
    }

    // Best-effort file removal — DB row is already gone, so failure here just leaves an orphan.
    if (storagePath) {
      await serviceClient.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Template delete failed', detail: err.message });
  }
});

module.exports = router;

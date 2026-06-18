const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { serviceClient } = require('../supabase/client');
const { requireAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();

const BUCKET = process.env.TEMPLATES_BUCKET || 'templates';
const SIGNED_URL_TTL_SECONDS = 60 * 60;
const ALLOWED_KINDS = new Set(['front', 'back', 'label']);

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
    .storage.from(BUCKET).createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
  if (error) return { ...row, signedUrl: null };
  return { ...row, signedUrl: data.signedUrl };
}

// POST /api/v1/templates/upload-url
// Returns a signed URL so the browser can upload directly to Supabase Storage.
// Body: { name, kind, ext }
router.post('/upload-url', requireAuth, async (req, res) => {
  try {
    const { name, kind, ext } = req.body || {};
    if (!name || !kind || !ext) return res.status(400).json({ error: 'name, kind, and ext are required' });
    if (!ALLOWED_KINDS.has(kind)) return res.status(400).json({ error: `kind must be one of: ${[...ALLOWED_KINDS].join(', ')}` });
    if (!/^[a-z0-9]{1,8}$/.test(ext)) return res.status(400).json({ error: 'Invalid file extension' });

    const storagePath = `${req.user.id}/${kind}/${crypto.randomUUID()}.${ext}`;
    const { data, error } = await serviceClient.storage.from(BUCKET).createSignedUploadUrl(storagePath);
    if (error) return res.status(500).json({ error: 'Could not create upload URL', detail: error.message });
    return res.status(200).json({ signedUploadUrl: data.signedUrl, path: storagePath });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/templates/register
// Records a template in the DB after a direct browser-to-Supabase upload.
// Body: { name, kind, sortHue, path }
router.post('/register', requireAuth, async (req, res) => {
  try {
    const { name, kind, path: storagePath, sortHue: sortHueRaw } = req.body || {};
    if (!name || !kind || !storagePath) return res.status(400).json({ error: 'name, kind, and path are required' });
    if (!ALLOWED_KINDS.has(kind)) return res.status(400).json({ error: `kind must be one of: ${[...ALLOWED_KINDS].join(', ')}` });
    if (!storagePath.startsWith(`${req.user.id}/`)) return res.status(403).json({ error: 'Storage path does not belong to this user' });

    const sortHue = (sortHueRaw != null && sortHueRaw !== '') ? Number(sortHueRaw) : null;
    const { data, error } = await serviceClient
      .from('templates')
      .insert({
        user_id: req.user.id, name, kind,
        storage_path: storagePath,
        sort_hue: Number.isFinite(sortHue) ? sortHue : null
      })
      .select().single();
    if (error) return res.status(500).json({ error: 'Database insert failed', detail: error.message });
    return res.status(201).json({ template: await withSignedUrl(data) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/templates
// Multipart upload (fallback when direct upload is unavailable).
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const { name, kind } = req.body || {};
    const sortHueRaw = req.body?.sortHue;
    if (!name || !kind) return res.status(400).json({ error: 'name and kind are required' });
    if (!ALLOWED_KINDS.has(kind)) return res.status(400).json({ error: `kind must be one of: ${[...ALLOWED_KINDS].join(', ')}` });
    if (!req.file) return res.status(400).json({ error: 'file is required' });

    const userId = req.user.id;
    const fileExt = extFor(req.file.originalname, req.file.mimetype);
    const storagePath = `${userId}/${kind}/${crypto.randomUUID()}.${fileExt}`;

    const uploadResult = await serviceClient.storage.from(BUCKET).upload(storagePath, req.file.buffer, {
      contentType: req.file.mimetype, upsert: false
    });
    if (uploadResult.error) {
      return res.status(500).json({ error: 'Storage upload failed', detail: uploadResult.error.message });
    }

    const sortHue = (sortHueRaw != null && sortHueRaw !== '') ? Number(sortHueRaw) : null;
    const { data, error } = await serviceClient
      .from('templates')
      .insert({
        user_id: userId, name, kind,
        storage_path: storagePath,
        sort_hue: Number.isFinite(sortHue) ? sortHue : null
      })
      .select().single();

    if (error) {
      await serviceClient.storage.from(BUCKET).remove([storagePath]).catch(() => {});
      return res.status(500).json({ error: 'Database insert failed', detail: error.message });
    }
    return res.status(201).json({ template: await withSignedUrl(data) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/templates
router.get('/', requireAuth, async (req, res) => {
  try {
    let query = serviceClient.from('templates')
      .select('*')
      .eq('user_id', req.user.id)
      .order('sort_hue', { ascending: true, nullsFirst: false });

    const { kind } = req.query;
    if (kind) {
      if (!ALLOWED_KINDS.has(kind)) return res.status(400).json({ error: `kind must be one of: ${[...ALLOWED_KINDS].join(', ')}` });
      query = query.eq('kind', kind);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: 'Database query failed', detail: error.message });
    const enriched = await Promise.all(data.map(withSignedUrl));
    return res.status(200).json({ templates: enriched });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/templates/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const lookup = await serviceClient.from('templates')
      .select('storage_path').eq('id', id).eq('user_id', req.user.id).single();
    if (lookup.error) return res.status(404).json({ error: 'Template not found' });

    const storagePath = lookup.data.storage_path;
    const { error } = await serviceClient.from('templates').delete().eq('id', id).eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: 'Database delete failed', detail: error.message });

    if (storagePath) await serviceClient.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

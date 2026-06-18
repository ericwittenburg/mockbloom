const express = require('express');
const crypto = require('crypto');
const { serviceClient } = require('../supabase/client');
const { requireAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();

const BUCKET = process.env.MOCKUPS_BUCKET || 'mockups';
const SIGNED_URL_TTL_SECONDS = 60 * 60;

async function withSignedUrl(row) {
  const { data, error } = await serviceClient.storage.from(BUCKET).createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
  if (error) return { ...row, signedUrl: null };
  return { ...row, signedUrl: data.signedUrl };
}

// POST /api/v1/mockups
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!req.file) return res.status(400).json({ error: 'file is required' });

    const userId = req.user.id;
    const storagePath = `${userId}/${crypto.randomUUID()}.jpg`;

    const uploadResult = await serviceClient.storage.from(BUCKET).upload(storagePath, req.file.buffer, {
      contentType: req.file.mimetype || 'image/jpeg', upsert: false
    });
    if (uploadResult.error) return res.status(500).json({ error: 'Storage upload failed', detail: uploadResult.error.message });

    const { data, error } = await serviceClient
      .from('mockups')
      .insert({ user_id: userId, name, storage_path: storagePath })
      .select().single();

    if (error) {
      await serviceClient.storage.from(BUCKET).remove([storagePath]).catch(() => {});
      return res.status(500).json({ error: 'Database insert failed', detail: error.message });
    }
    return res.status(201).json({ mockup: await withSignedUrl(data) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/mockups
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await serviceClient
      .from('mockups').select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Database query failed', detail: error.message });
    const enriched = await Promise.all(data.map(withSignedUrl));
    return res.status(200).json({ mockups: enriched });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/mockups/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const lookup = await serviceClient.from('mockups').select('storage_path').eq('id', id).eq('user_id', req.user.id).single();
    if (lookup.error) return res.status(404).json({ error: 'Mockup not found' });

    const { error } = await serviceClient.from('mockups').delete().eq('id', id).eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: 'Database delete failed', detail: error.message });

    if (lookup.data.storage_path) await serviceClient.storage.from(BUCKET).remove([lookup.data.storage_path]).catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

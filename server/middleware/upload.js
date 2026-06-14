// Multer upload middleware factory.
//
// Configures multer to keep uploaded files in memory (as Buffers) so we can stream them
// straight into Supabase Storage without ever touching local disk — this is what makes
// the server stateless and friendly to ephemeral hosts like Render.
//
// We reject any non-image MIME type and cap each file at MAX_UPLOAD_BYTES (8 MB default).
//
// Usage:
//   const upload = require('./middleware/upload');
//   router.post('/templates', requireAuth, upload.single('file'), handler);

const multer = require('multer');

const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || '8388608', 10);

const ACCEPTED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp'
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    if (ACCEPTED_MIME.has(file.mimetype)) {
      return cb(null, true);
    }
    return cb(new Error(`Unsupported file type: ${file.mimetype}`));
  }
});

module.exports = upload;

// MockBloom backend entry point.
//
// Loads environment variables, wires up middleware (CORS + JSON), mounts the
// versioned API routers, and starts listening on PORT (defaults to 3001 locally).
//
// All API routes live under /api/v1/. A bare GET / health check is also exposed
// so deployment platforms can verify the service is alive.

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const templatesRoutes = require('./routes/templates');
const mockupsRoutes = require('./routes/mockups');
const backgroundsRoutes = require('./routes/backgrounds');

const app = express();

// --- CORS ---
// FRONTEND_URL is a comma-separated whitelist of allowed origins.
// Local dev (http://localhost:3000) is always allowed for convenience.
const FRONTEND_URL = process.env.FRONTEND_URL || '';
const allowedOrigins = new Set(
  ['http://localhost:3000', ...FRONTEND_URL.split(',').map(s => s.trim()).filter(Boolean)]
);

app.use(cors({
  origin: (origin, cb) => {
    // Same-origin / server-to-server requests have no Origin header — allow them.
    if (!origin) return cb(null, true);
    if (allowedOrigins.has(origin)) return cb(null, true);
    return cb(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true
}));

// --- Body parser ---
// JSON only — multipart uploads are handled per-route by multer.
app.use(express.json({ limit: '1mb' }));

// --- Health check ---
// Used by Render to confirm the service is up.
app.get('/', (req, res) => {
  res.status(200).json({ service: 'mockbloom-api', status: 'ok' });
});

// --- API routes ---
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/templates', templatesRoutes);
app.use('/api/v1/mockups', mockupsRoutes);
app.use('/api/v1/backgrounds', backgroundsRoutes);

// --- 404 handler ---
app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

// --- Global error handler ---
// Catches multer errors (file too big, wrong type) and any handler that forgets try/catch.
app.use((err, req, res, _next) => {
  console.error('[error]', err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

const PORT = parseInt(process.env.PORT || '3001', 10);
app.listen(PORT, () => {
  console.log(`MockBloom API listening on port ${PORT}`);
  console.log(`Allowed origins: ${[...allowedOrigins].join(', ')}`);
});

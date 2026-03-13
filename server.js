const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const journalRoutes = require('./routes/journal');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────────────────────────
// Allowed origins
// ─────────────────────────────────────────────────────────────
const getAllowedOrigins = () => {
  const origins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://ai-assisted-journal-system-gilt.vercel.app',
  ];

  if (process.env.ALLOWED_ORIGINS) {
    origins.push(...process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()));
  }

  return origins;
};

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, curl, etc.)
    if (!origin) return callback(null, true);

    const allowedOrigins = getAllowedOrigins();
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`❌ Blocked CORS request from: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  maxAge: 86400, // cache preflight for 24 hours
};

// ─────────────────────────────────────────────────────────────
// ✅ FIX 1: Handle OPTIONS preflight FIRST — before any other middleware
// Without this, browsers never get a valid preflight response
// ─────────────────────────────────────────────────────────────
app.options('*', cors(corsOptions));

// Apply CORS to all routes
app.use(cors(corsOptions));

app.use(express.json({ limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  console.log(
    `${new Date().toISOString()} | ${req.method} ${req.path} | Origin: ${req.headers.origin || 'none'}`
  );
  next();
});

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────
app.use('/api/journal', journalRoutes);

// ✅ FIX 2: Health check available at BOTH /health AND /api/health
// Frontend api.ts calls /api/health — this was silently 404-ing before
const healthHandler = (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    version: process.env.npm_package_version || '1.0.0',
  });
};

app.get('/health', healthHandler);
app.get('/api/health', healthHandler); // ← was missing — caused waitForServer() to fail

app.get('/', (req, res) => {
  res.json({
    message: '🌿 ArvyaX Journal API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      journal: {
        create: 'POST /api/journal',
        list: 'GET /api/journal/:userId',
        analyze: 'POST /api/journal/analyze',
        analyzeEntry: 'POST /api/journal/:id/analyze',
        insights: 'GET /api/journal/insights/:userId',
        cache: {
          stats: 'GET /api/journal/cache/stats',
          clear: 'POST /api/journal/cache/clear',
        },
      },
    },
    documentation: 'See README.md for full API documentation',
  });
});

// ─────────────────────────────────────────────────────────────
// Error handlers
// ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
    availableRoutes: ['/health', '/api/health', '/api/journal'],
  });
});

app.use((err, req, res, next) => {
  console.error('❌ Error:', err.stack);

  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      error: 'CORS Error',
      message: 'Origin not allowed',
      origin: req.headers.origin,
    });
  }

  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong!',
  });
});

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 ArvyaX Journal API running on port ${PORT}`);
  console.log(`📚 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Allowed Origins: ${getAllowedOrigins().join(', ')}`);
  console.log(`🤖 LLM Service: ${process.env.OPENROUTER_API_KEY ? 'Enabled' : 'Fallback Mode'}`);
});

module.exports = app;
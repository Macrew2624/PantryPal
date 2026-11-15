import express from 'express';
import cors from 'cors';
import { authRouter } from './routes/auth.routes.js';
import { productsRouter } from './routes/products.routes.js';
import { notificationsRouter } from './routes/notifications.routes.js';
import { requireAuth } from './middleware/require-auth.js';

export function createApp() {
  const app = express();

  // Permissive CORS configuration supporting Ionic development & mobile runtimes
  const allowedOrigins = [
    'http://localhost:4200',
    'http://localhost:8100',
    'http://localhost:8101',
    'http://127.0.0.1:4200',
    'http://127.0.0.1:8100',
    'capacitor://localhost',
    'ionic://localhost',
  ];

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (
          allowedOrigins.includes(origin) ||
          /^http:\/\/localhost:\d+$/.test(origin) ||
          /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)
        ) {
          return callback(null, true);
        }
        return callback(null, true); // Permissive for local development
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
    })
  );

  app.use(express.json({ limit: '32kb' }));

  // Health and informational endpoints
  app.get('/', (req, res) => {
    res.json({
      name: 'PantryPal API',
      status: 'online',
      version: '1.0.0',
      endpoints: {
        products: '/api/products',
        health: '/api/health',
      },
    });
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Registration and login are public; the current-user endpoint validates its bearer token.
  app.use('/api/auth', authRouter);

  // REST API routes
  app.use('/api/products', productsRouter);
  app.use('/api/notifications', requireAuth, notificationsRouter);

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body must contain valid JSON.' });
    }
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body is too large.' });
    }
    console.error('[PantryPal API] Request failed:', error.message);
    return res.status(500).json({ error: 'Internal server error.' });
  });

  // 404 handler for unknown routes
  app.use((req, res) => {
    res.status(404).json({ error: `Route ${req.method} ${req.originalUrl} not found` });
  });

  return app;
}

import { Router } from 'express';
import { broadcastNotification, getAuthenticatedSocketCount } from '../websocket.js';

export const notificationsRouter = Router();

/**
 * POST /api/notifications/test
 * Development-only endpoint to trigger a WebSocket notification
 */
notificationsRouter.post('/test', (req, res) => {
  const { type, message, productId, product } = req.body || {};

  const notification = {
    type: type || 'TEST_NOTIFICATION',
    message: message || 'Pantry alert: Someone updated the inventory stock!',
    productId: productId || 'prod-01',
    product: product || null,
    timestamp: new Date().toISOString(),
  };

  const recipientCount = broadcastNotification(notification, req.auth.userId);
  res.json({
    success: true,
    message: 'Test notification broadcast dispatched.',
    notification,
    stats: {
      recipientCount,
      totalConnectedClients: getAuthenticatedSocketCount(req.auth.userId),
    },
  });
});

import { WebSocketServer, WebSocket } from 'ws';
import { verifyAccessToken } from './auth/jwt.js';

const AUTH_TIMEOUT_MS = 5000;
let wss = null;

/** @typedef {import('ws').WebSocket & { userId?: string }} AuthenticatedSocket */

/**
 * Initializes the WebSocket server. Browser clients authenticate with their first
 * frame because the WebSocket API cannot set an Authorization header.
 * @param {import('node:http').Server} httpServer
 */
export function initWebSocketServer(httpServer) {
  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (/** @type {AuthenticatedSocket} */ ws, req) => {
    const clientIp = req.socket.remoteAddress;
    console.log(`[WebSocket] Pending authentication from ${clientIp}`);
    let authenticated = false;
    let expiryTimer;

    const authTimer = setTimeout(() => rejectAuthentication(ws), AUTH_TIMEOUT_MS);
    authTimer.unref?.();

    ws.on('message', (data) => {
      if (authenticated) return;

      try {
        const message = JSON.parse(data.toString());
        if (message?.type !== 'AUTHENTICATE' || typeof message.token !== 'string') {
          rejectAuthentication(ws);
          return;
        }

        const payload = verifyAccessToken(message.token);
        if (typeof payload === 'string' || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') {
          rejectAuthentication(ws);
          return;
        }

        authenticated = true;
        ws.userId = payload.sub;
        clearTimeout(authTimer);
        expiryTimer = setTimeout(() => ws.close(1008, 'Token expired'), Math.max(0, payload.exp * 1000 - Date.now()));
        expiryTimer.unref?.();
        ws.send(JSON.stringify({ type: 'AUTHENTICATED', timestamp: new Date().toISOString() }));
        ws.send(
          JSON.stringify({
            type: 'CONNECTION_ESTABLISHED',
            message: 'Connected to PantryPal real-time notification stream.',
            timestamp: new Date().toISOString(),
          }),
        );
        console.log(`[WebSocket] Authenticated user ${ws.userId}`);
      } catch {
        rejectAuthentication(ws);
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      clearTimeout(expiryTimer);
      console.log(`[WebSocket] Client disconnected (Remaining: ${wss.clients.size})`);
    });

    ws.on('error', (err) => {
      console.error('[WebSocket] Client error:', err.message);
    });
  });

  return wss;
}

function rejectAuthentication(ws) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'AUTHENTICATION_FAILED', message: 'Unauthorized' }));
  ws.close(1008, 'Authentication required');
}

/**
 * Sends an event only to authenticated sockets owned by the resource's user.
 * @param {{ type: string, message: string, productId?: string, product?: object, timestamp?: string }} payload
 * @param {string} ownerId
 * @returns {number} count of notified clients
 */
export function broadcastNotification(payload, ownerId) {
  if (!wss || !ownerId) return 0;

  const notification = {
    ...payload,
    timestamp: payload.timestamp || new Date().toISOString(),
  };
  const messageStr = JSON.stringify(notification);
  let recipientCount = 0;

  for (const /** @type {AuthenticatedSocket} */ client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.userId === ownerId) {
      client.send(messageStr);
      recipientCount++;
    }
  }

  console.log(`[WebSocket Broadcast] Sent "${notification.type}" to ${recipientCount} socket(s) for owner ${ownerId}`);
  return recipientCount;
}

/** Returns the WebSocketServer instance. */
export function getWebSocketServer() {
  return wss;
}

/** Returns the number of authenticated sockets belonging to one user. */
export function getAuthenticatedSocketCount(ownerId) {
  if (!wss || !ownerId) return 0;
  let count = 0;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.userId === ownerId) count++;
  }
  return count;
}

import 'dotenv/config';
import http from 'node:http';
import { createApp } from './app.js';
import { getJwtSecret } from './auth/jwt.js';
import { seedDevelopmentUser } from './auth/users.js';
import { initWebSocketServer } from './websocket.js';

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
try {
  getJwtSecret();
} catch (error) {
  console.error(`[PantryPal Server] ${error.message}`);
  process.exit(1);
}
await seedDevelopmentUser();
const app = createApp();
const server = http.createServer(app);

// Initialize WebSocket server on the same HTTP server & port
initWebSocketServer(server);

server.listen(PORT, HOST, () => {
  console.log(`[PantryPal Server] Listening on ${HOST}:${PORT}`);
  console.log(`[PantryPal Server] REST endpoints available at http://<computer-ip>:${PORT}/api`);
  console.log(`[PantryPal Server] WebSocket endpoint active at ws://<computer-ip>:${PORT}`);
});

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { initWebSocketServer } from '../src/websocket.js';

process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-bytes-long';

describe('PantryPal WebSocket Notifications', () => {
  let server;
  let baseUrl;
  let wsUrl;
  let authorization;
  let secondAuthorization;

  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    initWebSocketServer(server);

    await new Promise((resolve) => {
      server.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}`;
        wsUrl = `ws://localhost:${port}`;
        resolve();
      });
    });

    authorization = await registerAndLogin('websocket-test@pantrypal.local', 'WebsocketTest!2026');
    secondAuthorization = await registerAndLogin('websocket-other@pantrypal.local', 'OtherSocket!2026');
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test('rejects unauthenticated and invalid-token connections before subscribing', async () => {
    assert.equal(await rejectedConnection(), 1008);
    assert.equal(await rejectedConnection('invalid.jwt.token'), 1008);
  });

  test('authenticates before sending the connection greeting', async () => {
    const ws = await connectAuthenticated(authorization);
    assert.equal(ws.authenticated, true);
    ws.close();
  });

  test('POST /api/notifications/test reaches only the authenticated caller', async () => {
    const ownerSocket = await connectAuthenticated(authorization);
    const otherSocket = await connectAuthenticated(secondAuthorization);
    const ownerNotification = nextMessage(ownerSocket);
    const otherNotification = nextMessage(otherSocket, 150);

    const postRes = await fetch(`${baseUrl}/api/notifications/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify({ message: 'Private test notification', productId: 'private-test-99' }),
    });
    assert.equal(postRes.status, 200);
    assert.equal((await postRes.json()).stats.recipientCount, 1);

    const received = await ownerNotification;
    assert.equal(received.type, 'TEST_NOTIFICATION');
    assert.equal(received.message, 'Private test notification');
    assert.equal(await otherNotification, null);
    ownerSocket.close();
    otherSocket.close();
  });

  test('product create, update, and delete notify only the product owner', async () => {
    const ownerSocket = await connectAuthenticated(authorization);
    const otherSocket = await connectAuthenticated(secondAuthorization);
    const privateNotification = nextMessage(otherSocket, 150);
    const addedNotification = nextMessage(ownerSocket);

    const createResponse = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify({
        name: 'Fresh Bagels',
        category: 'Bakery',
        quantity: 4,
        expirationDate: '2026-11-04',
        isOpened: false,
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    const added = await addedNotification;
    assert.equal(added.type, 'PRODUCT_ADDED');
    assert.equal(added.product.ownerId, created.ownerId);
    assert.equal(await privateNotification, null);

    const updatedNotificationPromise = nextMessage(ownerSocket);
    const updateResponse = await fetch(`${baseUrl}/api/products/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify({ quantity: 2 }),
    });
    assert.equal(updateResponse.status, 200);
    const updated = await updatedNotificationPromise;
    assert.equal(updated.type, 'PRODUCT_UPDATED');
    assert.equal(updated.productId, created.id);

    const deletedNotificationPromise = nextMessage(ownerSocket);
    const deleteResponse = await fetch(`${baseUrl}/api/products/${created.id}`, {
      method: 'DELETE',
      headers: { Authorization: authorization },
    });
    assert.equal(deleteResponse.status, 200);
    const deleted = await deletedNotificationPromise;
    assert.equal(deleted.type, 'PRODUCT_DELETED');
    assert.equal(deleted.productId, created.id);

    ownerSocket.close();
    otherSocket.close();
  });

  async function registerAndLogin(email, password) {
    const register = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(register.status, 201);
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return `Bearer ${(await response.json()).token}`;
  }

  async function connectAuthenticated(bearerToken) {
    const ws = new WebSocket(wsUrl);
    const ready = new Promise((resolve, reject) => {
      let authenticated = false;
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'AUTHENTICATE', token: bearerToken.slice('Bearer '.length) }));
      });
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'AUTHENTICATION_FAILED') reject(new Error('WebSocket authentication failed'));
        if (message.type === 'AUTHENTICATED') authenticated = true;
        if (message.type === 'CONNECTION_ESTABLISHED') {
          assert.equal(authenticated, true);
          ws.authenticated = true;
          resolve();
        }
      });
      ws.on('error', reject);
    });
    await ready;
    return ws;
  }

  async function rejectedConnection(token) {
    const ws = new WebSocket(wsUrl);
    const closed = new Promise((resolve, reject) => {
      ws.on('open', () => {
        if (token) ws.send(JSON.stringify({ type: 'AUTHENTICATE', token }));
      });
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {});
    });
    return closed;
  }

  function nextMessage(ws, timeoutMs = 1500) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        ws.off('message', onMessage);
        resolve(null);
      }, timeoutMs);
      const onMessage = (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      };
      ws.on('message', onMessage);
    });
  }
});

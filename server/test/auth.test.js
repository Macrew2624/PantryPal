import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-bytes-long';

describe('PantryPal JWT authentication', () => {
  let server;
  let baseUrl;
  let token;
  const credentials = { email: 'jwt-test@pantrypal.local', password: 'SecureTest!2026' };

  before(async () => {
    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test('registers users without returning or exposing their password', async () => {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.deepEqual(body.user.email, credentials.email);
    assert.equal(JSON.stringify(body).includes(credentials.password), false);
    assert.equal(Object.hasOwn(body.user, 'passwordHash'), false);
  });

  test('validates registration fields and rejects duplicate emails', async () => {
    const invalid = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'short' }),
    });
    assert.equal(invalid.status, 400);

    const duplicate = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });
    assert.equal(duplicate.status, 409);
  });

  test('returns a signed JWT after successful login', async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    token = body.token;
    assert.equal(typeof token, 'string');
    assert.equal(body.user.email, credentials.email);
    assert.equal(JSON.stringify(body).includes(credentials.password), false);
  });

  test('returns a safe 401 for failed login', async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: credentials.email, password: 'WrongPassword!2026' }),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Invalid email or password.' });
  });

  test('protects product and resource endpoints and accepts a valid bearer token', async () => {
    for (const authorization of [undefined, 'Bearer malformed.token.value']) {
      const response = await fetch(`${baseUrl}/api/products`, {
        headers: authorization ? { Authorization: authorization } : {},
      });
      assert.equal(response.status, 401);
    }

    const notificationResponse = await fetch(`${baseUrl}/api/notifications/test`, { method: 'POST' });
    assert.equal(notificationResponse.status, 401);

    const productsResponse = await fetch(`${baseUrl}/api/products`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(productsResponse.status, 200);

    const currentUserResponse = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(currentUserResponse.status, 200);
    assert.equal((await currentUserResponse.json()).user.email, credentials.email);
  });
});

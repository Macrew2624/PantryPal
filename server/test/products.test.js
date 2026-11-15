import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-bytes-long';

describe('PantryPal Backend REST Endpoints', () => {
  let server;
  let baseUrl;
  let authorization;
  let secondAuthorization;
  let ownerId;

  before(async () => {
    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
    await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'products-test@pantrypal.local', password: 'ProductTest!2026' }),
    });
    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'products-test@pantrypal.local', password: 'ProductTest!2026' }),
    });
    authorization = `Bearer ${(await loginResponse.json()).token}`;
    const currentUser = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: authorization } });
    ownerId = (await currentUser.json()).user.id;

    await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'products-other@pantrypal.local', password: 'OtherProduct!2026' }),
    });
    const secondLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'products-other@pantrypal.local', password: 'OtherProduct!2026' }),
    });
    secondAuthorization = `Bearer ${(await secondLogin.json()).token}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test('GET /api/health returns ok', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
  });

  test('GET /api/products returns a paginated response with sample products', async () => {
    const res = await apiFetch('/api/products');
    assert.equal(res.status, 200);
    const page = await res.json();
    const products = page.items;
    assert.ok(Array.isArray(products));
    assert.ok(products.length >= 10);
    assert.equal(page.limit, 20);
    assert.equal(page.offset, 0);
    assert.equal(page.total, products.length);
    assert.equal(page.hasMore, false);

    const first = products[0];
    assert.ok(first.id);
    assert.ok(first.name);
    assert.ok(first.category);
    assert.equal(typeof first.quantity, 'number');
    assert.ok(first.expirationDate);
    assert.equal(typeof first.isOpened, 'boolean');
  });

  test('paginates deterministically and validates page parameters', async () => {
    const firstResponse = await apiFetch('/api/products?limit=3&offset=0');
    const secondResponse = await apiFetch('/api/products?limit=3&offset=3');
    const first = await firstResponse.json();
    const second = await secondResponse.json();

    assert.equal(first.items.length, 3);
    assert.equal(first.hasMore, true);
    assert.equal(first.total, 10);
    assert.equal(first.items[0].id, 'prod-01');
    assert.equal(second.offset, 3);
    assert.equal(second.items[0].id, 'prod-04');
    assert.equal(new Set([...first.items, ...second.items].map((product) => product.id)).size, 6);

    for (const query of ['?limit=0', '?limit=101', '?limit=-1', '?offset=1.5', '?offset=abc']) {
      const response = await apiFetch(`/api/products${query}`);
      assert.equal(response.status, 400);
    }
  });

  test('combines search, category, expiry, opened and sort filters after ownership scoping', async () => {
    const candidates = [
      {
        name: 'Tomato sauce alpha',
        category: 'Canned Goods',
        quantity: 1,
        expirationDate: '2035-01-01',
        isOpened: false,
        notes: 'Pasta',
      },
      {
        name: 'Tomato sauce beta',
        category: 'Canned Goods',
        quantity: 1,
        expirationDate: '2035-01-01',
        isOpened: false,
        notes: 'Pasta',
      },
      {
        name: 'Tomato paste opened',
        category: 'Canned Goods',
        quantity: 1,
        expirationDate: '2035-01-01',
        isOpened: true,
        notes: 'Pasta',
      },
      {
        name: 'Tomato seed packet',
        category: 'Produce & Veggies',
        quantity: 1,
        expirationDate: '2035-01-01',
        isOpened: false,
        notes: 'Pasta',
      },
    ];
    for (const product of candidates) {
      const response = await apiFetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(product),
      });
      assert.equal(response.status, 201);
    }
    const query =
      '/api/products?search=Tomato%20sauce&category=Canned%20Goods&expiryStatus=fresh&opened=sealed&sortBy=name&sortOrder=desc&limit=1';
    const response = await apiFetch(query);
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.total, 2);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].name, 'Tomato sauce beta');
    assert.equal(page.hasMore, true);

    const otherUserResponse = await fetch(`${baseUrl}${query}`, { headers: { Authorization: secondAuthorization } });
    assert.equal(otherUserResponse.status, 200);
    assert.equal((await otherUserResponse.json()).total, 0);
  });

  test('rejects invalid list filter and sort values', async () => {
    for (const query of [
      '?expiryStatus=soon',
      '?opened=yes',
      '?sortBy=quantity',
      '?sortOrder=random',
      '?search=a&search=b',
    ]) {
      const response = await apiFetch(`/api/products${query}`);
      assert.equal(response.status, 400, query);
    }
  });

  test('GET /api/products/:id returns specific product', async () => {
    const res = await apiFetch('/api/products/prod-01');
    assert.equal(res.status, 200);
    const product = await res.json();
    assert.equal(product.id, 'prod-01');
    assert.equal(product.name, 'Whole Milk 3.5%');
  });

  test('GET /api/products/:id returns 404 for non-existent item', async () => {
    const res = await apiFetch('/api/products/non-existent-id-999');
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.ok(data.error);
  });

  test('POST /api/products adds a new product', async () => {
    const newProductPayload = {
      name: 'Organic Honey',
      category: 'Pantry & Dry Goods',
      quantity: 1,
      unit: 'jar (500g)',
      expirationDate: '2028-01-01',
      isOpened: false,
      notes: 'Raw unpasteurized honey',
    };

    const res = await apiFetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newProductPayload),
    });

    assert.equal(res.status, 201);
    const created = await res.json();
    assert.ok(created.id);
    assert.equal(created.name, newProductPayload.name);
    assert.equal(created.category, newProductPayload.category);
    assert.equal(created.quantity, 1);
    assert.equal(created.isOpened, false);

    // Verify it is in the list
    const getRes = await apiFetch(`/api/products/${created.id}`);
    assert.equal(getRes.status, 200);
  });

  test('POST /api/products rejects invalid payload with 400', async () => {
    const invalidPayload = {
      name: '',
      quantity: -5,
    };

    const res = await apiFetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invalidPayload),
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'Validation failed');
    assert.ok(data.details.length > 0);
  });

  test('PUT /api/products/:id updates an existing product', async () => {
    const updatePayload = {
      quantity: 5,
      isOpened: true,
      notes: 'Updated opened status and quantity',
    };

    const res = await apiFetch('/api/products/prod-02', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatePayload),
    });

    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.id, 'prod-02');
    assert.equal(updated.quantity, 5);
    assert.equal(updated.isOpened, true);
    assert.equal(updated.notes, updatePayload.notes);
  });

  test('PUT /api/products/:id returns 404 for unknown product', async () => {
    const res = await apiFetch('/api/products/unknown-product-xyz', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Valid Name' }),
    });

    assert.equal(res.status, 404);
  });

  test('DELETE /api/products/:id removes a product', async () => {
    // Delete prod-04
    const res = await apiFetch('/api/products/prod-04', {
      method: 'DELETE',
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.message.includes('deleted successfully'));

    // Confirm it returns 404 now
    const checkRes = await apiFetch('/api/products/prod-04');
    assert.equal(checkRes.status, 404);
  });

  test('DELETE /api/products/:id returns 404 for non-existent product', async () => {
    const res = await apiFetch('/api/products/already-deleted-item', {
      method: 'DELETE',
    });

    assert.equal(res.status, 404);
  });

  test('scopes product listing and mutations to the JWT owner', async () => {
    const createdResponse = await apiFetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'attacker-chosen-id',
        ownerId: 'attacker-chosen-owner',
        name: 'Private Almonds',
        category: 'Pantry',
        quantity: 2,
        expirationDate: '2030-01-01',
        isOpened: false,
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.notEqual(created.id, 'attacker-chosen-id');
    assert.equal(created.ownerId, ownerId);

    const otherListResponse = await fetch(`${baseUrl}/api/products`, {
      headers: { Authorization: secondAuthorization },
    });
    const otherProducts = (await otherListResponse.json()).items;
    assert.equal(
      otherProducts.some((product) => product.id === created.id),
      false,
    );

    for (const [method, body] of [
      ['GET', undefined],
      ['PUT', { name: 'Stolen product', ownerId }],
      ['DELETE', undefined],
    ]) {
      const response = await fetch(`${baseUrl}/api/products/${created.id}`, {
        method,
        headers: {
          Authorization: secondAuthorization,
          ...(body && { 'Content-Type': 'application/json' }),
        },
        ...(body && { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, 404);
      assert.equal(JSON.stringify(await response.json()).includes('Private Almonds'), false);
    }

    const stillOwnedResponse = await apiFetch(`/api/products/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerId: 'spoofed-owner', quantity: 5 }),
    });
    assert.equal(stillOwnedResponse.status, 200);
    const updated = await stillOwnedResponse.json();
    assert.equal(updated.ownerId, ownerId);
    assert.equal(updated.quantity, 5);
  });

  test('honors an owner-scoped idempotency key for offline create retries', async () => {
    const headers = {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'offline-create-request-01',
    };
    const body = JSON.stringify({
      name: 'Retry-safe Rice',
      category: 'Pantry',
      quantity: 1,
      expirationDate: '2030-01-01',
      isOpened: false,
    });
    const first = await apiFetch('/api/products', { method: 'POST', headers, body });
    assert.equal(first.status, 201);
    const product = await first.json();

    const retry = await apiFetch('/api/products', { method: 'POST', headers, body });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).id, product.id);

    const otherUserRequest = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: { ...headers, Authorization: secondAuthorization },
      body,
    });
    assert.equal(otherUserRequest.status, 201);
    assert.notEqual((await otherUserRequest.json()).id, product.id);
  });

  function apiFetch(path, options = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { ...options.headers, Authorization: authorization },
    });
  }
});

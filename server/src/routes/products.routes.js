import { Router } from 'express';
import crypto from 'node:crypto';
import { initialProducts } from '../data/products.js';
import { broadcastNotification } from '../websocket.js';
import { requireAuth } from '../middleware/require-auth.js';

export const productsRouter = Router();
productsRouter.use(requireAuth);

// In-memory data store for this iteration
let products = [];
const initializedUserIds = new Set();
const createRequestsByKey = new Map();

function ensureUserInventory(userId) {
  if (initializedUserIds.has(userId)) return;
  products.push(...initialProducts.map((product) => ({ ...product, ownerId: userId })));
  initializedUserIds.add(userId);
}

function findOwnedProductIndex(userId, productId) {
  return products.findIndex((product) => product.id === productId && product.ownerId === userId);
}

/**
 * Validate product payload
 * @param {object} body
 * @param {boolean} isUpdate
 */
function validateProduct(body, isUpdate = false) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['Request body must be a JSON object'];
  }

  if (!isUpdate || body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      errors.push('Field "name" must be a non-empty string');
    }
  }

  if (!isUpdate || body.category !== undefined) {
    if (typeof body.category !== 'string' || body.category.trim().length === 0) {
      errors.push('Field "category" must be a non-empty string');
    }
  }

  if (!isUpdate || body.quantity !== undefined) {
    if (typeof body.quantity !== 'number' || isNaN(body.quantity) || body.quantity < 0) {
      errors.push('Field "quantity" must be a non-negative number');
    }
  }

  if (!isUpdate || body.expirationDate !== undefined) {
    if (
      typeof body.expirationDate !== 'string' ||
      body.expirationDate.trim().length === 0 ||
      isNaN(Date.parse(body.expirationDate))
    ) {
      errors.push('Field "expirationDate" must be a valid date string (e.g. YYYY-MM-DD)');
    }
  }

  if (!isUpdate || body.isOpened !== undefined) {
    if (typeof body.isOpened !== 'boolean') {
      errors.push('Field "isOpened" must be a boolean');
    }
  }

  return errors;
}

/**
 * GET /api/products
 * Returns all products
 */
productsRouter.get('/', (req, res) => {
  ensureUserInventory(req.auth.userId);
  const { category, search, expiryStatus, opened, sortBy, sortOrder } = req.query;
  const limit = parsePaginationValue(req.query.limit, 20);
  const offset = parsePaginationValue(req.query.offset, 0);
  if (limit === null || limit < 1 || limit > 100 || offset === null || offset > Number.MAX_SAFE_INTEGER) {
    return res
      .status(400)
      .json({ error: 'Pagination requires an integer limit from 1 to 100 and a non-negative offset.' });
  }
  if (
    (category !== undefined && typeof category !== 'string') ||
    (search !== undefined && typeof search !== 'string') ||
    (expiryStatus !== undefined && typeof expiryStatus !== 'string') ||
    (opened !== undefined && typeof opened !== 'string') ||
    (sortBy !== undefined && typeof sortBy !== 'string') ||
    (sortOrder !== undefined && typeof sortOrder !== 'string')
  ) {
    return res.status(400).json({ error: 'Search, filter, and sort values must be single strings.' });
  }
  if ((search && search.length > 100) || (category && category.length > 80)) {
    return res.status(400).json({ error: 'Search is limited to 100 characters and category to 80 characters.' });
  }
  if (expiryStatus && !['expired', 'expiring', 'fresh'].includes(expiryStatus)) {
    return res.status(400).json({ error: 'expiryStatus must be expired, expiring, or fresh.' });
  }
  if (opened && !['opened', 'sealed'].includes(opened)) {
    return res.status(400).json({ error: 'opened must be opened or sealed.' });
  }
  if (sortBy && !['name', 'expirationDate'].includes(sortBy)) {
    return res.status(400).json({ error: 'sortBy must be name or expirationDate.' });
  }
  if (sortOrder && !['asc', 'desc'].includes(sortOrder)) {
    return res.status(400).json({ error: 'sortOrder must be asc or desc.' });
  }

  // Ownership is applied before sorting and pagination so users cannot infer other accounts' records.
  let result = products.filter((product) => product.ownerId === req.auth.userId);

  if (category) {
    result = result.filter((p) => p.category.toLowerCase() === String(category).toLowerCase());
  }

  if (search) {
    const q = search.toLowerCase();
    result = result.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        (p.notes && p.notes.toLowerCase().includes(q)),
    );
  }

  if (opened) result = result.filter((product) => product.isOpened === (opened === 'opened'));
  if (expiryStatus) {
    const today = new Date().toISOString().slice(0, 10);
    const expiringThrough = new Date(`${today}T00:00:00.000Z`);
    expiringThrough.setUTCDate(expiringThrough.getUTCDate() + 3);
    const expiringThroughDate = expiringThrough.toISOString().slice(0, 10);
    result = result.filter((product) => {
      if (expiryStatus === 'expired') return product.expirationDate < today;
      if (expiryStatus === 'expiring')
        return product.expirationDate >= today && product.expirationDate <= expiringThroughDate;
      return product.expirationDate > expiringThroughDate;
    });
  }

  // Sort on immutable fields or stable IDs, with an ID tie-break to keep page boundaries predictable.
  const direction = sortOrder === 'desc' ? -1 : 1;
  result.sort((left, right) => {
    const primary =
      sortBy === 'name'
        ? compareValues(left.name.toLowerCase(), right.name.toLowerCase())
        : sortBy === 'expirationDate'
          ? compareValues(left.expirationDate, right.expirationDate)
          : 0;
    return direction * (primary || compareValues(left.id, right.id));
  });
  const total = result.length;
  const items = result.slice(offset, offset + limit);
  res.json({ items, limit, offset, total, hasMore: offset + items.length < total });
});

function parsePaginationValue(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function compareValues(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * GET /api/products/:id
 * Returns a single product by ID or 404
 */
productsRouter.get('/:id', (req, res) => {
  ensureUserInventory(req.auth.userId);
  const { id } = req.params;
  const product = products.find((p) => p.id === id && p.ownerId === req.auth.userId);

  if (!product) {
    return res.status(404).json({
      error: `Product with ID '${id}' was not found.`,
    });
  }

  res.json(product);
});

/**
 * POST /api/products
 * Adds a new product to inventory
 */
productsRouter.post('/', (req, res) => {
  const validationErrors = validateProduct(req.body, false);
  if (validationErrors.length > 0) {
    return res.status(400).json({
      error: 'Validation failed',
      details: validationErrors,
    });
  }

  const { name, category, quantity, expirationDate, isOpened, unit, notes } = req.body;

  ensureUserInventory(req.auth.userId);
  const idempotencyKey = req.get('Idempotency-Key');
  if (idempotencyKey && !/^[\w.:-]{1,128}$/.test(idempotencyKey)) {
    return res.status(400).json({ error: 'Invalid Idempotency-Key header.' });
  }
  const scopedKey = idempotencyKey ? `${req.auth.userId}:${idempotencyKey}` : null;
  const previousId = scopedKey ? createRequestsByKey.get(scopedKey) : null;
  const previousProduct = previousId
    ? products.find((product) => product.id === previousId && product.ownerId === req.auth.userId)
    : null;
  if (previousProduct) return res.status(200).json(previousProduct);

  const newProduct = {
    id: `prod-${crypto.randomUUID().slice(0, 8)}`,
    ownerId: req.auth.userId,
    name: name.trim(),
    category: category.trim(),
    quantity: Number(quantity),
    expirationDate: expirationDate.trim(),
    isOpened: Boolean(isOpened),
    ...(unit !== undefined && { unit: String(unit).trim() }),
    ...(notes !== undefined && { notes: String(notes).trim() }),
  };

  products.push(newProduct);
  if (scopedKey) createRequestsByKey.set(scopedKey, newProduct.id);

  broadcastNotification(
    {
      type: 'PRODUCT_ADDED',
      message: `Added new pantry item: "${newProduct.name}" (${newProduct.quantity} ${newProduct.unit || 'units'})`,
      productId: newProduct.id,
      product: newProduct,
      timestamp: new Date().toISOString(),
    },
    newProduct.ownerId,
  );

  res.status(201).json(newProduct);
});

/**
 * PUT /api/products/:id
 * Updates an existing product or returns 404
 */
productsRouter.put('/:id', (req, res) => {
  ensureUserInventory(req.auth.userId);
  const { id } = req.params;
  const index = findOwnedProductIndex(req.auth.userId, id);

  if (index === -1) {
    return res.status(404).json({
      error: `Product with ID '${id}' was not found.`,
    });
  }

  const validationErrors = validateProduct(req.body, true);
  if (validationErrors.length > 0) {
    return res.status(400).json({
      error: 'Validation failed',
      details: validationErrors,
    });
  }

  const existing = products[index];
  const { name, category, quantity, expirationDate, isOpened, unit, notes } = req.body;

  const updatedProduct = {
    ...existing,
    ...(name !== undefined && { name: name.trim() }),
    ...(category !== undefined && { category: category.trim() }),
    ...(quantity !== undefined && { quantity: Number(quantity) }),
    ...(expirationDate !== undefined && { expirationDate: expirationDate.trim() }),
    ...(isOpened !== undefined && { isOpened: Boolean(isOpened) }),
    ...(unit !== undefined && { unit: String(unit).trim() }),
    ...(notes !== undefined && { notes: String(notes).trim() }),
    id, // ensure ID and owner cannot be altered by request bodies
    ownerId: req.auth.userId,
  };

  products[index] = updatedProduct;

  broadcastNotification(
    {
      type: 'PRODUCT_UPDATED',
      message: `Updated item: "${updatedProduct.name}"`,
      productId: updatedProduct.id,
      product: updatedProduct,
      timestamp: new Date().toISOString(),
    },
    updatedProduct.ownerId,
  );

  res.json(updatedProduct);
});

/**
 * DELETE /api/products/:id
 * Deletes a product or returns 404
 */
productsRouter.delete('/:id', (req, res) => {
  ensureUserInventory(req.auth.userId);
  const { id } = req.params;
  const index = findOwnedProductIndex(req.auth.userId, id);

  if (index === -1) {
    return res.status(404).json({
      error: `Product with ID '${id}' was not found.`,
    });
  }

  const deletedProduct = products[index];
  products.splice(index, 1);
  for (const [key, productId] of createRequestsByKey) {
    if (key.startsWith(`${req.auth.userId}:`) && productId === id) createRequestsByKey.delete(key);
  }

  broadcastNotification(
    {
      type: 'PRODUCT_DELETED',
      message: `Removed item from pantry: "${deletedProduct.name}"`,
      productId: id,
      product: deletedProduct,
      timestamp: new Date().toISOString(),
    },
    deletedProduct.ownerId,
  );

  res.json({
    message: `Product '${deletedProduct.name}' (ID: ${id}) deleted successfully.`,
    deletedProduct,
  });
});

/**
 * POST /api/products/reset
 * Helper endpoint to reset in-memory data
 */
productsRouter.post('/reset', (req, res) => {
  const userId = req.auth.userId;
  products = products.filter((product) => product.ownerId !== userId);
  for (const key of createRequestsByKey.keys()) {
    if (key.startsWith(`${userId}:`)) createRequestsByKey.delete(key);
  }
  products.push(...initialProducts.map((product) => ({ ...product, ownerId: userId })));
  initializedUserIds.add(userId);
  res.json({
    message: 'Products reset to initial sample dataset.',
    count: initialProducts.length,
  });
});

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { PendingProductChange } from '../models/pending-product-change.model';
import type { Product } from '../models/product.model';

import { AuthService } from './auth.service';
import { LocalProductStorageService } from './local-product-storage.service';
import { NetworkService } from './network-status.service';
import { PhotoStorageService } from './photo-storage.service';
import { ProductService } from './product.service';

const testUser = { id: 'product-test-user', email: 'product-test@pantrypal.local' };

describe('ProductService', () => {
  let service: ProductService;
  let httpTestingController: HttpTestingController;
  let networkStatus: { connected: boolean };
  let networkEvents: BehaviorSubject<{ connected: boolean; connectionType: string }>;
  let persistedProducts: Product[] | null;
  let persistedQueue: PendingProductChange[];
  beforeEach(async () => {
    networkStatus = { connected: true };
    networkEvents = new BehaviorSubject<{ connected: boolean; connectionType: string }>({
      connected: true,
      connectionType: 'wifi',
    });
    persistedProducts = null;
    persistedQueue = [];
    TestBed.configureTestingModule({
      providers: [
        ProductService,
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: PhotoStorageService, useValue: { deletePhoto: async () => true } },
        { provide: AuthService, useValue: { user$: new BehaviorSubject(testUser) } },
        {
          provide: LocalProductStorageService,
          useValue: {
            getProducts: async () => persistedProducts,
            saveProducts: async (_ownerId: string, products: Product[]) => {
              persistedProducts = products;
              return true;
            },
            getPendingChanges: async () => persistedQueue,
            savePendingChanges: async (_ownerId: string, changes: PendingProductChange[]) => {
              persistedQueue = changes;
              return true;
            },
          },
        },
        {
          provide: NetworkService,
          useValue: {
            get currentStatus() {
              return networkStatus;
            },
            status$: networkEvents.asObservable(),
          },
        },
      ],
    });
    service = TestBed.inject(ProductService);
    httpTestingController = TestBed.inject(HttpTestingController);

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Initial loadProducts call in constructor
    const req = expectPageRequest(0);
    expect(req.request.method).toBe('GET');
    req.flush(
      pageResponse([
        {
          id: 'prod-01',
          ownerId: testUser.id,
          name: 'Whole Milk 3.5%',
          category: 'Dairy & Eggs',
          quantity: 2,
          expirationDate: '2026-10-31',
          isOpened: true,
        },
      ]),
    );
  });

  afterEach(() => {
    httpTestingController.verify();
  });

  it('should be created and load initial products', () => {
    expect(service).toBeTruthy();
    service.products$.subscribe((products) => {
      expect(products.length).toBe(1);
      expect(products[0].name).toBe('Whole Milk 3.5%');
    });
  });

  it('should calculate expiration info for past dates as expired', () => {
    const info = service.getExpirationInfo('2020-01-01');
    expect(info.state).toBe('expired');
    expect(info.color).toBe('danger');
    expect(info.daysRemaining).toBeLessThan(0);
  });

  it('should calculate expiration info for future dates as fresh', () => {
    const info = service.getExpirationInfo('2030-01-01');
    expect(info.state).toBe('fresh');
    expect(info.color).toBe('success');
    expect(info.daysRemaining).toBeGreaterThan(3);
  });

  it('should return appropriate icon for category', () => {
    expect(service.getCategoryIcon('Produce & Veggies')).toBe('nutrition-outline');
    expect(service.getCategoryIcon('Dairy & Eggs')).toBe('egg-outline');
    expect(service.getCategoryIcon('Other Item')).toBe('basket-outline');
  });

  it('should fetch single product by id via GET /api/products/:id', () => {
    service.getProductById('prod-01').subscribe((product) => {
      expect(product.id).toBe('prod-01');
      expect(product.name).toBe('Whole Milk 3.5%');
    });

    const req = httpTestingController.expectOne('http://localhost:3000/api/products/prod-01');
    expect(req.request.method).toBe('GET');
    req.flush({
      id: 'prod-01',
      ownerId: testUser.id,
      name: 'Whole Milk 3.5%',
      category: 'Dairy & Eggs',
      quantity: 2,
      expirationDate: '2026-10-31',
      isOpened: true,
    });
  });

  it('keeps a failed create durably queued with its product data', async () => {
    const create = service.createProduct({
      name: 'Offline Lentils',
      category: 'Pantry',
      quantity: 2,
      expirationDate: '2030-02-01',
      isOpened: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = httpTestingController.expectOne('http://localhost:3000/api/products');
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Idempotency-Key')).toBeTruthy();
    request.flush({ error: 'Unavailable' }, { status: 503, statusText: 'Unavailable' });

    const result = await create;
    expect(result.status).toBe('pending');
    expect(result.message).toContain('Saved on this device');
    expect(persistedQueue).toHaveLength(1);
    expect(persistedQueue[0].product?.name).toBe('Offline Lentils');
    await expect(firstValueFrom(service.products$)).resolves.toContainEqual(persistedQueue[0].product);

    const mutationId = persistedQueue[0].id;
    const retry = service.retryPendingChange(mutationId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const retryRequest = httpTestingController.expectOne('http://localhost:3000/api/products');
    expect(retryRequest.request.headers.get('Idempotency-Key')).toBe(mutationId);
    retryRequest.flush({
      id: 'prod-retried-create',
      ownerId: testUser.id,
      name: 'Offline Lentils',
      category: 'Pantry',
      quantity: 2,
      expirationDate: '2030-02-01',
      isOpened: false,
    });
    await expect(retry).resolves.toMatchObject({ status: 'synced' });
    expect(persistedQueue).toHaveLength(0);
    await expect(firstValueFrom(service.products$)).resolves.toContainEqual(
      expect.objectContaining({ id: 'prod-retried-create', name: 'Offline Lentils' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const refresh = expectPageRequest(0);
    expect(refresh.request.method).toBe('GET');
    refresh.flush(
      pageResponse([
        {
          id: 'prod-01',
          ownerId: testUser.id,
          name: 'Whole Milk 3.5%',
          category: 'Dairy & Eggs',
          quantity: 2,
          expirationDate: '2026-10-31',
          isOpened: true,
        },
        {
          id: 'prod-retried-create',
          ownerId: testUser.id,
          name: 'Offline Lentils',
          category: 'Pantry',
          quantity: 2,
          expirationDate: '2030-02-01',
          isOpened: false,
        },
      ]),
    );
  });

  it('keeps a failed online update visible and queued instead of discarding the edit', async () => {
    const update = service.updateProduct('prod-01', {
      name: 'Edited Milk',
      category: 'Dairy & Eggs',
      quantity: 4,
      unit: 'cartons',
      expirationDate: '2026-10-31',
      isOpened: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = httpTestingController.expectOne('http://localhost:3000/api/products/prod-01');
    expect(request.request.method).toBe('PUT');
    request.flush({ error: 'Unavailable' }, { status: 503, statusText: 'Unavailable' });

    expect((await update).status).toBe('pending');
    expect(persistedQueue[0].product?.name).toBe('Edited Milk');
    await expect(firstValueFrom(service.products$)).resolves.toContainEqual(
      expect.objectContaining({ id: 'prod-01', name: 'Edited Milk' }),
    );
  });

  it('stores an offline update and hides an offline deletion until retry', async () => {
    networkStatus.connected = false;
    networkEvents.next({ connected: false, connectionType: 'none' });
    const update = await service.updateProduct('prod-01', {
      name: 'Edited Milk',
      category: 'Dairy & Eggs',
      quantity: 4,
      unit: 'cartons',
      expirationDate: '2026-10-31',
      isOpened: true,
    });
    expect(update.status).toBe('pending');
    expect(persistedQueue[0].product?.name).toBe('Edited Milk');
    await expect(firstValueFrom(service.products$)).resolves.toContainEqual(
      expect.objectContaining({ id: 'prod-01', name: 'Edited Milk' }),
    );

    const deletion = await service.deleteProduct('prod-01');
    expect(deletion.status).toBe('pending');
    expect(persistedQueue.some((change) => change.type === 'delete' && change.product?.name === 'Edited Milk')).toBe(
      true,
    );
    await expect(firstValueFrom(service.products$)).resolves.not.toContainEqual(
      expect.objectContaining({ id: 'prod-01' }),
    );
  });

  it('automatically sends an offline create once connectivity returns and clears the queue', async () => {
    networkStatus.connected = false;
    networkEvents.next({ connected: false, connectionType: 'none' });
    const result = await service.createProduct({
      name: 'Reconnect apples',
      category: 'Produce',
      quantity: 5,
      expirationDate: '2030-03-01',
      isOpened: false,
    });
    expect(result.status).toBe('pending');
    expect(persistedQueue).toHaveLength(1);
    httpTestingController.expectNone('http://localhost:3000/api/products');

    networkStatus.connected = true;
    networkEvents.next({ connected: true, connectionType: 'wifi' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = httpTestingController.expectOne('http://localhost:3000/api/products');
    const operationId = persistedQueue[0].id;
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Idempotency-Key')).toBe(operationId);

    const manualSyncA = service.syncNow();
    const manualSyncB = service.syncNow();
    httpTestingController.expectNone('http://localhost:3000/api/products');
    request.flush({
      id: 'prod-reconnected',
      ownerId: testUser.id,
      name: 'Reconnect apples',
      category: 'Produce',
      quantity: 5,
      expirationDate: '2030-03-01',
      isOpened: false,
    });
    await Promise.all([manualSyncA, manualSyncB]);
    expect(persistedQueue).toHaveLength(0);
    expect(service.getPendingChangesSnapshot()).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const refresh = expectPageRequest(0);
    refresh.flush(
      pageResponse([
        {
          id: 'prod-01',
          ownerId: testUser.id,
          name: 'Whole Milk 3.5%',
          category: 'Dairy & Eggs',
          quantity: 2,
          expirationDate: '2026-10-31',
          isOpened: true,
        },
        {
          id: 'prod-reconnected',
          ownerId: testUser.id,
          name: 'Reconnect apples',
          category: 'Produce',
          quantity: 5,
          expirationDate: '2030-03-01',
          isOpened: false,
        },
      ]),
    );
  });

  it('keeps validation failures queued and marks them as needing attention', async () => {
    networkStatus.connected = false;
    networkEvents.next({ connected: false, connectionType: 'none' });
    const result = await service.createProduct({
      name: 'Needs correction',
      category: 'Produce',
      quantity: 1,
      expirationDate: '2030-03-01',
      isOpened: false,
    });
    expect(result.status).toBe('pending');
    networkStatus.connected = true;
    networkEvents.next({ connected: true, connectionType: 'wifi' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = httpTestingController.expectOne('http://localhost:3000/api/products');
    request.flush({ error: 'Invalid product data.' }, { status: 422, statusText: 'Unprocessable Entity' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(persistedQueue).toHaveLength(1);
    expect(persistedQueue[0].lastError).toContain('Invalid product data');
    expect(service['syncStatusSubject'].value.state).toBe('attention');
    httpTestingController.expectNone('http://localhost:3000/api/products');
  });

  it('appends server pages without duplicate products and disables paging at the end', async () => {
    service.loadProducts();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstPage = expectPageRequest(0);
    firstPage.flush(pageResponse([makeProduct('prod-01', 'Milk')], 0, 2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service['hasMoreSubject'].value).toBe(true);

    const loading = service.loadNextPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondPage = expectPageRequest(1);
    secondPage.flush(pageResponse([makeProduct('prod-02', 'Bread')], 1, 2));
    await loading;

    expect(service['productsSubject'].value.map((product) => product.id)).toEqual(['prod-01', 'prod-02']);
    expect(service['hasMoreSubject'].value).toBe(false);
  });

  it('keeps a local photo reference on server create while excluding local file data from REST', async () => {
    const pendingCreate = service.createProduct({
      name: 'Photo pantry item',
      category: 'Pantry',
      quantity: 1,
      expirationDate: '2035-01-01',
      isOpened: false,
      photoPath: 'pantrypal-photos/product-test-user/photo.jpg',
      photoMimeType: 'image/jpeg',
      photoPreviewUrl: 'blob:temporary-preview',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = httpTestingController.expectOne('http://localhost:3000/api/products');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).not.toHaveProperty('photoPath');
    expect(request.request.body).not.toHaveProperty('photoPreviewUrl');
    request.flush(makeProduct('server-photo-product', 'Photo pantry item'));
    const result = await pendingCreate;

    expect(result.product?.photoPath).toBe('pantrypal-photos/product-test-user/photo.jpg');
    const cached = persistedProducts?.find((product) => product.id === 'server-photo-product');
    expect(cached?.photoPath).toBe('pantrypal-photos/product-test-user/photo.jpg');
    expect(cached).not.toHaveProperty('photoPreviewUrl');
  });

  it('preserves an existing photo reference when the product is edited without replacing its photo', async () => {
    const existingProduct = {
      ...makeProduct('photo-edit-product', 'Milk'),
      photoPath: 'pantrypal-photos/product-test-user/existing.jpg',
      photoMimeType: 'image/jpeg',
    };
    service.loadProducts();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expectPageRequest(0).flush(pageResponse([existingProduct], 0, 1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const update = service.updateProduct(existingProduct.id, {
      name: 'Milk, edited',
      category: existingProduct.category,
      quantity: existingProduct.quantity,
      expirationDate: existingProduct.expirationDate,
      isOpened: existingProduct.isOpened,
      notes: existingProduct.notes,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = httpTestingController.expectOne(`http://localhost:3000/api/products/${existingProduct.id}`);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).not.toHaveProperty('photoPath');
    request.flush(makeProduct(existingProduct.id, 'Milk, edited'));
    const result = await update;

    expect(result.product?.photoPath).toBe(existingProduct.photoPath);
    expect(persistedProducts?.find((item) => item.id === existingProduct.id)?.photoPath).toBe(
      existingProduct.photoPath,
    );
  });

  it('handles an empty first page and a failed next page with a retryable error', async () => {
    service.loadProducts();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expectPageRequest(0).flush(pageResponse([], 0, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service['productsSubject'].value).toEqual([]);
    expect(service['hasMoreSubject'].value).toBe(false);

    service.loadProducts();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expectPageRequest(0).flush(pageResponse([makeProduct('prod-01', 'Milk')], 0, 2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const loading = service.loadNextPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expectPageRequest(1).flush({ error: 'Temporary failure' }, { status: 503, statusText: 'Unavailable' });
    await loading;

    expect(service['productsSubject'].value.map((product) => product.id)).toEqual(['prod-01']);
    expect(service['hasMoreSubject'].value).toBe(true);
    expect(service['pageErrorSubject'].value).toContain('Temporary failure');

    const retry = service.loadNextPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expectPageRequest(1).flush(pageResponse([makeProduct('prod-02', 'Bread')], 1, 2));
    await retry;
    expect(service['productsSubject'].value.map((product) => product.id)).toEqual(['prod-01', 'prod-02']);
  });

  it('ignores an old page response when search criteria change during scrolling', async () => {
    service.loadProducts();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expectPageRequest(0).flush(pageResponse([makeProduct('prod-01', 'Milk')], 0, 30));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const staleLoad = service.loadNextPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stalePage = expectPageRequest(1);
    service.setSearchCriteria({
      search: 'Yogurt',
      category: 'Dairy & Eggs',
      expiryStatus: '',
      opened: '',
      sortBy: 'id',
      sortOrder: 'asc',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const filteredPage = expectPageRequest(0, 'Yogurt', 'Dairy & Eggs');
    filteredPage.flush(pageResponse([makeProduct('prod-yogurt', 'Greek Yogurt', 'Dairy & Eggs')], 0, 1));
    stalePage.flush(pageResponse([makeProduct('prod-02', 'Bread')], 1, 30));
    await staleLoad;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service['productsSubject'].value.map((product) => product.name)).toEqual(['Greek Yogurt']);
    expect(service['hasMoreSubject'].value).toBe(false);
  });

  it('applies combined criteria to offline cache and includes matching pending creations', async () => {
    networkStatus.connected = false;
    persistedProducts = [
      {
        ...makeProduct('cached-match', 'Tomato sauce', 'Canned Goods'),
        isOpened: false,
        expirationDate: '2035-01-01',
        notes: 'Pasta night',
      },
      { ...makeProduct('cached-open', 'Tomato paste', 'Canned Goods'), isOpened: true, expirationDate: '2035-01-01' },
      {
        ...makeProduct('cached-category', 'Tomato seeds', 'Produce & Veggies'),
        isOpened: false,
        expirationDate: '2035-01-01',
      },
    ];
    persistedQueue = [
      {
        id: 'pending-create',
        ownerId: testUser.id,
        productId: 'local-tomato',
        type: 'create',
        product: {
          ...makeProduct('local-tomato', 'Tomato jar', 'Canned Goods'),
          isOpened: false,
          expirationDate: '2035-02-01',
        },
        createdAt: new Date().toISOString(),
        attempts: 0,
      },
    ];
    service['setPendingChanges'](persistedQueue);
    service.setSearchCriteria({
      search: 'tomato',
      category: 'Canned Goods',
      expiryStatus: 'fresh',
      opened: 'sealed',
      sortBy: 'name',
      sortOrder: 'asc',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service['productsSubject'].value.map((product) => product.id)).toEqual(['local-tomato', 'cached-match']);
    expect(service['cachedOnlySubject'].value).toBe(true);
  });
});

function expectPageRequest(offset: number, search?: string, category?: string) {
  return TestBed.inject(HttpTestingController).expectOne(
    (request) =>
      request.url === 'http://localhost:3000/api/products' &&
      request.params.get('limit') === '20' &&
      request.params.get('offset') === String(offset) &&
      request.params.get('search') === (search ?? null) &&
      request.params.get('category') === (category ?? null),
  );
}

function pageResponse(items: Product[], offset = 0, total = items.length) {
  return { items, limit: 20, offset, total, hasMore: offset + items.length < total };
}

function makeProduct(id: string, name: string, category = 'Pantry'): Product {
  return {
    id,
    ownerId: testUser.id,
    name,
    category,
    quantity: 1,
    expirationDate: '2030-01-01',
    isOpened: false,
  };
}

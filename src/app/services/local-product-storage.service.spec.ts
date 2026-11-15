import { TestBed } from '@angular/core/testing';
import { Storage } from '@ionic/storage-angular';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import type { PendingProductChange } from '../models/pending-product-change.model';
import type { Product } from '../models/product.model';

import { LocalProductStorageService } from './local-product-storage.service';

describe('LocalProductStorageService', () => {
  let storage: LocalProductStorageService;
  let database: Map<string, unknown>;
  let ionicStorage: Storage;

  beforeEach(() => {
    database = new Map();
    const store = {
      create: async () => store,
      get: async (key: string) => database.get(key) ?? null,
      set: async (key: string, value: unknown) => database.set(key, value),
      remove: async (key: string) => database.delete(key),
    };
    ionicStorage = store as unknown as Storage;
    TestBed.configureTestingModule({
      providers: [LocalProductStorageService, { provide: Storage, useValue: ionicStorage }],
    });
    storage = TestBed.inject(LocalProductStorageService);
  });

  afterEach(() => TestBed.resetTestingModule());
  const product: Product = {
    id: 'local-product-01',
    ownerId: 'storage-test-user',
    name: 'Local Oats',
    category: 'Pantry',
    quantity: 1,
    expirationDate: '2030-01-01',
    isOpened: false,
  };

  it('persists and restores typed product data', async () => {
    expect(await storage.saveProducts(product.ownerId, [product])).toBe(true);
    await expect(storage.getProducts(product.ownerId)).resolves.toEqual([product]);
  });

  it('persists pending product changes locally', async () => {
    const change: PendingProductChange = {
      id: 'change-01',
      ownerId: product.ownerId,
      type: 'update',
      productId: product.id,
      product,
      createdAt: '2030-01-01T00:00:00.000Z',
      attempts: 0,
    };

    expect(await storage.clearPendingChanges(product.ownerId)).toBe(true);
    expect(await storage.addPendingChange(product.ownerId, change)).toBe(true);
    await expect(storage.getPendingChanges(product.ownerId)).resolves.toEqual([change]);
  });

  it('keeps saved pantry data isolated between authenticated owners', async () => {
    const otherOwnerProduct: Product = { ...product, id: 'other-owner-product', ownerId: 'another-user' };
    expect(await storage.saveProducts(product.ownerId, [product])).toBe(true);
    expect(await storage.saveProducts(otherOwnerProduct.ownerId, [otherOwnerProduct])).toBe(true);

    await expect(storage.getProducts(product.ownerId)).resolves.toEqual([product]);
    await expect(storage.getProducts(otherOwnerProduct.ownerId)).resolves.toEqual([otherOwnerProduct]);
  });

  it('restores product data after the storage service is recreated', async () => {
    expect(await storage.saveProducts(product.ownerId, [product])).toBe(true);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [LocalProductStorageService, { provide: Storage, useValue: ionicStorage }],
    });
    storage = TestBed.inject(LocalProductStorageService);

    await expect(storage.getProducts(product.ownerId)).resolves.toEqual([product]);
  });
});

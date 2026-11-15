import { TestBed } from '@angular/core/testing';
import { Filesystem } from '@capacitor/filesystem';
import { Storage } from '@ionic/storage-angular';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingProductChange } from '../models/pending-product-change.model';
import type { Product } from '../models/product.model';

import { LocalProductStorageService } from './local-product-storage.service';
import { PhotoStorageService } from './photo-storage.service';

const fileSystemFiles = new Map<string, string>();
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Filesystem: {
    writeFile: vi.fn(),
    readFile: vi.fn(),
    deleteFile: vi.fn(),
    getUri: vi.fn(),
  },
}));
describe('PhotoStorageService', () => {
  let service: PhotoStorageService;
  let products: Product[];
  let pending: PendingProductChange[];

  beforeEach(() => {
    fileSystemFiles.clear();
    products = [];
    pending = [];
    vi.mocked(Filesystem.writeFile).mockImplementation(async (options) => {
      fileSystemFiles.set(options.path, options.data as string);
      return { uri: `file://${options.path}` };
    });
    vi.mocked(Filesystem.readFile).mockImplementation(async (options) => {
      const data = fileSystemFiles.get(options.path);
      if (!data) throw new Error('File does not exist');
      return { data, blob: new Blob([data], { type: 'image/jpeg' }) };
    });
    vi.mocked(Filesystem.deleteFile).mockImplementation(async (options) => {
      if (!fileSystemFiles.delete(options.path)) throw new Error('File does not exist');
    });
    const store = new Map<string, unknown>();
    const storage = {
      create: async () => storage,
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: unknown) => store.set(key, value),
      remove: async (key: string) => store.delete(key),
    };
    TestBed.configureTestingModule({
      providers: [
        PhotoStorageService,
        LocalProductStorageService,
        { provide: Storage, useValue: storage },
        {
          provide: LocalProductStorageService,
          useValue: {
            getProducts: async () => products,
            getPendingChanges: async () => pending,
            hasStorageError: false,
          },
        },
      ],
    });
    service = TestBed.inject(PhotoStorageService);
  });

  afterEach(() => {
    vi.clearAllMocks();
    TestBed.resetTestingModule();
  });

  it('saves uniquely named files and restores them after service recreation', async () => {
    const first = await service.savePhoto('user-a', { base64: 'AQID', mimeType: 'image/jpeg' });
    const second = await service.savePhoto('user-a', { base64: 'BAUG', mimeType: 'image/jpeg' });
    expect(first.photoPath).not.toBe(second.photoPath);
    expect(first.photoPath).toContain('pantrypal-photos/user-a/');

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        PhotoStorageService,
        {
          provide: LocalProductStorageService,
          useValue: { getProducts: async () => [], getPendingChanges: async () => [], hasStorageError: false },
        },
      ],
    });
    const restartedService = TestBed.inject(PhotoStorageService);
    await expect(restartedService.readPhoto('user-a', first.photoPath)).resolves.toBe('AQID');
  });

  it('keeps a photo referenced by a cached or pending resource', async () => {
    const photo = await service.savePhoto('user-a', { base64: 'AQID', mimeType: 'image/jpeg' });
    const product: Product = {
      id: 'resource-1',
      ownerId: 'user-a',
      name: 'Beans',
      category: 'Pantry',
      quantity: 1,
      expirationDate: '2030-01-01',
      isOpened: false,
      photoPath: photo.photoPath,
    };
    products = [product];
    expect(await service.deletePhoto('user-a', photo.photoPath)).toBe(false);
    expect(Filesystem.deleteFile).not.toHaveBeenCalled();

    products = [];
    pending = [
      {
        id: 'change-1',
        ownerId: 'user-a',
        type: 'delete',
        productId: product.id,
        product,
        createdAt: '2030-01-01T00:00:00.000Z',
        attempts: 0,
      },
    ];
    expect(await service.deletePhoto('user-a', photo.photoPath)).toBe(false);
    expect(Filesystem.deleteFile).not.toHaveBeenCalled();
  });

  it('rejects another account trying to read a photo path', async () => {
    const photo = await service.savePhoto('user-a', { base64: 'AQID', mimeType: 'image/jpeg' });
    await expect(service.readPhoto('user-b', photo.photoPath)).rejects.toThrow('does not belong to the active account');
  });
});

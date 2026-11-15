import { Injectable, inject } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { Storage } from '@ionic/storage-angular';
import { BehaviorSubject } from 'rxjs';

import type { PendingProductChange } from '../models/pending-product-change.model';
import type { Product } from '../models/product.model';

@Injectable({ providedIn: 'root' })
export class LocalProductStorageService {
  private readonly storage = inject(Storage);
  private readonly productsKey = 'pantrypal.products.v1';
  private readonly pendingChangesKey = 'pantrypal.pending-product-changes.v1';
  private storageReady?: Promise<Storage>;

  private storageErrorSubject = new BehaviorSubject<string | null>(null);
  public storageError$ = this.storageErrorSubject.asObservable();

  public get hasStorageError(): boolean {
    return this.storageErrorSubject.value !== null;
  }

  public async getProducts(ownerId: string): Promise<Product[] | null> {
    const products = await this.readArray<Product>(
      this.scopedKey(this.productsKey, ownerId),
      (value): value is Product => this.isProduct(value, ownerId),
      this.legacyKey(this.productsKey, ownerId),
    );
    return products?.map((product) => this.withoutRuntimePhotoUrl(product)) ?? null;
  }

  public async saveProducts(ownerId: string, products: Product[]): Promise<boolean> {
    return this.write(
      this.scopedKey(this.productsKey, ownerId),
      products.map((product) => this.withoutRuntimePhotoUrl(product)),
      this.legacyKey(this.productsKey, ownerId),
    );
  }

  public async getPendingChanges(ownerId: string): Promise<PendingProductChange[]> {
    const changes = await this.readArray<PendingProductChange>(
      this.scopedKey(this.pendingChangesKey, ownerId),
      (value): value is PendingProductChange => this.isPendingChange(value, ownerId),
      this.legacyKey(this.pendingChangesKey, ownerId),
    );
    return (changes ?? []).map((change) => ({
      ...change,
      ...(change.product ? { product: this.withoutRuntimePhotoUrl(change.product) } : {}),
    }));
  }

  public async savePendingChanges(ownerId: string, changes: PendingProductChange[]): Promise<boolean> {
    return this.write(
      this.scopedKey(this.pendingChangesKey, ownerId),
      changes.map((change) => ({
        ...change,
        ...(change.product ? { product: this.withoutRuntimePhotoUrl(change.product) } : {}),
      })),
      this.legacyKey(this.pendingChangesKey, ownerId),
    );
  }

  public async addPendingChange(ownerId: string, change: PendingProductChange): Promise<boolean> {
    const currentChanges = await this.getPendingChanges(ownerId);
    return this.savePendingChanges(ownerId, [...currentChanges, change]);
  }

  public async clearPendingChanges(ownerId: string): Promise<boolean> {
    try {
      const storage = await this.getStorage();
      await storage.remove(this.scopedKey(this.pendingChangesKey, ownerId));
      await Preferences.remove({ key: this.legacyKey(this.pendingChangesKey, ownerId) });
      this.storageErrorSubject.next(null);
      return true;
    } catch (error) {
      this.reportError('Could not clear locally queued changes.', error);
      return false;
    }
  }

  private async readArray<T>(
    key: string,
    isItem: (value: unknown) => value is T,
    legacyKey: string,
  ): Promise<T[] | null> {
    try {
      const storage = await this.getStorage();
      let value: unknown = await storage.get(key);
      if (value === null || value === undefined) {
        const legacy = await Preferences.get({ key: legacyKey });
        if (legacy.value !== null) {
          value = JSON.parse(legacy.value) as unknown;
          if (Array.isArray(value) && value.every(isItem)) {
            await storage.set(key, value);
          }
        }
      }
      if (value === null || value === undefined) {
        this.storageErrorSubject.next(null);
        return null;
      }

      if (!Array.isArray(value) || !value.every(isItem)) {
        throw new Error('Stored data does not match the expected format.');
      }

      this.storageErrorSubject.next(null);
      return value;
    } catch (error) {
      try {
        const legacy = await Preferences.get({ key: legacyKey });
        if (legacy.value !== null) {
          const parsed: unknown = JSON.parse(legacy.value);
          if (Array.isArray(parsed) && parsed.every(isItem)) {
            this.storageErrorSubject.next('Ionic Storage is unavailable; reading the saved fallback copy.');
            return parsed;
          }
        }
      } catch {
        // Report the primary storage failure below when neither driver can read the record.
      }
      this.reportError('Could not read saved pantry data. The app will continue without it.', error);
      return null;
    }
  }

  private async write(key: string, value: unknown, legacyKey: string): Promise<boolean> {
    try {
      const storage = await this.getStorage();
      await storage.set(key, value);
      try {
        await Preferences.remove({ key: legacyKey });
      } catch {
        // Legacy-cache cleanup is best-effort; the Ionic Storage copy is already durable.
      }
      this.storageErrorSubject.next(null);
      return true;
    } catch (error) {
      try {
        // Keep data usable on platforms where the configured IndexedDB-backed store is unavailable.
        await Preferences.set({ key: legacyKey, value: JSON.stringify(value) });
        console.warn('[Pantry storage] Ionic Storage failed; saved using Capacitor Preferences.', error);
        this.storageErrorSubject.next('Ionic Storage is unavailable; using the saved fallback copy.');
        return true;
      } catch (fallbackError) {
        this.reportError('Could not save pantry data on this device.', fallbackError);
        return false;
      }
    }
  }

  private isProduct(value: unknown, ownerId: string): value is Product {
    if (!value || typeof value !== 'object') return false;
    const product = value as Partial<Product>;
    return (
      typeof product.id === 'string' &&
      product.ownerId === ownerId &&
      typeof product.name === 'string' &&
      typeof product.category === 'string' &&
      typeof product.quantity === 'number' &&
      typeof product.expirationDate === 'string' &&
      typeof product.isOpened === 'boolean' &&
      (product.photoPath === undefined ||
        (typeof product.photoPath === 'string' &&
          product.photoPath.startsWith(`pantrypal-photos/${encodeURIComponent(ownerId)}/`))) &&
      (product.photoMimeType === undefined || typeof product.photoMimeType === 'string')
    );
  }

  private isPendingChange(value: unknown, ownerId: string): value is PendingProductChange {
    if (!value || typeof value !== 'object') return false;
    const change = value as Partial<PendingProductChange>;
    return (
      typeof change.id === 'string' &&
      change.ownerId === ownerId &&
      (change.type === 'create' || change.type === 'update' || change.type === 'delete') &&
      typeof change.productId === 'string' &&
      typeof change.createdAt === 'string' &&
      typeof change.attempts === 'number' &&
      (change.product === undefined || this.isProduct(change.product, ownerId))
    );
  }

  private scopedKey(key: string, ownerId: string): string {
    return `${key}.${encodeURIComponent(ownerId)}`;
  }

  private legacyKey(key: string, ownerId: string): string {
    return this.scopedKey(key, ownerId);
  }

  private withoutRuntimePhotoUrl(product: Product): Product {
    const { photoPreviewUrl: _photoPreviewUrl, ...savedProduct } = product;
    return savedProduct;
  }

  private getStorage(): Promise<Storage> {
    this.storageReady ??= this.storage.create();
    return this.storageReady;
  }

  private reportError(message: string, error: unknown): void {
    console.warn(`[Pantry storage] ${message}`, error);
    this.storageErrorSubject.next(message);
  }
}

import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

import type { CapturedPhoto, Product } from '../models/product.model';

import { LocalProductStorageService } from './local-product-storage.service';

const PHOTO_ROOT = 'pantrypal-photos';

export interface StoredPhoto {
  photoPath: string;
  photoMimeType: string;
}

export class PhotoStorageError extends Error {
  constructor(
    public readonly operation: 'save' | 'read' | 'delete',
    message: string,
  ) {
    super(message);
    this.name = 'PhotoStorageError';
  }
}

@Injectable({ providedIn: 'root' })
export class PhotoStorageService {
  private readonly localStorage = inject(LocalProductStorageService);
  private readonly objectUrls = new Map<string, string>();

  public async savePhoto(ownerId: string, photo: CapturedPhoto): Promise<StoredPhoto> {
    const mimeType = this.validateMimeType(photo.mimeType);
    const base64 = photo.base64.replace(/^data:[^,]*,/, '').replace(/\s/g, '');
    if (!base64) throw new PhotoStorageError('save', 'The captured image is empty. Please take the photo again.');

    const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const photoPath = `${this.ownerDirectory(ownerId)}/${this.createId()}.${extension}`;
    try {
      await Filesystem.writeFile({ path: photoPath, data: base64, directory: Directory.Data, recursive: true });
      return { photoPath, photoMimeType: mimeType };
    } catch (error) {
      console.warn('[Pantry photo] Could not persist photo.', error);
      throw new PhotoStorageError(
        'save',
        'The photo could not be saved on this device. Check available storage and try again.',
      );
    }
  }

  /** Save a replacement as a new file; the caller swaps the resource reference before deleting the old file. */
  public replacePhoto(ownerId: string, _oldPath: string | undefined, photo: CapturedPhoto): Promise<StoredPhoto> {
    return this.savePhoto(ownerId, photo);
  }

  public async readPhoto(ownerId: string, photoPath: string): Promise<string | Blob> {
    this.assertOwnedPath(ownerId, photoPath);
    try {
      const result = await Filesystem.readFile({ path: photoPath, directory: Directory.Data });
      return result.data;
    } catch (error) {
      console.warn('[Pantry photo] Could not read saved photo.', error);
      throw new PhotoStorageError(
        'read',
        'This saved photo is missing or unreadable. You can take a new photo while editing.',
      );
    }
  }

  /** Resolve a relative app-data path to a browser-safe URL for the current platform. */
  public async getPhotoUrl(ownerId: string, photoPath: string, mimeType = 'image/jpeg'): Promise<string> {
    this.assertOwnedPath(ownerId, photoPath);
    const cached = this.objectUrls.get(photoPath);
    if (cached) return cached;

    try {
      if (Capacitor.isNativePlatform()) {
        const { uri } = await Filesystem.getUri({ path: photoPath, directory: Directory.Data });
        return Capacitor.convertFileSrc(uri);
      }

      const contents = await this.readPhoto(ownerId, photoPath);
      const blob = contents instanceof Blob ? contents : this.base64ToBlob(contents, mimeType);
      const url = URL.createObjectURL(blob);
      this.objectUrls.set(photoPath, url);
      return url;
    } catch (error) {
      if (error instanceof PhotoStorageError) throw error;
      console.warn('[Pantry photo] Could not prepare image preview.', error);
      throw new PhotoStorageError(
        'read',
        'This saved photo is missing or unreadable. You can take a new photo while editing.',
      );
    }
  }

  /** Delete only after local cache and queued mutations no longer reference this owner's file. */
  public async deletePhoto(ownerId: string, photoPath: string): Promise<boolean> {
    this.assertOwnedPath(ownerId, photoPath);
    try {
      const [products, changes] = await Promise.all([
        this.localStorage.getProducts(ownerId),
        this.localStorage.getPendingChanges(ownerId),
      ]);
      if (this.localStorage.hasStorageError) return false;
      const isReferenced = [
        ...(products ?? []),
        ...changes.flatMap((change) => (change.product ? [change.product] : [])),
      ].some((product: Product) => product.ownerId === ownerId && product.photoPath === photoPath);
      if (isReferenced) return false;

      await Filesystem.deleteFile({ path: photoPath, directory: Directory.Data });
      this.revokeObjectUrl(photoPath);
      return true;
    } catch (error) {
      if (this.isMissingFile(error)) {
        this.revokeObjectUrl(photoPath);
        return true;
      }
      console.warn('[Pantry photo] Could not delete an unreferenced photo.', error);
      return false;
    }
  }

  private ownerDirectory(ownerId: string): string {
    if (!ownerId) throw new PhotoStorageError('save', 'Sign in before saving a pantry photo.');
    return `${PHOTO_ROOT}/${encodeURIComponent(ownerId)}`;
  }

  private assertOwnedPath(ownerId: string, photoPath: string): void {
    if (!ownerId || !photoPath || !photoPath.startsWith(`${this.ownerDirectory(ownerId)}/`)) {
      throw new PhotoStorageError('read', 'This photo does not belong to the active account.');
    }
  }

  private validateMimeType(mimeType: string): string {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType.toLowerCase())) {
      throw new PhotoStorageError('save', 'This image format is not supported. Use JPEG, PNG, or WebP.');
    }
    return mimeType.toLowerCase();
  }

  private base64ToBlob(base64: string, mimeType: string): Blob {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    return new Blob([bytes], { type: mimeType });
  }

  private isMissingFile(error: unknown): boolean {
    return error instanceof Error && /not found|does not exist|no such file/i.test(error.message);
  }

  private revokeObjectUrl(photoPath: string): void {
    const objectUrl = this.objectUrls.get(photoPath);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    this.objectUrls.delete(photoPath);
  }

  private createId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

import { Injectable } from '@angular/core';
import { Camera, CameraDirection } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';

import type { CapturedPhoto } from '../models/product.model';

export type CameraCaptureErrorCode = 'cancelled' | 'permission-denied' | 'capture-failed';

export class CameraCaptureError extends Error {
  constructor(
    public readonly code: CameraCaptureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CameraCaptureError';
  }
}

@Injectable({ providedIn: 'root' })
export class CameraCaptureService {
  public async takePhoto(): Promise<CapturedPhoto> {
    try {
      if (!Capacitor.isNativePlatform()) {
        return await this.captureBrowserPhoto();
      }

      if (Capacitor.getPlatform() === 'ios') {
        let permission = await Camera.checkPermissions();
        if (permission.camera !== 'granted') {
          permission = await Camera.requestPermissions({ permissions: ['camera'] });
        }
        if (permission.camera !== 'granted') {
          throw new CameraCaptureError(
            'permission-denied',
            'Camera permission was denied. Enable camera access in your device settings.',
          );
        }
      }

      const photo = await Camera.takePhoto({
        cameraDirection: CameraDirection.Rear,
        quality: 85,
        includeMetadata: true,
      });
      if (photo.uri) {
        const file = await Filesystem.readFile({ path: photo.uri });
        if (typeof file.data === 'string') {
          const format = photo.metadata?.format?.toLowerCase() ?? 'jpeg';
          return { base64: file.data, mimeType: format === 'jpg' ? 'image/jpeg' : `image/${format}` };
        }
      }
      if (!photo.thumbnail) {
        throw new CameraCaptureError('capture-failed', 'The camera did not return an image. Please try again.');
      }

      return { base64: photo.thumbnail, mimeType: 'image/jpeg' };
    } catch (error) {
      if (error instanceof CameraCaptureError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/cancel|dismiss/i.test(message)) {
        throw new CameraCaptureError('cancelled', 'Photo capture was cancelled. Your current photo has been kept.');
      }
      if (/permission|denied|unauthorized/i.test(message)) {
        throw new CameraCaptureError(
          'permission-denied',
          'Camera access was denied. Enable camera access in your device or browser settings.',
        );
      }
      throw new CameraCaptureError('capture-failed', 'Unable to open the camera. Check camera access and try again.');
    }
  }

  private captureBrowserPhoto(): Promise<CapturedPhoto> {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.setAttribute('capture', 'environment');
      input.id = 'pantrypal-camera-input';
      input.style.position = 'fixed';
      input.style.left = '-10000px';

      const cleanup = (): void => {
        input.remove();
      };
      input.onchange = (): void => {
        const file = input.files?.[0];
        if (!file) {
          cleanup();
          reject(new CameraCaptureError('cancelled', 'Photo capture was cancelled. Your current photo has been kept.'));
          return;
        }
        if (!file.type.startsWith('image/')) {
          cleanup();
          reject(new CameraCaptureError('capture-failed', 'Choose an image file to use as the product photo.'));
          return;
        }
        const reader = new FileReader();
        reader.onload = (): void => {
          cleanup();
          if (typeof reader.result === 'string') {
            const [metadata, base64] = reader.result.split(',', 2);
            const mimeType = /^data:([^;]+)/.exec(metadata ?? '')?.[1] ?? file.type;
            resolve({ base64: base64 ?? '', mimeType });
          } else reject(new CameraCaptureError('capture-failed', 'The selected image could not be previewed.'));
        };
        reader.onerror = (): void => {
          cleanup();
          reject(new CameraCaptureError('capture-failed', 'The selected image could not be read.'));
        };
        reader.readAsDataURL(file);
      };
      input.oncancel = (): void => {
        cleanup();
        reject(new CameraCaptureError('cancelled', 'Photo capture was cancelled. Your current photo has been kept.'));
      };
      document.body.appendChild(input);
      input.click();
    });
  }
}

import { Capacitor } from '@capacitor/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CameraCaptureError } from './camera-capture.service';
import { CameraCaptureService } from './camera-capture.service';

describe('CameraCaptureService browser fallback', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads a selected camera image into a preview data URL', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      const file = new File([new Uint8Array([1, 2, 3])], 'pantry.png', { type: 'image/png' });
      Object.defineProperty(this, 'files', { configurable: true, value: [file] });
      this.dispatchEvent(new Event('change'));
    });

    const previewUrl = await new CameraCaptureService().takePhoto();

    expect(previewUrl).toEqual({
      base64: 'AQID',
      mimeType: 'image/png',
    });
    expect(document.getElementById('pantrypal-camera-input')).toBeNull();
  });

  it('reports cancellation without losing an already staged image', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      this.dispatchEvent(new Event('cancel'));
    });

    await expect(new CameraCaptureService().takePhoto()).rejects.toMatchObject<Partial<CameraCaptureError>>({
      code: 'cancelled',
    });
  });
});

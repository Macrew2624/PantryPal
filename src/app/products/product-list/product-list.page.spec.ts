import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { AuthService } from '../../services/auth.service';
import { CameraCaptureError, CameraCaptureService } from '../../services/camera-capture.service';
import { LocalProductStorageService } from '../../services/local-product-storage.service';
import { NetworkService } from '../../services/network-status.service';
import { PhotoStorageService } from '../../services/photo-storage.service';

import { ProductListPage } from './product-list.page';

describe('ProductListPage', () => {
  let component: ProductListPage;
  let fixture: ComponentFixture<ProductListPage>;
  let cameraCapture: { takePhoto: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    cameraCapture = { takePhoto: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [ProductListPage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: CameraCaptureService, useValue: cameraCapture },
        {
          provide: PhotoStorageService,
          useValue: {
            replacePhoto: vi.fn(async () => ({
              photoPath: 'pantrypal-photos/list-test-user/photo.jpg',
              photoMimeType: 'image/jpeg',
            })),
            getPhotoUrl: vi.fn(async () => 'blob:pantry-photo'),
            deletePhoto: vi.fn(async () => true),
          },
        },
        {
          provide: AuthService,
          useValue: {
            user$: new BehaviorSubject({ id: 'list-test-user', email: 'list@test.local' }),
            get currentUserId() {
              return 'list-test-user';
            },
          },
        },
        {
          provide: LocalProductStorageService,
          useValue: {
            getProducts: async () => null,
            saveProducts: async () => true,
            getPendingChanges: async () => [],
            savePendingChanges: async () => true,
          },
        },
        {
          provide: NetworkService,
          useValue: { currentStatus: { connected: false }, status$: new BehaviorSubject({ connected: false }) },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ProductListPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('stages a captured photo in the current product draft', async () => {
    cameraCapture.takePhoto.mockResolvedValue({ base64: 'captured', mimeType: 'image/jpeg' });

    await component.takePhoto();

    expect(component.productDraft.photoPath).toBe('pantrypal-photos/list-test-user/photo.jpg');
    expect(component.productDraft.photoPreviewUrl).toBe('blob:pantry-photo');
  });

  it('shows cancellation guidance and keeps the current preview after a cancelled retake', async () => {
    component.productDraft.photoPreviewUrl = 'data:image/jpeg;base64,existing';
    cameraCapture.takePhoto.mockRejectedValue(
      new CameraCaptureError('cancelled', 'Photo capture was cancelled. Your current photo has been kept.'),
    );

    await component.takePhoto();

    expect(component.productDraft.photoPreviewUrl).toBe('data:image/jpeg;base64,existing');
    expect(component.cameraMessage).toContain('cancelled');
  });

  it('shows permission guidance when the camera is denied', async () => {
    cameraCapture.takePhoto.mockRejectedValue(
      new CameraCaptureError(
        'permission-denied',
        'Camera permission was denied. Enable camera access in your device settings.',
      ),
    );

    await component.takePhoto();

    expect(component.cameraMessage).toContain('permission was denied');
  });

  it('shows an existing product photo when opening its editor', async () => {
    await component.openEditEditor({
      id: 'photo-product',
      ownerId: 'list-test-user',
      name: 'Photo product',
      category: 'Pantry',
      quantity: 1,
      expirationDate: '2026-11-01',
      isOpened: false,
      photoPath: 'pantrypal-photos/list-test-user/existing.jpg',
      photoMimeType: 'image/jpeg',
    });

    expect(component.productDraft.photoPath).toBe('pantrypal-photos/list-test-user/existing.jpg');
    expect(component.productDraft.photoPreviewUrl).toBe('blob:pantry-photo');
  });

  it('keeps an existing photo reference in the edit draft unless the user removes it', async () => {
    await component.openEditEditor({
      id: 'preserved-photo',
      ownerId: 'list-test-user',
      name: 'Product with photo',
      category: 'Pantry',
      quantity: 1,
      expirationDate: '2026-11-01',
      isOpened: false,
      photoPath: 'pantrypal-photos/list-test-user/keep.jpg',
      photoMimeType: 'image/jpeg',
    });

    expect(component['normalizedDraft']().photoPath).toBe('pantrypal-photos/list-test-user/keep.jpg');
    component.removePhoto();
    expect(component['normalizedDraft']().photoPath).toBeUndefined();
  });

  it('should filter products according to searchQuery', () => {
    component.products = [
      {
        id: '1',
        ownerId: 'list-test-user',
        name: 'Whole Milk',
        category: 'Dairy',
        quantity: 2,
        expirationDate: '2026-11-01',
        isOpened: false,
      },
      {
        id: '2',
        ownerId: 'list-test-user',
        name: 'Apples',
        category: 'Produce',
        quantity: 5,
        expirationDate: '2026-11-05',
        isOpened: false,
      },
    ];

    component.searchQuery = 'milk';
    expect(component.filteredProducts.length).toBe(1);
    expect(component.filteredProducts[0].name).toBe('Whole Milk');
  });
});

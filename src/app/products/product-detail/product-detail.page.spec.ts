import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { describe, it, expect, beforeEach } from 'vitest';

import { AuthService } from '../../services/auth.service';
import { LocalProductStorageService } from '../../services/local-product-storage.service';
import { NetworkService } from '../../services/network-status.service';
import { PhotoStorageService } from '../../services/photo-storage.service';

import { ProductDetailPage } from './product-detail.page';

describe('ProductDetailPage', () => {
  let component: ProductDetailPage;
  let fixture: ComponentFixture<ProductDetailPage>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProductDetailPage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: PhotoStorageService, useValue: { getPhotoUrl: async () => 'blob:test-photo' } },
        { provide: AuthService, useValue: { user$: new BehaviorSubject(null) } },
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

    fixture = TestBed.createComponent(ProductDetailPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should mark notFound when id is not provided', () => {
    component.id = undefined;
    component.fetchProduct();
    expect(component.notFound).toBe(true);
  });
});

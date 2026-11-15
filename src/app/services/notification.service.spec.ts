import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { AuthService } from './auth.service';
import { LocalProductStorageService } from './local-product-storage.service';
import { NetworkService } from './network-status.service';
import { NotificationService } from './notification.service';
import { ProductService } from './product.service';

describe('NotificationService', () => {
  let service: NotificationService;
  let httpTestingController: HttpTestingController;

  beforeEach(async () => {
    class MockWebSocket {
      public readyState = 1;
      public onopen: (() => void) | null = null;
      public onmessage: ((e: MessageEvent) => void) | null = null;
      public onerror: ((e: Event) => void) | null = null;
      public onclose: (() => void) | null = null;
      public send(_data: string): void {}

      constructor(_url: string) {
        setTimeout(() => {
          if (this.onopen) this.onopen();
        }, 10);
      }

      public close(): void {
        this.readyState = 3;
        if (this.onclose) this.onclose();
      }
    }

    vi.stubGlobal('WebSocket', MockWebSocket);

    TestBed.configureTestingModule({
      providers: [
        NotificationService,
        { provide: ProductService, useValue: { loadProducts: vi.fn() } },
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: LocalProductStorageService,
          useValue: {
            getProducts: async () => null,
            saveProducts: async () => true,
            getPendingChanges: async () => [],
            savePendingChanges: async () => true,
          },
        },
        { provide: NetworkService, useValue: { currentStatus: { connected: true } } },
        {
          provide: AuthService,
          useValue: {
            user$: new BehaviorSubject({ id: 'notification-test-user', email: 'notify@test.local' }),
            accessToken: 'test-token',
            handleUnauthorized: vi.fn(),
          },
        },
      ],
    });

    httpTestingController = TestBed.inject(HttpTestingController);
    service = TestBed.inject(NotificationService);

    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  afterEach(() => {
    if (service) {
      service.disconnect();
    }
    vi.unstubAllGlobals();
    httpTestingController.verify();
    TestBed.resetTestingModule();
  });

  it('should be created and initiate connection', () => {
    expect(service).toBeTruthy();
  });

  it('should dispatch POST request when triggerTestNotification is called', () => {
    service.triggerTestNotification('Test message from unit test').subscribe((res) => {
      expect(res).toBeTruthy();
    });

    const req = httpTestingController.expectOne('http://localhost:3000/api/notifications/test');
    expect(req.request.method).toBe('POST');
    expect(req.request.body.message).toBe('Test message from unit test');
    req.flush({ success: true });
  });

  it('should clear notifications history', () => {
    service.clearHistory();
    service.notifications$.subscribe((items) => {
      expect(items.length).toBe(0);
    });
  });
});

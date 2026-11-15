import { HttpClient } from '@angular/common/http';
import type { OnDestroy } from '@angular/core';
import { Injectable, inject } from '@angular/core';
import { ToastController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  notificationsOutline,
  addCircleOutline,
  syncOutline,
  trashOutline,
  sparklesOutline,
  informationCircleOutline,
} from 'ionicons/icons';
import type { Observable, Subscription } from 'rxjs';
import { BehaviorSubject } from 'rxjs';

import { environment } from '../../environments/environment';
import type { PantryNotification } from '../models/notification.model';

import { AuthService } from './auth.service';
import { ProductService } from './product.service';

@Injectable({
  providedIn: 'root',
})
export class NotificationService implements OnDestroy {
  private toastController = inject(ToastController);
  private http = inject(HttpClient);
  private authService = inject(AuthService);
  private productService = inject(ProductService);

  private wsUrl: string = this.resolveWebSocketUrl(environment.wsUrl || 'ws://localhost:3000');
  private testNotificationEndpoint: string = `${environment.apiUrl.replace(/\/+$/, '')}/notifications/test`;

  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectIntervalMs: number = 2000;
  private isDestroyed: boolean = false;
  private authSubscription?: Subscription;

  private isConnectedSubject = new BehaviorSubject<boolean>(false);
  public isConnected$ = this.isConnectedSubject.asObservable();

  private notificationsSubject = new BehaviorSubject<PantryNotification[]>([]);
  public notifications$ = this.notificationsSubject.asObservable();

  private latestNotificationSubject = new BehaviorSubject<PantryNotification | null>(null);
  public latestNotification$ = this.latestNotificationSubject.asObservable();

  constructor() {
    addIcons({
      notificationsOutline,
      addCircleOutline,
      syncOutline,
      trashOutline,
      sparklesOutline,
      informationCircleOutline,
    });

    this.authSubscription = this.authService.user$.subscribe((user) => {
      if (user) this.connect();
      else this.disconnect();
    });
  }

  ngOnDestroy(): void {
    this.isDestroyed = true;
    this.authSubscription?.unsubscribe();
    this.disconnect();
  }

  /**
   * Connects to the backend WebSocket notification stream
   */
  public connect(): void {
    if (this.isDestroyed || !this.authService.accessToken) {
      return;
    }
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED && this.socket.readyState !== WebSocket.CLOSING) {
      return;
    }

    try {
      this.socket = new WebSocket(this.wsUrl);
      const socket = this.socket;

      socket.onopen = () => {
        const token = this.authService.accessToken;
        if (!token) {
          socket.close(1000, 'Signed out');
          return;
        }
        // Browser WebSocket cannot set request headers; authenticate with the first frame.
        socket.send(JSON.stringify({ type: 'AUTHENTICATE', token }));
      };

      socket.onmessage = (event: MessageEvent) => {
        try {
          const data: PantryNotification = JSON.parse(event.data);
          if (data.type === 'AUTHENTICATED') {
            this.isConnectedSubject.next(true);
            this.reconnectIntervalMs = 2000;
            return;
          }
          if (data.type === 'AUTHENTICATION_FAILED') {
            this.isConnectedSubject.next(false);
            this.authService.handleUnauthorized();
            return;
          }
          if (!this.isConnectedSubject.value) return;
          this.handleIncomingNotification(data);
        } catch (err) {
          console.error('[WebSocket] Failed to parse message JSON:', err);
        }
      };

      socket.onerror = (err) => {
        console.warn('[WebSocket] Connection error:', err);
        this.isConnectedSubject.next(false);
      };

      socket.onclose = () => {
        this.isConnectedSubject.next(false);
        this.socket = null;
        this.scheduleReconnect();
      };
    } catch (err) {
      console.warn('[WebSocket] Exception during connection attempt:', err);
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnects and cleans up resources
   */
  public disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      this.socket.close(1000, 'Client closed connection');
      this.socket = null;
    }

    this.isConnectedSubject.next(false);
  }

  /**
   * Schedules reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.isDestroyed || !this.authService.accessToken || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectIntervalMs = Math.min(this.reconnectIntervalMs * 1.5, 15000);
      this.connect();
    }, this.reconnectIntervalMs);
  }

  /**
   * Processes incoming notifications, updates product list, and presents an ion-toast
   */
  private async handleIncomingNotification(notification: PantryNotification): Promise<void> {
    if (notification.type === 'CONNECTION_ESTABLISHED') {
      return;
    }

    // Append to in-app notification history
    const current = this.notificationsSubject.value;
    this.notificationsSubject.next([notification, ...current.slice(0, 19)]);
    this.latestNotificationSubject.next(notification);

    // Synchronize product list in background without reloading page
    if (
      notification.type === 'PRODUCT_ADDED' ||
      notification.type === 'PRODUCT_UPDATED' ||
      notification.type === 'PRODUCT_DELETED'
    ) {
      this.productService.loadProducts();
    }

    // Display Ionic toast
    await this.showToast(notification);
  }

  /**
   * Displays an interactive Ionic Toast for the notification
   */
  public async showToast(notification: PantryNotification): Promise<void> {
    let color: 'success' | 'warning' | 'tertiary' | 'primary' | 'medium';
    let icon: string;

    switch (notification.type) {
      case 'PRODUCT_ADDED':
        color = 'success';
        icon = 'add-circle-outline';
        break;
      case 'PRODUCT_UPDATED':
        color = 'tertiary';
        icon = 'sync-outline';
        break;
      case 'PRODUCT_DELETED':
        color = 'warning';
        icon = 'trash-outline';
        break;
      case 'TEST_NOTIFICATION':
        color = 'primary';
        icon = 'sparkles-outline';
        break;
      default:
        color = 'medium';
        icon = 'information-circle-outline';
    }

    try {
      const toast = await this.toastController.create({
        message: notification.message,
        duration: 4000,
        position: 'top',
        color,
        icon,
        buttons: [
          {
            text: 'Dismiss',
            role: 'cancel',
          },
        ],
      });
      await toast.present();
    } catch {
      // Ignore if toast presentation is interrupted (e.g. during test runners)
    }
  }

  /**
   * Development trigger to emit a test WebSocket notification via backend
   */
  public triggerTestNotification(message?: string): Observable<unknown> {
    return this.http.post(this.testNotificationEndpoint, {
      type: 'TEST_NOTIFICATION',
      message: message || 'PantryPal live update: Restocked pantry ingredients!',
      productId: 'prod-test-01',
    });
  }

  /**
   * Clears in-app notification history
   */
  public clearHistory(): void {
    this.notificationsSubject.next([]);
    this.latestNotificationSubject.next(null);
  }

  private resolveWebSocketUrl(configuredUrl: string): string {
    if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
      return configuredUrl.replace(/^ws:/, 'wss:');
    }
    return configuredUrl;
  }
}

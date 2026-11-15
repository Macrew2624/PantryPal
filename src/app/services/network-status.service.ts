import { Injectable } from '@angular/core';
import type { OnDestroy } from '@angular/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { Network } from '@capacitor/network';
import type { ConnectionStatus } from '@capacitor/network';
import { BehaviorSubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class NetworkService implements OnDestroy {
  private listener?: PluginListenerHandle;
  private destroyed = false;
  private browserEventSeen = false;
  private readonly browserOnlineHandler = () => this.updateBrowserStatus(true);
  private readonly browserOfflineHandler = () => this.updateBrowserStatus(false);

  private statusSubject = new BehaviorSubject<ConnectionStatus>({
    connected: typeof navigator === 'undefined' ? true : navigator.onLine,
    connectionType: 'unknown',
  });
  public status$ = this.statusSubject.asObservable();

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.browserOnlineHandler);
      window.addEventListener('offline', this.browserOfflineHandler);
    }
    void this.initialize();
  }

  public get currentStatus(): ConnectionStatus {
    return this.statusSubject.value;
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    void this.listener?.remove();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.browserOnlineHandler);
      window.removeEventListener('offline', this.browserOfflineHandler);
    }
  }

  private updateBrowserStatus(connected: boolean): void {
    this.browserEventSeen = true;
    this.statusSubject.next({ ...this.statusSubject.value, connected });
  }

  private async initialize(): Promise<void> {
    try {
      const initialStatus = await Network.getStatus();
      this.statusSubject.next({
        ...initialStatus,
        connected: this.browserEventSeen ? navigator.onLine : initialStatus.connected,
      });
      const listener = await Network.addListener('networkStatusChange', (status) => {
        this.statusSubject.next(status);
      });

      if (this.destroyed) {
        await listener.remove();
      } else {
        this.listener = listener;
      }
    } catch (error) {
      console.warn('[Network status] Native network monitoring is unavailable; using browser status.', error);
      this.statusSubject.next({
        connected: typeof navigator === 'undefined' ? true : navigator.onLine,
        connectionType: 'unknown',
      });
    }
  }
}

// Keep existing imports working while exposing the requested service name.
export { NetworkService as NetworkStatusService };

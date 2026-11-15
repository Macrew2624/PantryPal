import type { HttpErrorResponse } from '@angular/common/http';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { OnDestroy } from '@angular/core';
import type { Observable } from 'rxjs';
import { BehaviorSubject, firstValueFrom, from, of, Subscription, throwError } from 'rxjs';
import { catchError, map, switchMap, tap, timeout } from 'rxjs/operators';

import { environment } from '../../environments/environment';
import type { PendingProductChange, PendingProductChangeType } from '../models/pending-product-change.model';
import type {
  Product,
  ProductDraft,
  ProductMutationResult,
  ProductPageResponse,
  ProductSearchCriteria,
  ProductSyncStatus,
  ExpirationInfo,
} from '../models/product.model';

import { AuthService } from './auth.service';
import { LocalProductStorageService } from './local-product-storage.service';
import { NetworkService } from './network-status.service';
import { PhotoStorageService } from './photo-storage.service';

const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRY_DELAY_MS = 60000;
const PRODUCT_PAGE_SIZE = 20;

@Injectable({
  providedIn: 'root',
})
export class ProductService implements OnDestroy {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private localStorage = inject(LocalProductStorageService);
  private network = inject(NetworkService);
  private photos = inject(PhotoStorageService);
  private lastConnectivity = this.network.currentStatus.connected;
  private baseUrl = environment.apiUrl.replace(/\/+$/, '');
  private productsUrl = `${this.baseUrl}/products`;

  private productsSubject = new BehaviorSubject<Product[]>([]);
  public products$ = this.productsSubject.asObservable();

  private loadingSubject = new BehaviorSubject<boolean>(false);
  public loading$ = this.loadingSubject.asObservable();

  private errorSubject = new BehaviorSubject<string | null>(null);
  public error$ = this.errorSubject.asObservable();

  private selectedProductSubject = new BehaviorSubject<Product | null>(null);
  public selectedProduct$ = this.selectedProductSubject.asObservable();

  private activeUserId: string | null = null;
  private pendingChangesSubject = new BehaviorSubject<PendingProductChange[]>([]);
  public pendingChanges$ = this.pendingChangesSubject.asObservable();
  private pendingLoadPromise?: Promise<boolean>;
  private pendingLoadedUserId: string | null = null;
  private mutationRevision = 0;
  private productRevisions = new Map<string, number>();
  private queueWriteTail: Promise<void> = Promise.resolve();
  private syncStatusSubject = new BehaviorSubject<ProductSyncStatus>({
    state: 'synced',
    pendingCount: 0,
    message: 'Synced',
  });
  public syncStatus$ = this.syncStatusSubject.asObservable();
  private syncing = false;
  private syncPromise?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryAttempt = 0;
  private needsAttention = false;
  private hasSyncedDuringRun = false;
  private subscriptions = new Subscription();
  private pageOffset = 0;
  private hasMorePages = false;
  private isLoadingNextPage = false;
  private queryGeneration = 0;
  private criteria: ProductSearchCriteria = this.defaultSearchCriteria();
  private hasLoadedFirstPage = false;
  private hasMoreSubject = new BehaviorSubject<boolean>(false);
  public hasMore$ = this.hasMoreSubject.asObservable();
  private pageLoadingSubject = new BehaviorSubject<boolean>(false);
  public pageLoading$ = this.pageLoadingSubject.asObservable();
  private pageErrorSubject = new BehaviorSubject<string | null>(null);
  public pageError$ = this.pageErrorSubject.asObservable();
  private cachedOnlySubject = new BehaviorSubject<boolean>(false);
  public cachedOnly$ = this.cachedOnlySubject.asObservable();

  constructor() {
    this.subscriptions.add(
      this.auth.user$.subscribe((user) => {
        const userId = user?.id ?? null;
        if (userId === this.activeUserId) return;

        this.activeUserId = userId;
        this.pendingLoadPromise = undefined;
        this.pendingLoadedUserId = null;
        this.criteria = this.defaultSearchCriteria();
        this.pageOffset = 0;
        this.hasMorePages = false;
        this.hasMoreSubject.next(false);
        this.pageErrorSubject.next(null);
        this.cachedOnlySubject.next(false);
        this.queryGeneration++;
        this.mutationRevision = 0;
        this.productRevisions.clear();
        this.setPendingChanges([]);
        this.productsSubject.next([]);
        this.selectedProductSubject.next(null);
        this.errorSubject.next(null);
        this.needsAttention = false;
        this.syncing = false;
        this.retryAttempt = 0;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        this.updateSyncStatus();

        if (userId) {
          this.loadProducts();
        } else {
          this.loadingSubject.next(false);
        }
      }),
    );

    this.subscriptions.add(
      this.network.status$.subscribe((status) => {
        const regainedConnectivity = status.connected && !this.lastConnectivity;
        this.lastConnectivity = status.connected;
        this.updateSyncStatus();
        if (status.connected && this.activeUserId) {
          if (regainedConnectivity && this.cachedOnlySubject.value) this.loadProducts();
          void this.synchronizePendingChanges();
        }
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  /**
   * Retrieves full list of products from GET /api/products
   */
  public loadProducts(): void {
    const ownerId = this.activeUserId;
    if (!ownerId) return;
    const generation = ++this.queryGeneration;
    this.pageOffset = 0;
    this.hasMorePages = true;
    this.hasLoadedFirstPage = false;
    this.isLoadingNextPage = false;
    this.hasMoreSubject.next(true);
    this.pageLoadingSubject.next(false);
    this.pageErrorSubject.next(null);
    this.cachedOnlySubject.next(false);
    void this.loadFirstPage(ownerId, generation);
  }

  public setSearchCriteria(criteria: ProductSearchCriteria): void {
    const normalized: ProductSearchCriteria = {
      ...criteria,
      search: criteria.search.trim(),
      category: criteria.category.trim(),
    };
    if (JSON.stringify(normalized) === JSON.stringify(this.criteria)) return;
    this.criteria = normalized;
    this.loadProducts();
  }

  public async loadNextPage(): Promise<void> {
    const ownerId = this.activeUserId;
    if (!ownerId || !this.hasMorePages || this.isLoadingNextPage || !this.hasLoadedFirstPage) return;
    if (!this.network.currentStatus.connected) {
      this.cachedOnlySubject.next(true);
      this.hasMorePages = false;
      this.hasMoreSubject.next(false);
      this.pageErrorSubject.next('Connect to the network to load more server results.');
      return;
    }

    const generation = this.queryGeneration;
    const offset = this.pageOffset;
    const startingRevision = this.mutationRevision;
    this.isLoadingNextPage = true;
    this.pageLoadingSubject.next(true);
    this.pageErrorSubject.next(null);
    try {
      const page = await this.fetchProductsPage(offset);
      if (this.activeUserId !== ownerId || generation !== this.queryGeneration) return;
      const cached = (await this.localStorage.getProducts(ownerId)) ?? [];
      const combined = new Map(this.productsSubject.value.map((product) => [product.id, product]));
      for (const product of page.items) combined.set(product.id, this.preserveLocalPhoto(product, cached));
      const merged = this.filterProductsLocally(this.mergePendingChanges([...combined.values()]));
      this.setProducts(merged);
      const cacheIncoming =
        startingRevision === this.mutationRevision
          ? page.items.map((product) => this.preserveLocalPhoto(product, cached))
          : [...page.items, ...this.productsSubject.value];
      await this.saveProductCache(ownerId, cacheIncoming);
      this.pageOffset = offset + page.items.length;
      this.hasMorePages = page.hasMore && page.items.length > 0;
      this.hasMoreSubject.next(this.hasMorePages);
      this.cachedOnlySubject.next(false);
    } catch (error) {
      if (generation === this.queryGeneration) {
        this.pageErrorSubject.next(this.errorMessage(error));
      }
    } finally {
      if (generation === this.queryGeneration) {
        this.isLoadingNextPage = false;
        this.pageLoadingSubject.next(false);
      }
    }
  }

  private async loadFirstPage(ownerId: string, generation: number): Promise<void> {
    this.loadingSubject.next(this.productsSubject.value.length === 0);
    this.errorSubject.next(null);
    if (!(await this.ensurePendingChangesLoaded(ownerId))) {
      if (generation !== this.queryGeneration) return;
      this.loadingSubject.next(false);
      this.errorSubject.next(
        'Saved changes could not be read from local storage. Server refresh is paused to protect your local work.',
      );
      return;
    }
    if (this.activeUserId !== ownerId || generation !== this.queryGeneration) return;

    const cachedProducts = await this.localStorage.getProducts(ownerId);
    if (this.activeUserId !== ownerId || generation !== this.queryGeneration) return;
    this.setProducts(this.filterProductsLocally(this.mergePendingChanges(cachedProducts ?? [])));
    if (this.productsSubject.value.length > 0) this.loadingSubject.next(false);

    if (!this.network.currentStatus.connected) {
      this.loadingSubject.next(false);
      this.hasLoadedFirstPage = true;
      this.hasMorePages = false;
      this.hasMoreSubject.next(false);
      this.cachedOnlySubject.next(true);
      if (!this.productsSubject.value.length) {
        this.errorSubject.next('Offline and no saved pantry data is available for this account yet.');
      }
      return;
    }

    const startingRevision = this.mutationRevision;
    try {
      const page = await this.fetchProductsPage(0);
      if (this.activeUserId !== ownerId || generation !== this.queryGeneration) return;
      // A mutation made while this snapshot was in flight is newer than the response.
      if (startingRevision === this.mutationRevision) {
        const serverProducts = page.items.map((product) => this.preserveLocalPhoto(product, cachedProducts ?? []));
        const merged = this.filterProductsLocally(this.mergePendingChanges(serverProducts));
        this.setProducts(merged);
      }
      const cacheIncoming =
        startingRevision === this.mutationRevision
          ? page.items.map((product) => this.preserveLocalPhoto(product, cachedProducts ?? []))
          : [...page.items, ...this.productsSubject.value];
      await this.saveProductCache(ownerId, cacheIncoming);
      this.pageOffset = page.items.length;
      this.hasMorePages = page.hasMore && page.items.length > 0;
      this.hasMoreSubject.next(this.hasMorePages);
      this.hasLoadedFirstPage = true;
      this.cachedOnlySubject.next(false);
      this.loadingSubject.next(false);
    } catch (error) {
      if (this.activeUserId !== ownerId || generation !== this.queryGeneration) return;
      this.loadingSubject.next(false);
      this.hasLoadedFirstPage = true;
      this.hasMorePages = false;
      this.hasMoreSubject.next(false);
      this.cachedOnlySubject.next(true);
      if (this.productsSubject.value.length) {
        this.errorSubject.next(null);
      } else {
        this.errorSubject.next(`${this.errorMessage(error)} No cached pantry results are available.`);
      }
    }

    if (this.activeUserId === ownerId && generation === this.queryGeneration && this.network.currentStatus.connected) {
      void this.synchronizePendingChanges();
    }
  }

  private async fetchProductsPage(offset: number): Promise<ProductPageResponse> {
    let params = new HttpParams().set('limit', PRODUCT_PAGE_SIZE).set('offset', offset);
    if (this.criteria.search) params = params.set('search', this.criteria.search);
    if (this.criteria.category) params = params.set('category', this.criteria.category);
    if (this.criteria.expiryStatus) params = params.set('expiryStatus', this.criteria.expiryStatus);
    if (this.criteria.opened) params = params.set('opened', this.criteria.opened);
    if (this.criteria.sortBy !== 'id') params = params.set('sortBy', this.criteria.sortBy);
    if (this.criteria.sortOrder !== 'asc') params = params.set('sortOrder', this.criteria.sortOrder);
    return firstValueFrom(
      this.http.get<ProductPageResponse>(this.productsUrl, { params }).pipe(timeout({ first: REQUEST_TIMEOUT_MS })),
    );
  }

  private filterProductsLocally(products: Product[]): Product[] {
    const search = this.criteria.search.toLowerCase();
    const category = this.criteria.category.toLowerCase();
    const today = new Date().toISOString().slice(0, 10);
    const expiringThrough = new Date(`${today}T00:00:00.000Z`);
    expiringThrough.setUTCDate(expiringThrough.getUTCDate() + 3);
    const expiringThroughDate = expiringThrough.toISOString().slice(0, 10);
    const filtered = products.filter((product) => {
      if (category && product.category.toLowerCase() !== category) return false;
      if (this.criteria.opened && product.isOpened !== (this.criteria.opened === 'opened')) return false;
      if (this.criteria.expiryStatus === 'expired' && product.expirationDate >= today) return false;
      if (
        this.criteria.expiryStatus === 'expiring' &&
        (product.expirationDate < today || product.expirationDate > expiringThroughDate)
      ) {
        return false;
      }
      if (this.criteria.expiryStatus === 'fresh' && product.expirationDate <= expiringThroughDate) return false;
      if (!search) return true;
      return (
        product.name.toLowerCase().includes(search) ||
        product.category.toLowerCase().includes(search) ||
        (product.notes ?? '').toLowerCase().includes(search)
      );
    });
    const direction = this.criteria.sortOrder === 'desc' ? -1 : 1;
    return filtered.sort((left, right) => {
      const primary =
        this.criteria.sortBy === 'name'
          ? this.compare(left.name.toLowerCase(), right.name.toLowerCase())
          : this.criteria.sortBy === 'expirationDate'
            ? this.compare(left.expirationDate, right.expirationDate)
            : 0;
      return direction * (primary || this.compare(left.id, right.id));
    });
  }

  private defaultSearchCriteria(): ProductSearchCriteria {
    return { search: '', category: '', expiryStatus: '', opened: '', sortBy: 'id', sortOrder: 'asc' };
  }

  private compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  private preserveLocalPhoto(product: Product, cachedProducts: Product[]): Product {
    if (Object.hasOwn(product, 'photoPath')) return product;
    const cached = cachedProducts.find((item) => item.id === product.id && item.ownerId === product.ownerId);
    return cached?.photoPath
      ? { ...product, photoPath: cached.photoPath, photoMimeType: cached.photoMimeType }
      : product;
  }

  private withLocalPhoto(serverProduct: Product, localProduct: Product): Product {
    return {
      ...serverProduct,
      ...(localProduct.photoPath !== undefined ? { photoPath: localProduct.photoPath } : { photoPath: undefined }),
      ...(localProduct.photoMimeType !== undefined
        ? { photoMimeType: localProduct.photoMimeType }
        : { photoMimeType: undefined }),
    };
  }

  private toServerProduct(
    product: Product,
  ): Omit<Product, 'id' | 'ownerId' | 'photoPath' | 'photoMimeType' | 'photoPreviewUrl'> {
    const {
      id: _id,
      ownerId: _ownerId,
      photoPath: _photoPath,
      photoMimeType: _photoMimeType,
      photoPreviewUrl: _photoPreviewUrl,
      ...body
    } = product;
    return body;
  }

  private async cleanupPhotoIfUnreferenced(ownerId: string, ...photoPaths: (string | undefined)[]): Promise<void> {
    for (const path of new Set(photoPaths.filter((value): value is string => Boolean(value)))) {
      await this.photos.deletePhoto(ownerId, path);
    }
  }

  /**
   * Retrieves single product by ID from GET /api/products/:id
   */
  public getProductById(id: string): Observable<Product> {
    const ownerId = this.activeUserId;
    if (!ownerId) return throwError(() => new Error('An authenticated user is required.'));

    const url = `${this.productsUrl}/${encodeURIComponent(id)}`;
    return this.http.get<Product>(url).pipe(
      switchMap((product) =>
        from(this.localStorage.getProducts(ownerId)).pipe(
          map((cached) => this.preserveLocalPhoto(product, cached ?? [])),
        ),
      ),
      catchError((error: HttpErrorResponse) => {
        if (error.status !== 0) return throwError(() => error);
        return from(this.localStorage.getProducts(ownerId)).pipe(
          switchMap((products) => {
            const cachedProduct = this.mergePendingChanges(products ?? []).find((product) => product.id === id);
            return cachedProduct ? of(cachedProduct) : throwError(() => error);
          }),
        );
      }),
      map((product) => {
        const pending = this.pendingChangesSubject.value.filter((change) => change.productId === id).at(-1);
        if (pending?.type === 'delete') throw new Error('This product is pending deletion.');
        return pending?.product ?? product;
      }),
      tap(async (product) => {
        if (this.activeUserId !== ownerId) return;
        this.selectedProductSubject.next(product);
        const currentProducts = this.productsSubject.value;
        const productExists = currentProducts.some((item) => item.id === product.id);
        const updatedProducts = productExists
          ? currentProducts.map((item) => (item.id === product.id ? product : item))
          : [...currentProducts, product];
        this.productsSubject.next(this.filterProductsLocally(updatedProducts));
        await this.saveProductCache(ownerId, [product]);
      }),
    );
  }

  public async createProduct(draft: ProductDraft): Promise<ProductMutationResult> {
    const ownerId = this.activeUserId;
    if (!ownerId) return this.failed('Sign in before changing your pantry.');
    if (!(await this.ensurePendingChangesLoaded(ownerId))) {
      return this.failed('Pending local changes could not be read. This edit was not sent or discarded.');
    }

    const operationId = this.createLocalId();
    const localProduct: Product = { ...draft, id: `local-${operationId}`, ownerId };
    const revision = this.bumpRevision(localProduct.id);

    if (this.network.currentStatus.connected) {
      try {
        const serverProduct = await this.postCreate(localProduct, operationId);
        const product = this.withLocalPhoto(serverProduct, localProduct);
        if (this.activeUserId === ownerId && this.currentRevision(localProduct.id) === revision) {
          this.mutationRevision++;
          this.setProducts(this.filterProductsLocally([...this.productsSubject.value, product]));
          await this.saveProductCache(ownerId, [product]);
        }
        return { status: 'synced', message: 'Product sent to the server.', product };
      } catch {
        // Preserve the submitted product in a durable queue if the server is unavailable.
      }
    }

    const change: PendingProductChange = {
      id: operationId,
      ownerId,
      type: 'create',
      productId: localProduct.id,
      product: localProduct,
      createdAt: new Date().toISOString(),
      attempts: this.network.currentStatus.connected ? 1 : 0,
      lastError: this.network.currentStatus.connected ? 'The server request failed.' : undefined,
    };
    const persisted = await this.persistPendingMutation(ownerId, change);
    return persisted
      ? { status: 'pending', message: 'Saved on this device; waiting to send to the server.', product: localProduct }
      : this.failed(
          'The server request failed and local storage could not save this change. Please keep this screen open and try again.',
        );
  }

  public async updateProduct(id: string, draft: ProductDraft): Promise<ProductMutationResult> {
    const ownerId = this.activeUserId;
    if (!ownerId) return this.failed('Sign in before changing your pantry.');
    if (!(await this.ensurePendingChangesLoaded(ownerId))) {
      return this.failed('Pending local changes could not be read. This edit was not sent or discarded.');
    }
    const current = this.productsSubject.value.find((product) => product.id === id);
    if (!current) return this.failed('This pantry item is no longer available. Refresh and try again.');

    const updated: Product = { ...current, ...draft, ownerId };
    const revision = this.bumpRevision(id);
    const hasPendingChange = this.pendingChangesSubject.value.some((change) => change.productId === id);

    if (this.network.currentStatus.connected && !hasPendingChange) {
      try {
        const response = await firstValueFrom(
          this.http
            .put<Product>(`${this.productsUrl}/${encodeURIComponent(id)}`, this.toServerProduct(updated))
            .pipe(timeout({ first: REQUEST_TIMEOUT_MS })),
        );
        const savedProduct = this.withLocalPhoto(response, updated);
        if (this.activeUserId === ownerId && this.currentRevision(id) === revision) {
          // Invalidate any page refresh that started before this confirmed mutation.
          this.mutationRevision++;
          const remaining = this.pendingChangesSubject.value.filter(
            (change) => change.productId !== id || change.type === 'delete',
          );
          const saved = await this.localStorage.savePendingChanges(ownerId, remaining);
          if (saved) this.setPendingChanges(remaining);
          this.setProducts(this.filterProductsLocally(this.mergePendingChanges(this.replaceProduct(id, savedProduct))));
          await this.saveProductCache(ownerId, [savedProduct]);
          await this.cleanupPhotoIfUnreferenced(ownerId, current.photoPath, savedProduct.photoPath);
        }
        return { status: 'synced', message: 'Changes sent to the server.', product: savedProduct };
      } catch {
        // Fall through to the durable local queue.
      }
    }

    if (this.currentRevision(id) !== revision) {
      return { status: 'pending', message: 'A newer edit replaced this failed request; the latest value was kept.' };
    }

    const change = this.createPendingChange(ownerId, 'update', updated);
    const persisted = await this.persistPendingMutation(ownerId, change);
    if (persisted) await this.cleanupPhotoIfUnreferenced(ownerId, current.photoPath, updated.photoPath);
    return persisted
      ? { status: 'pending', message: 'Changes saved on this device; waiting to send to the server.', product: updated }
      : this.failed('The update could not reach the server or be saved locally. Your previous item remains unchanged.');
  }

  public async deleteProduct(id: string): Promise<ProductMutationResult> {
    const ownerId = this.activeUserId;
    if (!ownerId) return this.failed('Sign in before changing your pantry.');
    if (!(await this.ensurePendingChangesLoaded(ownerId))) {
      return this.failed('Pending local changes could not be read. This delete was not sent or discarded.');
    }
    const product = this.productsSubject.value.find((item) => item.id === id);
    if (!product) return this.failed('This pantry item is no longer available. Refresh and try again.');

    const revision = this.bumpRevision(id);
    const isLocalCreate = this.pendingChangesSubject.value.some(
      (change) => change.productId === id && change.type === 'create',
    );
    const hasPendingChange = this.pendingChangesSubject.value.some((change) => change.productId === id);
    if (this.network.currentStatus.connected && !hasPendingChange) {
      try {
        await firstValueFrom(
          this.http
            .delete(`${this.productsUrl}/${encodeURIComponent(id)}`)
            .pipe(timeout({ first: REQUEST_TIMEOUT_MS })),
        );
        if (this.activeUserId === ownerId && this.currentRevision(id) === revision) {
          this.mutationRevision++;
          const remaining = this.pendingChangesSubject.value.filter((change) => change.productId !== id);
          const saved = await this.localStorage.savePendingChanges(ownerId, remaining);
          if (saved) this.setPendingChanges(remaining);
          this.setProducts(this.productsSubject.value.filter((item) => item.id !== id));
          await this.saveProductCache(ownerId, [], remaining, [id]);
          await this.cleanupPhotoIfUnreferenced(ownerId, product.photoPath);
        }
        return { status: 'synced', message: 'Product deleted from the server.' };
      } catch {
        // Fall through to the durable local queue.
      }
    }

    if (this.currentRevision(id) !== revision) {
      return {
        status: 'pending',
        message: 'A newer change replaced this delete request; the latest local state was kept.',
      };
    }

    if (isLocalCreate) {
      const remaining = this.pendingChangesSubject.value.filter((change) => change.productId !== id);
      const persisted = await this.persistQueueAndProducts(
        ownerId,
        remaining,
        this.productsSubject.value.filter((item) => item.id !== id),
        [id],
      );
      if (persisted) await this.cleanupPhotoIfUnreferenced(ownerId, product.photoPath);
      return persisted
        ? {
            status: 'local',
            message: 'Removed from this device. It had not been sent to the server, so no server delete was needed.',
          }
        : this.failed('The item could not be removed safely because local storage failed.');
    }

    const change: PendingProductChange = {
      ...this.createPendingChange(ownerId, 'delete', product),
      product,
    };
    const persisted = await this.persistPendingMutation(ownerId, change);
    return persisted
      ? { status: 'pending', message: 'Removed from this device; deletion is waiting to reach the server.' }
      : this.failed('The delete could not reach the server or be saved locally. The item remains visible.');
  }

  public async retryPendingChange(changeId: string): Promise<ProductMutationResult> {
    const ownerId = this.activeUserId;
    if (!ownerId) return this.failed('Sign in before retrying pending changes.');
    if (!(await this.ensurePendingChangesLoaded(ownerId))) {
      return this.failed('Pending local changes could not be read. No retry was attempted.');
    }
    const requested = this.pendingChangesSubject.value.find((change) => change.id === changeId);
    if (!requested) return { status: 'synced', message: 'This change is no longer pending.' };
    if (!this.network.currentStatus.connected) {
      return { status: 'pending', message: 'Device is offline. The change is still saved on this device.' };
    }
    await this.syncNow();
    if (!this.pendingChangesSubject.value.some((change) => change.id === changeId)) {
      return { status: 'synced', message: 'All queued pantry changes reached the server.' };
    }
    return this.needsAttention
      ? { status: 'attention', message: this.syncStatusSubject.value.message }
      : { status: 'pending', message: this.syncStatusSubject.value.message };
  }

  public async syncNow(): Promise<void> {
    this.needsAttention = false;
    this.retryAttempt = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    await this.synchronizePendingChanges(true);
  }

  private async synchronizePendingChanges(force = false): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    const ownerId = this.activeUserId;
    if (!ownerId || !(await this.ensurePendingChangesLoaded(ownerId))) {
      this.updateSyncStatus();
      return;
    }
    if (this.syncPromise) return this.syncPromise;
    if (this.activeUserId !== ownerId) return;
    if (!this.network.currentStatus.connected) {
      this.updateSyncStatus();
      return;
    }
    if (this.needsAttention && !force) {
      this.updateSyncStatus();
      return;
    }
    if (this.pendingChangesSubject.value.length === 0) {
      this.updateSyncStatus();
      return;
    }

    this.syncing = true;
    this.hasSyncedDuringRun = false;
    this.updateSyncStatus();
    this.syncPromise = this.processPendingQueue(ownerId);
    try {
      await this.syncPromise;
    } finally {
      this.syncPromise = undefined;
      this.syncing = false;
      if (this.hasSyncedDuringRun && this.activeUserId === ownerId) this.loadProducts();
      this.updateSyncStatus();
      if (this.pendingChangesSubject.value.length && this.network.currentStatus.connected && !this.needsAttention) {
        this.scheduleSyncRetry();
      }
      if (this.activeUserId && this.activeUserId !== ownerId && this.network.currentStatus.connected) {
        void this.synchronizePendingChanges();
      }
    }
  }

  private async processPendingQueue(ownerId: string): Promise<void> {
    while (this.activeUserId === ownerId && this.network.currentStatus.connected) {
      const next = this.pendingChangesSubject.value.find((change) => change.ownerId === ownerId);
      if (!next) return;
      const result = await this.sendPendingChange(next);
      if (result.status !== 'synced') {
        if (result.status === 'attention') this.needsAttention = true;
        return;
      }
      this.hasSyncedDuringRun = true;
    }
  }

  private scheduleSyncRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = Math.min(1000 * 2 ** Math.min(this.retryAttempt, 6), MAX_RETRY_DELAY_MS);
    this.retryAttempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.synchronizePendingChanges();
    }, delay);
    this.updateSyncStatus();
  }

  private updateSyncStatus(): void {
    const pendingCount = new Set(this.pendingChangesSubject.value.map((change) => change.productId)).size;
    let state: ProductSyncStatus['state'];
    let message: string;
    if (this.syncing) {
      state = 'syncing';
      message = `Syncing (${pendingCount} pending)`;
    } else if (this.needsAttention && pendingCount) {
      state = 'attention';
      message = `Needs attention (${pendingCount} pending)`;
    } else if (!this.network.currentStatus.connected && pendingCount) {
      state = 'waiting';
      message = `Waiting for connection (${pendingCount} pending)`;
    } else if (pendingCount) {
      state = 'waiting';
      message = `Waiting to sync (${pendingCount} pending)`;
    } else {
      state = 'synced';
      message = 'Synced';
    }
    this.syncStatusSubject.next({ state, pendingCount, message });
  }

  private setPendingChanges(changes: PendingProductChange[]): void {
    this.pendingChangesSubject.next(changes);
    this.updateSyncStatus();
  }

  public isProductPending(productId: string): boolean {
    return this.pendingChangesSubject.value.some((change) => change.productId === productId);
  }

  public getPendingChangesSnapshot(): PendingProductChange[] {
    return this.pendingChangesSubject.value;
  }

  private async postCreate(product: Product, idempotencyKey: string): Promise<Product> {
    return firstValueFrom(
      this.http
        .post<Product>(this.productsUrl, this.toServerProduct(product), {
          headers: new HttpHeaders({ 'Idempotency-Key': idempotencyKey }),
        })
        .pipe(timeout({ first: REQUEST_TIMEOUT_MS })),
    );
  }

  private async persistPendingMutation(ownerId: string, change: PendingProductChange): Promise<boolean> {
    return this.withQueueWrite(async () => {
      const queue = [...this.pendingChangesSubject.value];
      const previous = [...queue].reverse().find((item) => item.productId === change.productId);
      if (previous?.type === 'create' && change.type === 'update') {
        const index = queue.findIndex((item) => item.id === previous.id);
        queue[index] = { ...previous, product: change.product, lastError: change.lastError };
      } else if (previous?.type === 'update' && change.type === 'update') {
        const index = queue.findIndex((item) => item.id === previous.id);
        queue[index] = { ...change, id: previous.id, createdAt: previous.createdAt };
      } else if (previous?.type === 'delete' && change.type === 'delete') {
        const index = queue.findIndex((item) => item.id === previous.id);
        queue[index] = { ...change, id: previous.id, createdAt: previous.createdAt };
      } else {
        queue.push(change);
      }
      const products = this.applyPendingChanges(this.productsSubject.value, queue);
      return this.persistQueueAndProducts(ownerId, queue, products);
    });
  }

  private withQueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queueWriteTail.then(operation, operation);
    this.queueWriteTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async persistQueueAndProducts(
    ownerId: string,
    queue: PendingProductChange[],
    products: Product[],
    removedProductIds: string[] = [],
  ): Promise<boolean> {
    if (!(await this.localStorage.savePendingChanges(ownerId, queue))) return false;
    if (this.activeUserId === ownerId) {
      this.setPendingChanges(queue);
      this.setProducts(this.filterProductsLocally(this.applyPendingChanges(products, queue)));
      this.mutationRevision++;
      if (queue.length === 0) {
        this.needsAttention = false;
        this.retryAttempt = 0;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
      }
    }
    // Queue records contain full create/update/delete data, so they remain recoverable if this cache write fails.
    await this.saveProductCache(ownerId, products, queue, removedProductIds);
    if (
      this.activeUserId === ownerId &&
      queue.length > 0 &&
      this.network.currentStatus.connected &&
      !this.syncing &&
      !this.needsAttention
    ) {
      this.scheduleSyncRetry();
    }
    return true;
  }

  private async saveProductCache(
    ownerId: string,
    incomingProducts: Product[],
    pendingChanges = this.pendingChangesSubject.value,
    removedProductIds: string[] = [],
  ): Promise<void> {
    const cachedProducts = (await this.localStorage.getProducts(ownerId)) ?? [];
    const productMap = new Map(cachedProducts.map((product) => [product.id, product]));
    for (const id of removedProductIds) productMap.delete(id);
    for (const product of incomingProducts) {
      const cached = productMap.get(product.id);
      const savedProduct = { ...product };
      if (!Object.hasOwn(product, 'photoPath') && cached?.photoPath) {
        savedProduct.photoPath = cached.photoPath;
        savedProduct.photoMimeType = cached.photoMimeType;
      }
      productMap.set(product.id, savedProduct);
    }
    const merged = this.applyPendingChanges([...productMap.values()], pendingChanges);
    await this.localStorage.saveProducts(ownerId, merged);
  }

  private async ensurePendingChangesLoaded(ownerId: string): Promise<boolean> {
    if (this.pendingLoadedUserId === ownerId) return true;
    this.pendingLoadPromise ??= this.localStorage
      .getPendingChanges(ownerId)
      .then((changes) => {
        if (this.activeUserId !== ownerId || this.localStorage.hasStorageError) return false;
        this.pendingLoadedUserId = ownerId;
        this.setPendingChanges(changes);
        const cachedBase = this.productsSubject.value;
        this.setProducts(this.applyPendingChanges(cachedBase, changes));
        return true;
      })
      .catch(() => false);
    const loaded = await this.pendingLoadPromise;
    if (!loaded) this.pendingLoadPromise = undefined;
    return loaded;
  }

  private async sendPendingChange(change: PendingProductChange): Promise<ProductMutationResult> {
    const ownerId = change.ownerId;
    try {
      if (change.type === 'create') {
        if (!change.product) throw new Error('Queued product data is missing.');
        const startingRevision = this.currentRevision(change.productId);
        const serverProduct = await this.postCreate(change.product, change.id);
        const product = this.withLocalPhoto(serverProduct, change.product);
        const changedDuringRequest = this.currentRevision(change.productId) !== startingRevision;
        const currentLocal = this.productsSubject.value.find((item) => item.id === change.productId);
        const latestProduct = currentLocal ? { ...currentLocal, id: product.id } : product;
        const queue = this.pendingChangesSubject.value.flatMap((item) => {
          if (item.id === change.id && changedDuringRequest && currentLocal) {
            return [
              {
                ...item,
                id: this.createLocalId(),
                type: 'update' as const,
                productId: product.id,
                product: latestProduct,
                attempts: 0,
                lastError: undefined,
              },
            ];
          }
          if (item.id === change.id) return [];
          return item.productId === change.productId
            ? [
                {
                  ...item,
                  productId: product.id,
                  product: item.product ? { ...item.product, id: product.id } : undefined,
                },
              ]
            : [item];
        });
        if (changedDuringRequest && !currentLocal) {
          queue.push({
            ...change,
            id: this.createLocalId(),
            type: 'delete',
            productId: product.id,
            product,
            attempts: 0,
            lastError: undefined,
          });
        }
        const products = currentLocal
          ? this.replaceProduct(change.productId, latestProduct)
          : this.productsSubject.value.filter((item) => item.id !== change.productId && item.id !== product.id);
        if (!(await this.persistQueueAndProducts(ownerId, queue, products, [change.productId]))) {
          throw new Error('The local pending queue could not be updated.');
        }
        return { status: 'synced', message: 'Pending create sent to the server.', product: latestProduct };
      } else if (change.type === 'update') {
        if (!change.product) throw new Error('Queued product data is missing.');
        const startingRevision = this.currentRevision(change.productId);
        const previousPhotoPath = this.productsSubject.value.find((item) => item.id === change.productId)?.photoPath;
        const product = await firstValueFrom(
          this.http
            .put<Product>(
              `${this.productsUrl}/${encodeURIComponent(change.productId)}`,
              this.toServerProduct(change.product),
            )
            .pipe(timeout({ first: REQUEST_TIMEOUT_MS })),
        );
        if (this.currentRevision(change.productId) !== startingRevision) {
          return { status: 'pending', message: 'A newer local edit was kept; retry the latest update.' };
        }
        const savedProduct = this.withLocalPhoto(product, change.product);
        const queue = this.pendingChangesSubject.value.filter((item) => item.id !== change.id);
        if (
          !(await this.persistQueueAndProducts(ownerId, queue, this.replaceProduct(change.productId, savedProduct)))
        ) {
          throw new Error('The local pending queue could not be updated.');
        }
        await this.cleanupPhotoIfUnreferenced(ownerId, previousPhotoPath, savedProduct.photoPath);
        return { status: 'synced', message: 'Pending update sent to the server.', product: savedProduct };
      } else {
        try {
          await firstValueFrom(
            this.http
              .delete(`${this.productsUrl}/${encodeURIComponent(change.productId)}`)
              .pipe(timeout({ first: REQUEST_TIMEOUT_MS })),
          );
        } catch (error) {
          if ((error as HttpErrorResponse).status !== 404) throw error;
          // A 404 means the desired deleted state already holds for this user's product.
        }
        const queue = this.pendingChangesSubject.value.filter((item) => item.id !== change.id);
        if (
          !(await this.persistQueueAndProducts(
            ownerId,
            queue,
            this.productsSubject.value.filter((item) => item.id !== change.productId),
            [change.productId],
          ))
        ) {
          throw new Error('The local pending queue could not be updated.');
        }
        await this.cleanupPhotoIfUnreferenced(ownerId, change.product?.photoPath);
        return { status: 'synced', message: 'Pending delete sent to the server.' };
      }
    } catch (error) {
      const httpError = error as HttpErrorResponse;
      if (httpError.status === 401) {
        this.auth.handleUnauthorized();
        return { status: 'attention', message: 'Your session expired. Sign in again to sync saved changes.' };
      }
      const message = this.errorMessage(error);
      const queue = this.pendingChangesSubject.value.map((item) =>
        item.id === change.id ? { ...item, attempts: item.attempts + 1, lastError: message } : item,
      );
      await this.persistQueueAndProducts(ownerId, queue, this.productsSubject.value);
      const retryable =
        httpError.status === 0 ||
        httpError.status === 408 ||
        httpError.status === 425 ||
        httpError.status === 429 ||
        httpError.status >= 500;
      if (!retryable) {
        return { status: 'attention', message: `Needs attention before this change can sync: ${message}` };
      }
      return { status: 'pending', message: `Still waiting to sync: ${message}` };
    }
  }

  private createPendingChange(ownerId: string, type: PendingProductChangeType, product: Product): PendingProductChange {
    return {
      id: this.createLocalId(),
      ownerId,
      type,
      productId: product.id,
      product,
      createdAt: new Date().toISOString(),
      attempts: this.network.currentStatus.connected ? 1 : 0,
      lastError: this.network.currentStatus.connected ? 'The server request failed.' : undefined,
    };
  }

  private mergePendingChanges(products: Product[], changes = this.pendingChangesSubject.value): Product[] {
    return this.applyPendingChanges(products, changes);
  }

  private applyPendingChanges(products: Product[], changes: PendingProductChange[]): Product[] {
    const byId = new Map(products.map((product) => [product.id, product]));
    for (const change of changes) {
      if (change.type === 'delete') byId.delete(change.productId);
      else if (change.product) byId.set(change.productId, change.product);
    }
    return [...byId.values()];
  }

  private setProducts(products: Product[]): void {
    this.productsSubject.next(products);
    const selectedId = this.selectedProductSubject.value?.id;
    this.selectedProductSubject.next(products.find((product) => product.id === selectedId) ?? products[0] ?? null);
  }

  private replaceProduct(oldId: string, replacement: Product): Product[] {
    const products = this.productsSubject.value.filter(
      (product) => product.id !== oldId && product.id !== replacement.id,
    );
    return [...products, replacement];
  }

  private bumpRevision(productId: string): number {
    const revision = this.currentRevision(productId) + 1;
    this.productRevisions.set(productId, revision);
    this.mutationRevision++;
    return revision;
  }

  private currentRevision(productId: string): number {
    return this.productRevisions.get(productId) ?? 0;
  }

  private createLocalId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  private errorMessage(error: unknown): string {
    const httpError = error as HttpErrorResponse;
    return (
      httpError.error?.error ||
      (httpError.status ? `Server returned HTTP ${httpError.status}.` : 'The server could not be reached.')
    );
  }

  private failed(message: string): ProductMutationResult {
    return { status: 'failed', message };
  }

  /** Returns the product already loaded for the inventory list, when available. */
  public getCachedProductById(id: string): Product | undefined {
    return this.productsSubject.value.find((product) => product.id === id);
  }

  public selectProduct(product: Product | null): void {
    this.selectedProductSubject.next(product);
  }

  public getExpirationInfo(dateStr: string): ExpirationInfo {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const expDate = new Date(dateStr);
    expDate.setHours(0, 0, 0, 0);

    const diffTime = expDate.getTime() - today.getTime();
    const daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (daysRemaining < 0) {
      const daysAgo = Math.abs(daysRemaining);
      return {
        state: 'expired',
        daysRemaining,
        label: daysAgo === 1 ? 'Expired yesterday' : `Expired ${daysAgo} days ago`,
        color: 'danger',
      };
    } else if (daysRemaining === 0) {
      return {
        state: 'warning',
        daysRemaining,
        label: 'Expires today',
        color: 'warning',
      };
    } else if (daysRemaining === 1) {
      return {
        state: 'warning',
        daysRemaining,
        label: 'Expires tomorrow',
        color: 'warning',
      };
    } else if (daysRemaining <= 3) {
      return {
        state: 'warning',
        daysRemaining,
        label: `Expiring in ${daysRemaining} days`,
        color: 'warning',
      };
    } else {
      return {
        state: 'fresh',
        daysRemaining,
        label: `${daysRemaining} days remaining`,
        color: 'success',
      };
    }
  }

  public getCategoryIcon(category: string): string {
    const lower = category.toLowerCase();
    if (lower.includes('produce') || lower.includes('fruit') || lower.includes('veg')) {
      return 'nutrition-outline';
    }
    if (lower.includes('dairy') || /\beggs?\b/.test(lower)) {
      return 'egg-outline';
    }
    if (lower.includes('bakery') || lower.includes('bread')) return 'restaurant-outline';
    if (lower.includes('meat') || lower.includes('poultry')) return 'flame-outline';
    if (lower.includes('canned')) return 'archive-outline';
    if (lower.includes('beverage')) return 'water-outline';
    return 'basket-outline';
  }
}

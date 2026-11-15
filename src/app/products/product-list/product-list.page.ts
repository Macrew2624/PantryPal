import { CommonModule } from '@angular/common';
import type { OnInit, OnDestroy } from '@angular/core';
import { Component, HostListener, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  AlertController,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButtons,
  IonButton,
  IonIcon,
  IonList,
  IonItem,
  IonLabel,
  IonBadge,
  IonSpinner,
  IonSkeletonText,
  IonSearchbar,
  IonRefresher,
  IonRefresherContent,
  IonModal,
  IonInput,
  IonTextarea,
  IonSelect,
  IonSelectOption,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  basketOutline,
  refreshOutline,
  alertCircleOutline,
  chevronForwardOutline,
  shieldCheckmarkOutline,
  lockOpenOutline,
  warningOutline,
  checkmarkCircleOutline,
  eggOutline,
  nutritionOutline,
  restaurantOutline,
  flameOutline,
  archiveOutline,
  waterOutline,
  sparklesOutline,
  logOutOutline,
  addOutline,
  createOutline,
  trashOutline,
  cloudUploadOutline,
  cameraOutline,
} from 'ionicons/icons';
import { Subscription } from 'rxjs';

import type { PendingProductChange } from '../../models/pending-product-change.model';
import type {
  Product,
  ProductDraft,
  ExpirationInfo,
  ProductExpiryFilter,
  ProductOpenedFilter,
  ProductSortField,
} from '../../models/product.model';
import { AuthService } from '../../services/auth.service';
import { CameraCaptureError, CameraCaptureService } from '../../services/camera-capture.service';
import { LocalProductStorageService } from '../../services/local-product-storage.service';
import { NetworkStatusService } from '../../services/network-status.service';
import { NotificationService } from '../../services/notification.service';
import { PhotoStorageError, PhotoStorageService } from '../../services/photo-storage.service';
import { ProductService } from '../../services/product.service';
import { ProductDetailViewComponent } from '../components/product-detail-view/product-detail-view.component';

@Component({
  selector: 'app-product-list',
  templateUrl: './product-list.page.html',
  styleUrls: ['./product-list.page.scss'],
  imports: [
    CommonModule,
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonButtons,
    IonButton,
    IonIcon,
    IonList,
    IonItem,
    IonLabel,
    IonBadge,
    IonSpinner,
    IonSkeletonText,
    IonSearchbar,
    IonRefresher,
    IonRefresherContent,
    IonModal,
    IonInput,
    IonTextarea,
    IonSelect,
    IonSelectOption,
    IonInfiniteScroll,
    IonInfiniteScrollContent,
    ProductDetailViewComponent,
  ],
})
export class ProductListPage implements OnInit, OnDestroy {
  public products: Product[] = [];
  public searchQuery: string = '';
  public categoryFilter = '';
  public categories = [
    'Bakery',
    'Canned Goods',
    'Dairy & Eggs',
    'Meat & Poultry',
    'Pantry & Dry Goods',
    'Produce & Veggies',
  ];
  public expiryFilter: ProductExpiryFilter = '';
  public openedFilter: ProductOpenedFilter = '';
  public sortBy: ProductSortField = 'id';
  public sortOrder: 'asc' | 'desc' = 'asc';
  public isDesktop: boolean = false;
  public skeletonItems = [1, 2, 3, 4, 5];

  private productService = inject(ProductService);
  private alertController = inject(AlertController);
  private authService = inject(AuthService);
  private cameraCaptureService = inject(CameraCaptureService);
  private photoStorage = inject(PhotoStorageService);
  private localStorage = inject(LocalProductStorageService);
  private networkStatusService = inject(NetworkStatusService);
  private notificationService = inject(NotificationService);
  private router = inject(Router);
  @ViewChild(IonContent) private content?: IonContent;

  public loading$ = this.productService.loading$;
  public error$ = this.productService.error$;
  public selectedProduct$ = this.productService.selectedProduct$;
  public wsConnected$ = this.notificationService.isConnected$;
  public networkStatus$ = this.networkStatusService.status$;
  public syncStatus$ = this.productService.syncStatus$;
  public storageError$ = this.localStorage.storageError$;
  public pendingChanges$ = this.productService.pendingChanges$;
  public hasMore$ = this.productService.hasMore$;
  public pageLoading$ = this.productService.pageLoading$;
  public pageError$ = this.productService.pageError$;
  public cachedOnly$ = this.productService.cachedOnly$;
  public isEditorOpen = false;
  public isSavingProduct = false;
  public editingProduct: Product | null = null;
  public productDraft: ProductDraft = this.emptyDraft();
  public actionMessage = '';
  public actionMessageColor: 'success' | 'warning' | 'danger' = 'success';
  public cameraMessage = '';
  public isCapturingPhoto = false;

  private sub = new Subscription();
  private photoResolutionGeneration = 0;

  constructor() {
    addIcons({
      basketOutline,
      refreshOutline,
      alertCircleOutline,
      chevronForwardOutline,
      shieldCheckmarkOutline,
      lockOpenOutline,
      warningOutline,
      checkmarkCircleOutline,
      eggOutline,
      nutritionOutline,
      restaurantOutline,
      flameOutline,
      archiveOutline,
      waterOutline,
      sparklesOutline,
      logOutOutline,
      addOutline,
      createOutline,
      trashOutline,
      cloudUploadOutline,
      cameraOutline,
    });
  }

  ngOnInit(): void {
    this.checkViewport();

    this.sub.add(
      this.productService.products$.subscribe((items) => {
        void this.resolveProductPreviews(items);
      }),
    );
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }

  @HostListener('window:resize')
  onResize(): void {
    this.checkViewport();
  }

  private checkViewport(): void {
    this.isDesktop = typeof window !== 'undefined' && window.innerWidth >= 768;
  }

  public get filteredProducts(): Product[] {
    const query = this.searchQuery.toLowerCase().trim();
    const today = new Date().toISOString().slice(0, 10);
    const through = new Date(`${today}T00:00:00.000Z`);
    through.setUTCDate(through.getUTCDate() + 3);
    const throughDate = through.toISOString().slice(0, 10);
    return this.products.filter((product) => {
      if (this.categoryFilter && product.category.toLowerCase() !== this.categoryFilter.toLowerCase()) return false;
      if (this.openedFilter && product.isOpened !== (this.openedFilter === 'opened')) return false;
      if (this.expiryFilter === 'expired' && product.expirationDate >= today) return false;
      if (this.expiryFilter === 'expiring' && (product.expirationDate < today || product.expirationDate > throughDate))
        return false;
      if (this.expiryFilter === 'fresh' && product.expirationDate <= throughDate) return false;
      return (
        !query ||
        [product.name, product.category, product.notes ?? ''].some((field) => field.toLowerCase().includes(query))
      );
    });
  }

  public onSelectProduct(product: Product): void {
    this.productService.selectProduct(product);
    if (!this.isDesktop) {
      this.router.navigate(['/products', product.id]);
    }
  }

  public getExpirationInfo(dateStr: string): ExpirationInfo {
    return this.productService.getExpirationInfo(dateStr);
  }

  public getCategoryIcon(category: string): string {
    return this.productService.getCategoryIcon(category);
  }

  public refresh(): void {
    this.productService.loadProducts();
  }

  public searchChanged(event: CustomEvent<{ value?: string | null }>): void {
    this.searchQuery = event.detail.value ?? '';
    this.filterChanged();
  }

  public filterChanged(): void {
    this.productService.setSearchCriteria({
      search: this.searchQuery,
      category: this.categoryFilter,
      expiryStatus: this.expiryFilter,
      opened: this.openedFilter,
      sortBy: this.sortBy,
      sortOrder: this.sortOrder,
    });
    void this.content?.scrollToTop(250);
  }

  public get hasActiveFilters(): boolean {
    return Boolean(
      this.searchQuery.trim() ||
      this.categoryFilter ||
      this.expiryFilter ||
      this.openedFilter ||
      this.sortBy !== 'id' ||
      this.sortOrder !== 'asc',
    );
  }

  public clearFilters(): void {
    this.searchQuery = '';
    this.categoryFilter = '';
    this.expiryFilter = '';
    this.openedFilter = '';
    this.sortBy = 'id';
    this.sortOrder = 'asc';
    this.filterChanged();
  }

  public async loadMore(event: CustomEvent): Promise<void> {
    await this.productService.loadNextPage();
    await (event.target as HTMLIonInfiniteScrollElement).complete();
  }

  public retryNextPage(): void {
    void this.productService.loadNextPage();
  }

  public openCreateEditor(): void {
    this.editingProduct = null;
    this.productDraft = this.emptyDraft();
    this.cameraMessage = '';
    this.isEditorOpen = true;
  }

  public async openEditEditor(product: Product): Promise<void> {
    this.editingProduct = product;
    this.productDraft = {
      name: product.name,
      category: product.category,
      quantity: product.quantity,
      unit: product.unit ?? '',
      expirationDate: product.expirationDate,
      isOpened: product.isOpened,
      notes: product.notes ?? '',
      photoPath: product.photoPath,
      photoMimeType: product.photoMimeType,
      photoPreviewUrl: product.photoPreviewUrl,
    };
    this.cameraMessage = '';
    this.isEditorOpen = true;
    if (product.photoPath && this.authService.currentUserId) {
      try {
        this.productDraft.photoPreviewUrl = await this.photoStorage.getPhotoUrl(
          this.authService.currentUserId,
          product.photoPath,
          product.photoMimeType,
        );
      } catch (error) {
        this.cameraMessage = error instanceof Error ? error.message : 'The saved photo could not be opened.';
      }
    }
  }

  public async takePhoto(): Promise<void> {
    if (this.isCapturingPhoto) return;
    this.isCapturingPhoto = true;
    this.cameraMessage = '';
    let savedPhoto: { photoPath: string; photoMimeType: string } | undefined;
    try {
      const ownerId = this.authService.currentUserId;
      if (!ownerId) throw new Error('Sign in before saving a pantry photo.');
      const capturedPhoto = await this.cameraCaptureService.takePhoto();
      const replacement = await this.photoStorage.replacePhoto(ownerId, this.productDraft.photoPath, capturedPhoto);
      savedPhoto = replacement;
      const previousStagedPath = this.productDraft.photoPath;
      const previewUrl = await this.photoStorage.getPhotoUrl(ownerId, replacement.photoPath, replacement.photoMimeType);
      this.productDraft = { ...this.productDraft, ...replacement, photoPreviewUrl: previewUrl };
      if (previousStagedPath && previousStagedPath !== this.editingProduct?.photoPath) {
        await this.photoStorage.deletePhoto(ownerId, previousStagedPath);
      }
    } catch (error) {
      if (savedPhoto) {
        const ownerId = this.authService.currentUserId;
        if (ownerId) await this.photoStorage.deletePhoto(ownerId, savedPhoto.photoPath);
      }
      this.cameraMessage =
        error instanceof CameraCaptureError || error instanceof PhotoStorageError
          ? error.message
          : 'Unable to open or save the photo. Check camera access and available device storage.';
    } finally {
      this.isCapturingPhoto = false;
    }
  }

  public removePhoto(): void {
    const previousPath = this.productDraft.photoPath;
    this.productDraft = { ...this.productDraft, photoPreviewUrl: undefined };
    delete this.productDraft.photoPath;
    delete this.productDraft.photoMimeType;
    this.cameraMessage = 'Photo removed from this edit.';
    const ownerId = this.authService.currentUserId;
    if (ownerId && previousPath && previousPath !== this.editingProduct?.photoPath) {
      void this.photoStorage.deletePhoto(ownerId, previousPath);
    }
  }

  public async handleEditorDismiss(): Promise<void> {
    this.isEditorOpen = false;
    const stagedPath = this.productDraft.photoPath;
    const ownerId = this.authService.currentUserId;
    if (ownerId && stagedPath && stagedPath !== this.editingProduct?.photoPath) {
      await this.photoStorage.deletePhoto(ownerId, stagedPath);
    }
  }

  public handlePhotoLoadError(product?: Product): void {
    if (product) {
      this.products = this.products.map((item) =>
        item.id === product.id ? { ...item, photoPreviewUrl: undefined } : item,
      );
    }
    this.cameraMessage = 'This saved image could not be displayed. Retake the photo to replace it.';
  }

  public async saveProduct(): Promise<void> {
    if (this.isSavingProduct) return;
    this.isSavingProduct = true;
    this.actionMessage = '';

    const result = this.editingProduct
      ? await this.productService.updateProduct(this.editingProduct.id, this.normalizedDraft())
      : await this.productService.createProduct(this.normalizedDraft());

    this.isSavingProduct = false;
    this.actionMessage = result.message;
    this.actionMessageColor =
      result.status === 'failed' || result.status === 'attention'
        ? 'danger'
        : result.status === 'pending'
          ? 'warning'
          : 'success';
    if (result.status !== 'failed') this.isEditorOpen = false;
  }

  public async confirmDelete(product: Product): Promise<void> {
    const alert = await this.alertController.create({
      header: 'Delete pantry item?',
      message: `Remove ${product.name} from your pantry?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: () => void this.deleteProduct(product) },
      ],
    });
    await alert.present();
  }

  public async retryPendingChange(change: PendingProductChange): Promise<void> {
    const result = await this.productService.retryPendingChange(change.id);
    this.actionMessage = result.message;
    this.actionMessageColor =
      result.status === 'failed' || result.status === 'attention'
        ? 'danger'
        : result.status === 'pending'
          ? 'warning'
          : 'success';
  }

  public async retryProductSync(productId: string): Promise<void> {
    const change = this.productService
      .getPendingChangesSnapshot()
      .find((pendingChange) => pendingChange.productId === productId);
    if (change) await this.retryPendingChange(change);
  }

  public async syncNow(): Promise<void> {
    await this.productService.syncNow();
  }

  public isProductPending(productId: string): boolean {
    return this.productService.isProductPending(productId);
  }

  public handleRefresh(event: CustomEvent): void {
    this.productService.loadProducts();
    setTimeout(() => {
      const target = event.target as HTMLIonRefresherElement | null;
      if (target) {
        target.complete();
      }
    }, 700);
  }

  public retry(): void {
    this.productService.loadProducts();
  }

  public sendTestNotification(): void {
    this.notificationService.triggerTestNotification().subscribe({
      next: () => {
        console.log('Test notification broadcast requested successfully');
      },
      error: (err) => {
        console.warn('Failed to send test notification:', err);
      },
    });
  }

  public logout(): void {
    this.authService.logout();
  }

  private async deleteProduct(product: Product): Promise<void> {
    const result = await this.productService.deleteProduct(product.id);
    this.actionMessage = result.message;
    this.actionMessageColor =
      result.status === 'failed' || result.status === 'attention'
        ? 'danger'
        : result.status === 'pending'
          ? 'warning'
          : 'success';
  }

  private normalizedDraft(): ProductDraft {
    return {
      name: this.productDraft.name.trim(),
      category: this.productDraft.category.trim(),
      quantity: Number(this.productDraft.quantity),
      expirationDate: this.productDraft.expirationDate,
      isOpened: this.productDraft.isOpened,
      unit: this.productDraft.unit?.trim() || undefined,
      notes: this.productDraft.notes?.trim() || undefined,
      photoPath: this.productDraft.photoPath,
      photoMimeType: this.productDraft.photoMimeType,
    };
  }

  private async resolveProductPreviews(items: Product[]): Promise<void> {
    const generation = ++this.photoResolutionGeneration;
    const ownerId = this.authService.currentUserId;
    const resolved = await Promise.all(
      items.map(async (product) => {
        if (!ownerId || !product.photoPath || product.ownerId !== ownerId) return product;
        try {
          return {
            ...product,
            photoPreviewUrl: await this.photoStorage.getPhotoUrl(ownerId, product.photoPath, product.photoMimeType),
          };
        } catch {
          // Keep the product available; the view/editor can offer a replacement for a missing image.
          return product;
        }
      }),
    );
    if (generation === this.photoResolutionGeneration) this.products = resolved;
  }

  private emptyDraft(): ProductDraft {
    return {
      name: '',
      category: '',
      quantity: 1,
      unit: '',
      expirationDate: new Date().toISOString().slice(0, 10),
      isOpened: false,
      notes: '',
    };
  }
}

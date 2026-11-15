import { CommonModule } from '@angular/common';
import type { OnChanges, SimpleChanges } from '@angular/core';
import { ChangeDetectorRef, Component, Input, inject } from '@angular/core';
import {
  IonCard,
  IonCardHeader,
  IonCardTitle,
  IonCardSubtitle,
  IonCardContent,
  IonChip,
  IonIcon,
  IonLabel,
  IonList,
  IonItem,
  IonBadge,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  lockOpenOutline,
  shieldCheckmarkOutline,
  alertCircleOutline,
  warningOutline,
  checkmarkCircleOutline,
  calendarOutline,
  cubeOutline,
  pricetagOutline,
  documentTextOutline,
  basketOutline,
  eggOutline,
  nutritionOutline,
  restaurantOutline,
  flameOutline,
  archiveOutline,
  waterOutline,
} from 'ionicons/icons';

import type { Product, ExpirationInfo } from '../../../models/product.model';
import { AuthService } from '../../../services/auth.service';
import { PhotoStorageService } from '../../../services/photo-storage.service';
import { ProductService } from '../../../services/product.service';

@Component({
  selector: 'app-product-detail-view',
  templateUrl: './product-detail-view.component.html',
  styleUrls: ['./product-detail-view.component.scss'],
  imports: [
    CommonModule,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardSubtitle,
    IonCardContent,
    IonChip,
    IonIcon,
    IonLabel,
    IonList,
    IonItem,
    IonBadge,
  ],
})
export class ProductDetailViewComponent implements OnChanges {
  @Input() product: Product | null = null;

  public expirationInfo: ExpirationInfo = {
    state: 'fresh',
    daysRemaining: 0,
    label: '',
    color: 'success',
  };

  public categoryIcon: string = 'basket-outline';
  public formattedExpirationDate: string = '';
  public photoUrl: string | null = null;
  public photoError: string | null = null;

  private productService = inject(ProductService);
  private authService = inject(AuthService);
  private photoStorage = inject(PhotoStorageService);
  private changeDetector = inject(ChangeDetectorRef);
  private photoGeneration = 0;

  constructor() {
    addIcons({
      lockOpenOutline,
      shieldCheckmarkOutline,
      alertCircleOutline,
      warningOutline,
      checkmarkCircleOutline,
      calendarOutline,
      cubeOutline,
      pricetagOutline,
      documentTextOutline,
      basketOutline,
      eggOutline,
      nutritionOutline,
      restaurantOutline,
      flameOutline,
      archiveOutline,
      waterOutline,
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['product'] && this.product) {
      this.updateProductDetails();
      void this.resolvePhoto(this.product);
    }
  }

  private async resolvePhoto(product: Product): Promise<void> {
    const generation = ++this.photoGeneration;
    this.photoUrl = null;
    this.photoError = null;
    const ownerId = this.authService.currentUserId;
    if (!product.photoPath || !ownerId || product.ownerId !== ownerId) return;
    try {
      const url = await this.photoStorage.getPhotoUrl(ownerId, product.photoPath, product.photoMimeType);
      if (generation === this.photoGeneration) {
        this.photoUrl = url;
        this.changeDetector.markForCheck();
      }
    } catch (error) {
      if (generation === this.photoGeneration) {
        this.photoError = error instanceof Error ? error.message : 'The saved photo could not be opened.';
        this.changeDetector.markForCheck();
      }
    }
  }

  public handlePhotoLoadError(): void {
    this.photoUrl = null;
    this.photoError = 'This saved image could not be displayed. Replace it while editing this product.';
    this.changeDetector.markForCheck();
  }

  private updateProductDetails(): void {
    if (!this.product) return;

    this.expirationInfo = this.productService.getExpirationInfo(this.product.expirationDate);
    this.categoryIcon = this.productService.getCategoryIcon(this.product.category);

    try {
      const date = new Date(this.product.expirationDate);
      this.formattedExpirationDate = new Intl.DateTimeFormat('en-US', {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(date);
    } catch {
      this.formattedExpirationDate = this.product.expirationDate;
    }
  }
}

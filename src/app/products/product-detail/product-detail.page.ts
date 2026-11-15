import { CommonModule } from '@angular/common';
import type { HttpErrorResponse } from '@angular/common/http';
import type { OnInit, OnDestroy } from '@angular/core';
import { Component, Input, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  IonHeader,
  IonToolbar,
  IonButtons,
  IonBackButton,
  IonTitle,
  IonContent,
  IonSpinner,
  IonIcon,
  IonButton,
  IonBadge,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import { alertCircleOutline, arrowBackOutline, refreshOutline } from 'ionicons/icons';
import type { Subscription } from 'rxjs';

import type { Product } from '../../models/product.model';
import { AuthService } from '../../services/auth.service';
import { NetworkStatusService } from '../../services/network-status.service';
import { ProductService } from '../../services/product.service';
import { ProductDetailViewComponent } from '../components/product-detail-view/product-detail-view.component';

@Component({
  selector: 'app-product-detail',
  templateUrl: './product-detail.page.html',
  styleUrls: ['./product-detail.page.scss'],
  imports: [
    CommonModule,
    RouterLink,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonContent,
    IonSpinner,
    IonIcon,
    IonButton,
    IonBadge,
    ProductDetailViewComponent,
  ],
})
export class ProductDetailPage implements OnInit, OnDestroy {
  /** Set by withComponentInputBinding() where supported; ActivatedRoute is used as the primary source. */
  @Input() id?: string;

  public product?: Product;
  public isLoading: boolean = true;
  public notFound: boolean = false;
  public errorMessage: string = '';

  private productService = inject(ProductService);
  private authService = inject(AuthService);
  private networkStatusService = inject(NetworkStatusService);
  private route = inject(ActivatedRoute);
  private fetchSub?: Subscription;
  private routeSub?: Subscription;
  /** Last ID that triggered a fetch, used to avoid duplicate requests. */
  private _loadedId?: string;
  public networkStatus$ = this.networkStatusService.status$;

  constructor() {
    addIcons({ alertCircleOutline, arrowBackOutline, refreshOutline });
  }

  ngOnInit(): void {
    console.log('[ProductDetail] ngOnInit – @Input id:', this.id);
    // Use ActivatedRoute.paramMap as the primary source of truth for the id.
    // This works reliably with both <router-outlet> and Ionic's <ion-router-outlet>,
    // where withComponentInputBinding() may not propagate @Input() from route params.
    this.routeSub = this.route.paramMap.subscribe((params) => {
      const paramId = params.get('id') ?? undefined;
      // Prefer the route param; fall back to the @Input value if provided
      const resolvedId = paramId ?? this.id;
      console.log(
        '[ProductDetail] paramMap emit – paramId:',
        paramId,
        'resolvedId:',
        resolvedId,
        '_loadedId:',
        this._loadedId,
      );
      if (resolvedId !== this._loadedId) {
        this._loadedId = resolvedId;
        this.id = resolvedId;
        this.fetchProduct();
      }
    });
  }

  ngOnDestroy(): void {
    this.fetchSub?.unsubscribe();
    this.routeSub?.unsubscribe();
  }

  public logout(): void {
    this.authService.logout();
  }

  public retry(): void {
    this._loadedId = undefined; // allow re-fetch of the same id
    this.fetchProduct();
  }

  public fetchProduct(): void {
    if (!this.id) {
      this.isLoading = false;
      this.notFound = true;
      this.errorMessage = 'No product ID provided.';
      return;
    }

    // The list page already fetched this product. Reuse it on mobile navigation
    // instead of waiting on a second API request for the same data.
    const cachedProduct = this.productService.getCachedProductById(this.id);
    if (cachedProduct) {
      this.fetchSub?.unsubscribe();
      this.product = cachedProduct;
      this.productService.selectProduct(cachedProduct);
      this.isLoading = false;
      this.notFound = false;
      this.errorMessage = '';
      return;
    }

    // Cancel any in-flight request before starting a new one
    this.fetchSub?.unsubscribe();

    this.isLoading = true;
    this.notFound = false;
    this.errorMessage = '';

    this.fetchSub = this.productService.getProductById(this.id).subscribe({
      next: (product) => {
        this.isLoading = false;
        this.product = product;
        this.notFound = false;
      },
      error: (err: HttpErrorResponse) => {
        this.isLoading = false;
        this.product = undefined;
        this.notFound = true;
        this.errorMessage =
          err.status === 404
            ? err.error?.error || `Product with ID '${this.id}' was not found.`
            : 'Could not connect to the backend server. Please check your connection and retry.';
      },
    });
  }
}

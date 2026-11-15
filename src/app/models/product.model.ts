export interface Product {
  id: string;
  ownerId: string;
  name: string;
  category: string;
  quantity: number;
  expirationDate: string; // ISO 8601 string (e.g. 'YYYY-MM-DD')
  isOpened: boolean;
  unit?: string;
  notes?: string;
  /** Stable per-user relative file path for a persistent local image. Never sent to the REST API. */
  photoPath?: string;
  photoMimeType?: string;
  /** Runtime-only image URL. It is regenerated from photoPath and never persisted. */
  photoPreviewUrl?: string;
}

export interface CapturedPhoto {
  base64: string;
  mimeType: string;
}

export interface ProductPageResponse {
  items: Product[];
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
}

export type ProductExpiryFilter = '' | 'expired' | 'expiring' | 'fresh';
export type ProductOpenedFilter = '' | 'opened' | 'sealed';
export type ProductSortField = 'id' | 'name' | 'expirationDate';

export interface ProductSearchCriteria {
  search: string;
  category: string;
  expiryStatus: ProductExpiryFilter;
  opened: ProductOpenedFilter;
  sortBy: ProductSortField;
  sortOrder: 'asc' | 'desc';
}

export type ProductDraft = Omit<Product, 'id' | 'ownerId'>;

export interface ProductMutationResult {
  status: 'synced' | 'pending' | 'attention' | 'local' | 'failed';
  message: string;
  product?: Product;
}

export type SyncState = 'synced' | 'waiting' | 'syncing' | 'attention';

export interface ProductSyncStatus {
  state: SyncState;
  pendingCount: number;
  message: string;
}

export type ExpirationState = 'expired' | 'warning' | 'fresh';

export interface ExpirationInfo {
  state: ExpirationState;
  daysRemaining: number;
  label: string;
  color: 'danger' | 'warning' | 'success';
}

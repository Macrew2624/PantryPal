import type { Product } from './product.model';

export type PendingProductChangeType = 'create' | 'update' | 'delete';

/** Local record for a product mutation that has not been synchronized yet. */
export interface PendingProductChange {
  id: string;
  ownerId: string;
  type: PendingProductChangeType;
  productId: string;
  product?: Product;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

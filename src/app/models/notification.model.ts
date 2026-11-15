export type NotificationType =
  'PRODUCT_ADDED' | 'PRODUCT_UPDATED' | 'PRODUCT_DELETED' | 'TEST_NOTIFICATION' | 'CONNECTION_ESTABLISHED';

export interface PantryNotification {
  type: NotificationType | string;
  message: string;
  productId?: string;
  product?: unknown;
  timestamp: string;
}

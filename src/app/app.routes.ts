import type { Routes } from '@angular/router';

import { authGuard, guestGuard } from './guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'products',
    pathMatch: 'full',
  },
  {
    path: 'home',
    redirectTo: 'products',
    pathMatch: 'full',
  },
  {
    path: 'login',
    loadComponent: () => import('./auth/auth.page').then((m) => m.AuthPage),
    canActivate: [guestGuard],
  },
  {
    path: 'products',
    loadComponent: () => import('./products/product-list/product-list.page').then((m) => m.ProductListPage),
    canActivate: [authGuard],
  },
  {
    path: 'products/:id',
    loadComponent: () => import('./products/product-detail/product-detail.page').then((m) => m.ProductDetailPage),
    canActivate: [authGuard],
  },
  {
    path: '**',
    redirectTo: 'products',
  },
];

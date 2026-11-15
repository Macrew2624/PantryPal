import { expect, test } from '@playwright/test';

const devCredentials = { email: 'demo@pantrypal.local', password: 'PantryPalDev!2026' };
const tokenStorageKey = 'pantrypal.auth.token';
const apiBaseUrl = 'http://localhost:3001';

test.describe('authentication', () => {
  test('rejects a failed login without leaving the login page', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await page.locator('ion-input[name="email"] input').fill(devCredentials.email);
    await page.locator('ion-input[name="password"] input').fill('WrongPassword!2026');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page.getByRole('alert')).toContainText('Invalid email or password');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('registers an account and signs in with it', async ({ page }) => {
    const email = `new-user-${Date.now()}@pantrypal.local`;
    await page.goto('/login');
    await page.getByRole('button', { name: /Create an account/ }).click();
    await page.locator('ion-input[name="email"] input').fill(email);
    await page.locator('ion-input[name="password"] input').fill('NewAccount!2026');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();

    await expect(page.getByRole('status')).toContainText('Account created');
    await page.locator('ion-input[name="password"] input').fill('NewAccount!2026');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/products$/);
    await expect(page.locator('.product-item')).toHaveCount(10);
  });

  test('restores a valid session on reload and clears it on logout', async ({ page }) => {
    await page.goto('/login');
    await page.locator('ion-input[name="email"] input').fill(devCredentials.email);
    await page.locator('ion-input[name="password"] input').fill(devCredentials.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('.product-item')).toHaveCount(10);

    const savedToken = await page.evaluate((key) => localStorage.getItem(key), tokenStorageKey);
    expect(savedToken).toBeTruthy();
    await page.reload();
    await expect(page.locator('.product-item')).toHaveCount(10);

    await page.goto('/login');
    await expect(page).toHaveURL(/\/products$/);
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.evaluate((key) => localStorage.getItem(key), tokenStorageKey)).resolves.toBeNull();
    await page.reload();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('clears and redirects an invalid saved token', async ({ page, request }) => {
    const login = await request.post(`${apiBaseUrl}/api/auth/login`, { data: devCredentials });
    const token = (await login.json()).token as string;
    const tokenParts = token.split('.');
    tokenParts[2] = `${tokenParts[2][0] === 'a' ? 'b' : 'a'}${tokenParts[2].slice(1)}`;
    const tamperedToken = tokenParts.join('.');

    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: tokenStorageKey,
      value: tamperedToken,
    });
    await page.goto('/products');

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.evaluate((key) => localStorage.getItem(key), tokenStorageKey)).resolves.toBeNull();
  });
});

test.describe('authenticated pantry', () => {
  let accessToken = '';

  test.beforeEach(async ({ page, request }) => {
    const login = await request.post(`${apiBaseUrl}/api/auth/login`, { data: devCredentials });
    expect(login.status()).toBe(200);
    accessToken = (await login.json()).token as string;
    await request.post(`${apiBaseUrl}/api/products/reset`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: tokenStorageKey,
      value: accessToken,
    });
  });

  test('shows API products and opens the selected product details on mobile', async ({ page }) => {
    await page.goto('/');

    const firstProduct = page.locator('.product-item').first();
    await expect(page.locator('.product-item')).toHaveCount(10);
    const productName = (await firstProduct.locator('.product-name').textContent())?.trim();
    await firstProduct.click();

    await expect(page.locator('app-product-detail-view .product-title')).toHaveText(productName ?? '');
    await expect(page.locator('app-product-detail-view')).toContainText('Expiration Date');
  });

  test('shows the split master-detail interface on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    await expect(page.locator('.product-item')).toHaveCount(10);
    await expect(page.locator('.detail-pane')).toBeVisible();
    await page.locator('.product-item').nth(1).click();
    await expect(page.locator('.detail-pane .product-title')).toHaveText('Greek Yogurt 10%');
  });

  test('loads additional products with infinite scroll without duplicates', async ({ page, request }) => {
    for (let index = 0; index < 15; index++) {
      const response = await request.post(`${apiBaseUrl}/api/products`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        data: {
          name: `Pagination item ${index}`,
          category: 'Pantry',
          quantity: index + 1,
          expirationDate: '2030-01-01',
          isOpened: false,
        },
      });
      expect(response.status()).toBe(201);
    }

    await page.goto('/');
    await expect(page.locator('.product-item')).toHaveCount(20);
    await page
      .locator('ion-content')
      .first()
      .evaluate((element) => {
        const scrollArea = element.shadowRoot?.querySelector('.inner-scroll') as HTMLElement | null;
        if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight;
      });
    await expect(page.locator('.product-item')).toHaveCount(25);
    await expect(page.locator('.product-name', { hasText: 'Pagination item' })).toHaveCount(15);
  });

  test('keeps infinite scrolling within the active search and category filters', async ({ page, request }) => {
    for (let index = 0; index < 25; index++) {
      const response = await request.post(`${apiBaseUrl}/api/products`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        data: {
          name: `Filtered scroll item ${String(index).padStart(2, '0')}`,
          category: 'Bakery',
          quantity: index + 1,
          expirationDate: '2035-01-01',
          isOpened: false,
          notes: 'pagination search fixture',
        },
      });
      expect(response.status()).toBe(201);
    }

    await page.goto('/');
    await page.locator('ion-searchbar input').fill('Filtered scroll item');
    await expect(page.locator('.product-item')).toHaveCount(20);
    await page.locator('.product-filters ion-select').first().click();
    await page.getByRole('radio', { name: 'Bakery', exact: true }).click();
    await expect(page.locator('.product-item')).toHaveCount(20);
    await page
      .locator('ion-content')
      .first()
      .evaluate((element) => {
        const scrollArea = element.shadowRoot?.querySelector('.inner-scroll') as HTMLElement | null;
        if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight;
      });
    await expect(page.locator('.product-item')).toHaveCount(25);
    await expect(page.locator('.product-name', { hasText: 'Filtered scroll item' })).toHaveCount(25);
    await page.getByRole('button', { name: 'Clear search and filters' }).first().click();
    await expect(page.locator('ion-searchbar input')).toHaveValue('');
    await expect(page.locator('.product-item')).toHaveCount(20);
  });

  test('updates the network indicator when browser connectivity changes', async ({ page }) => {
    await page.goto('/');
    const networkBadge = page.locator('.network-status-badge');
    await expect(networkBadge).toHaveText('ONLINE');

    await page.context().setOffline(true);
    await expect(networkBadge).toHaveText('OFFLINE');

    await page.context().setOffline(false);
    await expect(networkBadge).toHaveText('ONLINE');
  });

  test('loads the saved inventory when the product API is unavailable', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.product-item')).toHaveCount(10);
    await page.waitForFunction(() => {
      const token = localStorage.getItem('pantrypal.auth.token');
      if (!token) return false;
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return new Promise<boolean>((resolve) => {
        const open = indexedDB.open('pantrypal');
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('pantry')) {
            db.close();
            resolve(false);
            return;
          }
          const request = db
            .transaction('pantry', 'readonly')
            .objectStore('pantry')
            .get(`pantrypal.products.v1.${encodeURIComponent(payload.sub)}`);
          request.onsuccess = () => {
            db.close();
            resolve(Array.isArray(request.result) && request.result.length === 10);
          };
          request.onerror = () => {
            db.close();
            resolve(false);
          };
        };
      });
    });

    await page.route('**/api/products**', (route) => route.abort());
    await page.reload();

    await expect(page.locator('.product-item')).toHaveCount(10);
  });

  test('persists a product photo across reload and preserves it when editing other fields', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.product-item')).toHaveCount(10);

    const productRow = page.locator('.product-item').filter({ hasText: 'Whole Milk 3.5%' });
    await productRow.getByRole('button', { name: 'Edit Whole Milk 3.5%', exact: true }).click();
    await page.locator('app-product-list').evaluate(async (element) => {
      const angular = (window as any).ng;
      const component = angular.getComponent(element);
      component.cameraCaptureService.takePhoto = async () => ({
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=',
        mimeType: 'image/png',
      });
      await component.takePhoto();
      angular.applyChanges(component);
    });
    await expect(page.locator('ion-modal .photo-preview')).toBeVisible();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      page.locator('.product-item').filter({ hasText: 'Whole Milk 3.5%' }).locator('img.product-photo-thumbnail'),
    ).toBeVisible();

    await page.reload();
    const rowAfterReload = page.locator('.product-item').filter({ hasText: 'Whole Milk 3.5%' });
    await expect(rowAfterReload.locator('img.product-photo-thumbnail')).toBeVisible();
    await rowAfterReload.click();
    await expect(page.locator('app-product-detail-view .product-title')).toHaveText('Whole Milk 3.5%');
    await expect(page.locator('app-product-detail-view img.product-detail-photo')).toBeVisible();
    await page.goBack();

    await rowAfterReload.getByRole('button', { name: 'Edit Whole Milk 3.5%', exact: true }).click();
    await expect(page.locator('ion-modal .photo-preview')).toBeVisible();
    await page.locator('ion-modal ion-input[name="quantity"] input').fill('6');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.reload();
    await expect(
      page.locator('.product-item').filter({ hasText: 'Whole Milk 3.5%' }).locator('img.product-photo-thumbnail'),
    ).toBeVisible();
  });

  test('retains failed create, update, and delete operations across reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.product-item')).toHaveCount(10);
    await page.route('**/api/products**', async (route) => {
      if (route.request().method() === 'POST') await route.abort();
      else await route.continue();
    });
    await page.route('**/api/products/*', async (route) => {
      if (['PUT', 'DELETE'].includes(route.request().method())) await route.abort();
      else await route.continue();
    });

    await page.getByRole('button', { name: 'Add pantry item' }).click();
    await page.locator('ion-modal ion-input[name="name"] input').fill('Local only oats');
    await page.locator('ion-modal ion-input[name="category"] input').fill('Pantry');
    await page.locator('ion-modal ion-input[name="quantity"] input').fill('3');
    await page.locator('ion-modal ion-input[name="expirationDate"] input').fill('2030-02-01');
    await page.getByRole('button', { name: 'Add to pantry' }).click();
    await expect(page.locator('.pending-sync-banner')).toContainText('Local only oats');
    await expect(page.locator('.product-name', { hasText: 'Local only oats' })).toBeVisible();

    const milkItem = page.locator('.product-item').filter({ hasText: 'Whole Milk 3.5%' });
    await milkItem.getByRole('button', { name: 'Edit Whole Milk 3.5%', exact: true }).click();
    await page.locator('ion-modal ion-input[name="name"] input').fill('Updated locally milk');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('.product-name', { hasText: 'Updated locally milk' })).toBeVisible();

    const secondItem = page.locator('.product-item').filter({ hasText: 'Greek Yogurt 10%' });
    const deletedName = (await secondItem.locator('.product-name').textContent())?.trim();
    await secondItem.getByRole('button', { name: `Delete ${deletedName}`, exact: true }).click();
    await page.locator('ion-alert').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.product-name', { hasText: deletedName ?? 'no-match' })).toHaveCount(0);
    await expect(page.locator('.pending-sync-banner')).toContainText('deletion pending');

    await page.reload();
    await expect(page.locator('.product-name', { hasText: 'Local only oats' })).toBeVisible();
    await expect(page.locator('.product-name', { hasText: 'Updated locally milk' })).toBeVisible();
    await expect(page.locator('.product-name', { hasText: deletedName ?? 'no-match' })).toHaveCount(0);
    await expect(page.locator('.pending-sync-banner')).toBeVisible();
  });

  test('shows product change notifications and refreshes the inventory over WebSocket', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.product-item')).toHaveCount(10);
    await expect(page.locator('.ws-status-badge')).toHaveText('LIVE');

    const response = await request.post(`${apiBaseUrl}/api/products`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: {
        name: 'E2E Fresh Bagels',
        category: 'Bakery',
        quantity: 4,
        expirationDate: '2030-01-05',
        isOpened: false,
        unit: 'pieces',
      },
    });
    expect(response.status()).toBe(201);

    await expect(page.locator('ion-toast')).toContainText('Added new pantry item: "E2E Fresh Bagels"');
    await expect(page.locator('.product-name', { hasText: 'E2E Fresh Bagels' })).toBeVisible();
  });
});

# PantryPal

PantryPal is an Ionic and Angular pantry inventory app with a separate Express REST API. The current first iteration lets you browse pantry products, search the inventory, inspect product details, see expiration and opened status, and receive live notifications when products change.

The backend keeps accounts and products in memory, so server-side changes are lost when it restarts. The app provides list, search, refresh, detail, and product create/edit/delete flows. Pending local changes survive app reloads and can be retried when connectivity returns.

## Features

- Responsive master-detail interface: a split list and detail pane on desktop, and a list-to-detail navigation flow on narrow/mobile viewports.
- Product inventory is loaded from `GET /api/products`; detail routes request `GET /api/products/:id` when the product is not already in the loaded inventory.
- Product lists use authenticated server-side `limit`/`offset` pagination, stable sorting, and Ionic infinite scroll. Debounced search covers name, category, and notes; category, expiry window, opened/sealed status, and name/expiry sorting are applied before pagination. Changing criteria resets pagination and scroll position, and stale page responses are ignored. The same rules are applied to the complete per-user cache offline, with pending local creates and edits included and pending deletes hidden. Offline results are explicitly marked as cached results.
- Product details show name, category, quantity/unit, expiration date/status, opened status, and notes when present.
- The product editor uses Capacitor Camera to capture photos and Filesystem to store them as uniquely named files in the app's persistent data directory. Per-user relative file paths are stored with cached products and pending changes; image bytes and runtime preview URLs are never stored in localStorage or sent to the REST API. Photos are shown in the list, detail view, and editor. Upload to the backend is not implemented.
- Search filters by product name, category, or notes.
- Loading, empty-inventory, API-error, and product-not-found states are provided, with retry actions where applicable.
- A WebSocket connection displays a live/offline indicator and in-app toast notifications. Product add, update, and delete events also refresh the list without a page reload.
- The API broadcasts `PRODUCT_ADDED`, `PRODUCT_UPDATED`, and `PRODUCT_DELETED` after successful mutations. A development endpoint can send a test notification.
- Capacitor Network plus browser online/offline events provide a visible online/offline indicator in the login and pantry headers. This describes device connectivity; API reachability is determined by the result of REST requests.
- Product data and typed pending create/update/delete operations are stored per authenticated account with Ionic Storage. IndexedDB is preferred on web with LocalStorage as fallback; the service can read older per-user Capacitor Preferences records.
- Product mutations try REST first when the device reports online. On offline status or request failure, changes remain visible locally and enter the per-user durable queue. The app automatically drains that queue at startup and when connectivity returns, using FIFO order to preserve dependencies such as create-before-update. Create retries reuse a stable idempotency key; updates and deletes are idempotent REST operations.
- Temporary sync failures remain queued and retry with exponential backoff (1 second up to 60 seconds). A `401` stops syncing and clears the expired session; validation/conflict errors remain queued and show **Needs attention** with the server reason. The toolbar shows sync state and pending count, and **Sync now** starts a manual attempt. Server refresh after successful sync overlays pending changes and avoids overwriting a newer local mutation.
- Local storage errors are reported visibly. If the pending queue cannot be read, the app pauses server refresh and mutations to avoid overwriting unknown local work.
- JWT authentication protects all product and notification REST endpoints. Each product has an `ownerId` derived only from the verified token; list, detail, create, update, delete, and reset operations are scoped to that owner. The offline cache and pending-change queue are namespaced per owner too.
- WebSocket clients send an `AUTHENTICATE` message with the JWT as their first frame. The server does not subscribe them or send a greeting until the token validates, then routes product notifications only to sockets with the matching owner ID. Use `wss://` behind TLS in production.

## Requirements

- Node.js compatible with the installed Angular 22 and backend dependencies.
- npm.

## Install

From the project root:

```bash
npm install
npm --prefix server install
```

Configure the backend before starting it. Copy `server/.env.example` to `server/.env`, then replace `JWT_SECRET` with a random secret at least 32 bytes long. Keep the real `.env` out of source control and use a secret manager/environment variable in production.

```powershell
Copy-Item server/.env.example server/.env
```

## Run frontend and backend independently

Start the backend in one terminal:

```bash
npm run server
```

For backend development with Node watch mode:

```bash
npm run server:dev
```

Start the Ionic/Angular frontend in another terminal for use on the same computer:

```bash
npm start
```

The frontend runs at `http://localhost:4200`. The REST API and WebSocket server share port `3000` (`http://localhost:3000` and `ws://localhost:3000`). In development, REST and WebSocket addresses use the hostname from the app's current browser URL, so opening the frontend through the computer's LAN IP also directs API requests to that host. Production API URLs are configured in `src/environments/environment.prod.ts`. Backend CORS is permissive for this local-development iteration and is not production hardened.

### Open the development app on a phone over Wi-Fi

The development frontend now derives the REST and WebSocket host from the hostname used to open the app. Start the API with `npm run server`, then start Angular so it listens on the LAN:

```bash
npm run start:host
```

Find the computer's Wi-Fi IPv4 address with `ipconfig` on Windows (or the equivalent network settings on your OS). On the phone, connected to the same Wi-Fi, open `http://<computer-ip>:4200` (for example `http://192.168.1.25:4200`). The phone will then call `http://<computer-ip>:3000/api` and connect to `ws://<computer-ip>:3000` automatically. Allow Node.js or inbound TCP ports 3000 and 4200 through the computer firewall if prompted. Do not use `localhost` on the phone: it refers to the phone itself. This setup is for local development over HTTP; it is not a production deployment or a substitute for HTTPS on public networks.

## Authentication

The backend reads `JWT_SECRET` from its environment and refuses to start if it is missing or shorter than 32 bytes. A successful login returns an HS256 JWT that expires after one hour. Passwords are hashed with bcrypt and are never included in API responses. User accounts are held in memory for this iteration, so accounts registered through the app must be recreated after restarting the backend.

In development, the backend seeds this demo account unless `SEED_DEV_USER=false`:

| Email                  | Password            |
| ---------------------- | ------------------- |
| `demo@pantrypal.local` | `PantryPalDev!2026` |

These credentials are for local development only. The seed is disabled when `NODE_ENV=production`; never use the demo account or an example secret in production. Users can also create an account from the app's login page or by calling `POST /api/auth/register`.

The frontend stores the JWT in `localStorage`, validates the expiration when restoring it, and calls `/api/auth/me` to verify it with the server. Product and notification requests receive the Bearer token through an HTTP interceptor. A protected request that returns 401 clears the local session and returns to login. Browser WebSockets cannot set an Authorization header, so the client sends the token in the first WebSocket frame (never in a URL or query string); the server authenticates before subscribing.

## API

Base URL: `http://localhost:3000`

| Method   | Endpoint                  | Purpose                                                                                                                                                                                                                                                                 |
| -------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/health`             | Backend health check                                                                                                                                                                                                                                                    |
| `POST`   | `/api/auth/register`      | Public account registration                                                                                                                                                                                                                                             |
| `POST`   | `/api/auth/login`         | Public login; returns a signed JWT                                                                                                                                                                                                                                      |
| `GET`    | `/api/auth/me`            | Return the current user; requires a Bearer JWT                                                                                                                                                                                                                          |
| `GET`    | `/api/products`           | Paginated list; JWT required; `limit` (1–100), `offset`, `search` (name/category/notes), `category`, `expiryStatus` (`expired`, `expiring` within 3 UTC days, `fresh`), `opened` (`opened`/`sealed`), `sortBy` (`name`/`expirationDate`) and `sortOrder` (`asc`/`desc`) |
| `GET`    | `/api/products/:id`       | Read one product; requires JWT                                                                                                                                                                                                                                          |
| `POST`   | `/api/products`           | Create a product; requires JWT; broadcasts `PRODUCT_ADDED`                                                                                                                                                                                                              |
| `PUT`    | `/api/products/:id`       | Update a product; requires JWT; broadcasts `PRODUCT_UPDATED`                                                                                                                                                                                                            |
| `DELETE` | `/api/products/:id`       | Delete a product; requires JWT; broadcasts `PRODUCT_DELETED`                                                                                                                                                                                                            |
| `POST`   | `/api/products/reset`     | Restore sample inventory; requires JWT                                                                                                                                                                                                                                  |
| `POST`   | `/api/notifications/test` | Development notification; requires JWT                                                                                                                                                                                                                                  |

Example API create request (Bash; requires `jq`):

```bash
TOKEN=$(curl -s http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@pantrypal.local","password":"PantryPalDev!2026"}' | jq -r .token)

curl -X POST http://localhost:3000/api/products \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Avocado","category":"Produce & Veggies","quantity":3,"expirationDate":"2030-11-05","isOpened":false}'
```

The app's sparkles button sends a test notification through `/api/notifications/test`.

Manual authentication checks: log in with the development credentials (or register a new user), reload the app and confirm it stays on the pantry, then use **Log out** and confirm reload returns to login. Try a wrong password and confirm an error appears without entering the app. For protected API checks, request `/api/products` without a token and with an invalid token (both should return 401), then log in and retry with `Authorization: Bearer <token>` (should return 200).

To manually verify ownership isolation, register two users. Log in as the first and create a product through the API, then log in as the second and request that product's ID with `GET`, `PUT`, and `DELETE`; each request should return 404, and the second user's list should not include it. Keep both users connected to the WebSocket and create/update/delete a product as the first user; only the first user's session should show the matching notification. Sign out and back in as the other user on the same browser/device to confirm the locally cached inventory switches to that user's cache.

## Network status and local persistence

`@capacitor/network`, `@capacitor/preferences` (legacy fallback/migration), and `@ionic/storage-angular` are included. Ionic Storage is configured with IndexedDB and LocalStorage drivers; it initializes from the app's standalone providers. For native builds, add the target platform if it is not already present (`npx cap add android` or `npx cap add ios`), then run `npx cap sync` after installing dependencies and again after adding or changing native plugins.

Manual check in a browser:

1. Start the backend and frontend using the commands above and open the app online. Confirm the `ONLINE` badge appears and the product list loads.
2. While the app is still open, enable Network throttling **Offline**. Confirm the badge changes to `OFFLINE` and the loaded pantry remains visible. Disable throttling and confirm the badge returns to `ONLINE`.
3. To check persistence across a reload in a browser, leave the device online but stop the backend, then reload the frontend. The API request should fail and the last saved inventory should load from local storage. Restart the backend and use the refresh button to request the current inventory.
4. Disable the API while keeping the device online (or switch the browser to Offline). Add a product, edit an existing product, and delete another. Confirm created/edited products stay visible with **Pending sync**, deleted products disappear, and the pending banner names each unsent operation. Reload the app while the API remains unavailable; pending changes should still appear. Restore API access: automatic synchronization should start when the app observes online status. Confirm the status moves through **Syncing** to **Synced**; use **Sync now** or an item's **Retry** control for a manual attempt.
5. Add enough products to exceed one page and scroll to the bottom. Confirm additional products append once and scrolling stops when the API reports no more results. Search for a unique name/notes term, select category plus expiry/opened filters, then scroll: only matching products should appear on every loaded page. Change a criterion while a next page is loading; the stale response should not appear. Clear search and filters and verify the list and scroll position reset. Repeat while offline to confirm cached products and matching pending local edits are filtered consistently. Try a filter combination with no matches and temporarily block the API to confirm the helpful empty, cached-only, and retry states.

On a native device, load the inventory once, enable Airplane Mode, and confirm the badge changes to `OFFLINE`. Add, edit, and delete products while offline; verify the pending labels, banner, and **Waiting for connection** status. Force-close and reopen the installed app; the account's cached inventory and pending operations should remain. Disable Airplane Mode and confirm pending operations are sent automatically. Browser/device online state is only an indication and does not guarantee the API is reachable.

## Product photos (Assignment 3)

`@capacitor/camera` 8.2.6 and `@capacitor/filesystem` 8.1.5 are installed and compatible with Capacitor 8.6.0. Captured images are written to `Directory.Data` under `pantrypal-photos/<encoded-user-id>/` with a unique name. Ionic Storage persists only the relative file path and MIME type with each user's cached product and pending operation; preview URLs are generated when needed. On native platforms, image URLs are converted with `Capacitor.convertFileSrc`; in the browser the Filesystem Blob is shown through an object URL. REST payloads intentionally omit local photo data, and the backend does not receive image uploads.

The edit modal shows an existing saved photo, preserves its file reference when the product is edited without changing the photo, and offers **Take photo**/**Retake photo** and **Remove photo**. Replacing a photo writes a new file first; the old file is removed only after local product and pending-queue records no longer reference it. Failed saves leave the existing product/photo intact. Files are partitioned by authenticated account so switching users cannot resolve another account's photo paths. Missing or unreadable images leave the product usable and show guidance to replace the photo.

For Android and iOS, add the target platform if necessary and sync the installed plugin with `npx cap sync`. The Camera plugin's native camera flow does not save to the device gallery. The plugin setup documentation lists `NSCameraUsageDescription`, `NSPhotoLibraryAddUsageDescription`, and `NSPhotoLibraryUsageDescription` in `ios/App/App/Info.plist`; add clear purpose strings before using it on iOS. On Android, the plugin does not require storage permissions for this flow; keep `saveToGallery` disabled. The repository currently has no `android/` or `ios/` platform project, so native manifests and permissions are not configured or device-tested here. The plugin returns an error if the user denies access; the editor shows a message directing them to device settings.

For native use, add the platform if necessary and run `npx cap sync`. The repository currently has no `android/` or `ios/` project, so native permissions are not configured and native hardware behavior has not been verified. Camera permission handling is required; Filesystem app-private `Directory.Data` storage does not require broad external-storage permissions. On iOS, add the camera usage description to `Info.plist` as required by the Camera plugin. On Android, keep `saveToGallery` disabled for this private app-storage workflow.

On a secure browser origin (localhost is allowed), the app uses a browser image input with a camera capture hint; browser capabilities may offer a live camera or file picker. Browser Filesystem persistence relies on the plugin's browser storage and remains subject to browser data eviction/site-data clearing. To manually verify persistence, capture a photo while editing a product and save it, confirm it appears in the list and detail view, refresh/restart the app, then open edit and confirm the photo is still present. Save an edit to another field without touching the photo and verify the same image remains. Retake the photo and confirm the replacement appears after reload; remove it and confirm it stays removed. Repeat with the API offline so the product and photo path are preserved in the local cache and pending queue, then restore connectivity. Try canceling capture and denying camera permission; existing saved photos should remain. Unit tests simulate filesystem persistence across service recreation and reference-safe deletion; they do not verify a real camera or native device restart.

The browser and Capacitor network events trigger synchronization, but they cannot prove the API is reachable; failed REST requests use backoff. There is no background task when the app is fully closed, and this in-memory backend loses server data on restart. Invalid or expired sessions require sign-in again. Validation and conflict responses are deliberately kept for user attention rather than being dropped or retried forever.

## Build, checks, and tests

```bash
npm run build       # production frontend build
npm run lint        # ESLint, E2E type check, and Prettier check
npm run test:unit   # Angular/Vitest unit tests
npm run server:test # backend REST and WebSocket tests
npm run test:e2e    # Playwright mobile browser flow; starts frontend and backend
npm test            # unit and E2E suites
```

The unit suite simulates REST failures and verifies create/update/delete records stay in the visible inventory or durable queue; service-recreation tests check pantry and photo storage persistence. The backend tests also use two accounts to verify resource isolation and owner-only WebSocket notifications. The E2E suite starts an isolated backend on port 3001 and the frontend with matching API/WebSocket URLs. It covers auth/session flows, mobile details, desktop split view, online/offline changes, product mutation failures with reload recovery, per-user cached inventory, live WebSocket refresh, and photo storage across reload plus edits that leave the photo unchanged. The photo E2E uses a synthetic camera result to exercise browser Filesystem persistence; it does not test camera hardware. Install its browser if needed with `npx playwright install chromium`.

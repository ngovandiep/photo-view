# MiLeo Sync: Wi-Fi photo sync

The desktop app can receive photos and videos from a phone over the local Wi-Fi network. No cloud service is involved.

## Setup

1. Add at least one photo folder in the app (it becomes the destination library).
2. Open **Wi-Fi Sync** in the sidebar and press **Start sync server**. The server listens on this PC's private LAN address only (never on all interfaces, never from public IPs).
3. Press **Show pairing code**. A QR code and an 8-character code appear; each works once and expires after 2 minutes.
4. On the phone (same Wi-Fi) scan the QR code or open the shown `https://<ip>:<port>` address. The certificate is self-signed, so the browser shows a warning. Compare the fingerprint shown in the desktop app with the certificate details, then continue.
5. Pick photos and upload. Files land in `<library>/Wi-Fi Sync/<Device>/<YYYY>/<MM>/`.

Windows Firewall may ask to allow the app on private networks; allow it.

## Install on Phone

The Preview's top bar has an **Install on Phone** button. It opens a dialog without replacing the existing folder, viewer, or Wi-Fi Sync actions.

1. Add a photo folder, then open **Install on Phone** in the Electron desktop app.
2. Press **Start and show QR code** (or **Show pairing QR code** if the server is already running). This uses the existing LAN server and single-use pairing mechanism; it does not create another server.
3. Keep the phone on the same Wi-Fi, scan the QR code, or copy the Phone URL. Compare the displayed certificate fingerprint before trusting the self-signed HTTPS certificate. The QR/link includes a short-lived pairing code, so share it only with the intended phone.
4. The phone page shows an **Install MiLeo Sync** bar at the very top with an **Add to Home Screen** button; after pairing, the library header also has a **📱 Install** button. When the browser offers its own install prompt (Android Chrome with a trusted certificate), the button opens it. Otherwise it opens a guide with an arrow pointing to where the browser keeps **Add to Home Screen** (Chrome's ⋮ menu at the top-right; Safari's Share button in the toolbar). Web pages cannot press that browser command themselves. The ✕ hides the bar on that phone, and the header button brings it back. Both disappear once MiLeo Sync runs from the Home Screen.
5. On **Android**, use Chrome's **⋮ → Add to Home screen** / **Install app**.
6. On **iPhone/iPad**, open in Safari and use **Share → Add to Home Screen** (Chrome/Firefox on iPhone are told to switch to Safari). Enable **Open as Web App** if offered.

If the phone does not trust the Desktop certificate, the browser refuses to register the offline service worker (for example "An SSL certificate error occurred when fetching the script"). The page treats this as expected: it explains that MiLeo will be added as a Home Screen shortcut that works normally on the same Wi-Fi, without offline mode.

The phone page also shows Desktop reachability status when the Desktop cannot be reached. The Desktop dialog shows server state and the number of paired devices, not a claim that those devices are currently online. Expired/consumed codes disappear; generate another code for a new phone. Editor permission is required to start the server or pair a phone. Browser-only Preview explains that these actions need the Desktop app.

The phone pages show the branding set in **Admin dashboard → Branding**. They read it from the public, read-only `GET /api/v1/branding` endpoint (names, slogan, website and logo URL only, no secrets) and `GET /brand-logo`. The web manifest name and short name follow the same settings. A phone that is already installed keeps the Home Screen name and icon it was installed with.

This is the existing mobile web companion, not a separate native app, APK, or App Store listing. No native build or store URL is included in this repository. Installation is browser/OS-dependent: bypassing a certificate warning does **not** make a self-signed origin trusted for PWA/service-worker use. Unless the phone trusts the certificate, installation/offline support may be unavailable; the online mobile site remains the fallback. There is no insecure HTTP workaround.

The manifest includes standalone display, app identity, theme, and 192/512px maskable icons; iOS also has an Apple touch icon. Where supported, a service worker caches **only the public app shell** (HTML, scripts, styles, icons, manifest). It never intercepts or caches APIs, photo/video bytes, account data, pairing claims, or transfers. Offline launch can show the shell and reconnection guidance, but live browsing, pairing, sign-in, and uploads need the Desktop online. The LAN origin depends on the PC's IP/port; changing either can require a new shortcut/pairing. Reserve the PC's LAN address on your router for a stable shortcut.

## Security model

Optional **Family mode** adds assigned-account profiles, read-only album grants,
and per-device upload policies. When enabled, pairing alone does not authorize
uploads or library browsing. See [Family setup and access rules](FAMILY_SHARING.md).
Legacy behavior below applies when Family mode is off.

- HTTPS with a self-signed certificate created once and stored in the app data folder (`wifi-sync/`). The private key is encrypted with the OS keystore (Electron `safeStorage`) when available. The SHA-256 fingerprint is in the QR code so native clients can pin it.
- Pairing codes are random, single-use, short-lived and stored only as hashes. Claiming is atomic. Attempts are rate limited per IP.
- Each device receives its own random 256-bit token, stored only as a hash. Revoking a device invalidates it immediately and cancels its pending uploads.
- Requests from non-private IP addresses are rejected. General and failed-auth requests are rate limited.
- Uploads are limited by extension allowlist, declared media type, magic-byte check, max file size (default 4 GB) and free disk space. Declared size is enforced while streaming.
- File names and folder names are sanitized; destination paths are verified to stay inside the library; existing files are never overwritten (`name (1).jpg`).
- Asset registration may include `sha256` (64 hexadecimal characters). The server hashes the completed upload and rejects a mismatch before storing it. Clients that can hash their source should send this field to detect transfer corruption; the server always calculates and records its own SHA-256.
- Exact-content duplicates are checked against prior sync imports and the connected library. Existing originals are retained; a duplicate upload records its device/source identity and points to the existing asset or library path rather than creating another file.

## API (v1)

Base: `https://<ip>:<port>/api/v1`. Errors are `{ "error": { "code", "message" } }`. Authenticated routes need `Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/ping` | Public. `{service, apiVersion, appVersion, tls}` |
| POST | `/pairing/claim` | `{code, deviceName, platform}` → `201 {deviceId, token}` |
| GET / DELETE | `/device` | Device info / unpair (revoke) |
| POST | `/sessions` | Header `Idempotency-Key` (required). Repeating a key returns the same session |
| GET | `/sessions/{id}` | Session with progress counts |
| POST | `/sessions/{id}/assets` | `{assets:[{sourceAssetId, filename, mediaType, size, capturedAt(ms), sha256?}]}` (max 500). `sha256` is the optional source-file digest. Per-item result or error. Re-registering the same `sourceAssetId` returns the existing asset |
| HEAD | `/assets/{id}/content` | Headers `Upload-Offset`, `Upload-Length`, `Upload-State` |
| PUT | `/assets/{id}/content` | Raw bytes. Header `Upload-Offset` must equal the server offset, otherwise `409` with the correct `Upload-Offset`. Any chunk size; resume by sending the rest |
| GET | `/assets/{id}` | Asset state |
| POST | `/sessions/{id}/complete` | Closes the session and records last sync time |
| POST | `/assets/verify-delete` | `{assets:[{assetId, sha256}]}` → per item `safeToDelete` (true only if stored, the hash matches the PC copy, and the file exists on the PC) or a `reason` |
| POST | `/assets/{id}/deleted` | `{sha256}`. Call after deleting on the phone; re-verifies, then records `deviceDeletedAt`. `409` if not safe |

Registration accepts an optional `folderPath` (for example `DCIM/Camera`). The PC mirrors it as `<library>/Wi-Fi Sync/<Device>/DCIM/Camera/`, so phone folders appear as the same folders in the library tree. Without it, files go to `<YYYY>/<MM>`.

### Transfer, then delete from the phone

Compute the SHA-256 on the phone, call `verify-delete`, ask the user to approve, delete only the `safeToDelete` files, then call `/deleted`. The phone web page does this when the browser supports `showDirectoryPicker` (Chrome-based browsers; "Link a folder"). iOS Safari and many Android browsers lack it, so use a native client there. Files over 200 MB are skipped in the web page.

Asset states: `discovered → queued → uploading → stored → indexed`, plus `failed_retryable` (automatic exponential backoff, permanent after 6 tries; retry button in the desktop UI), `failed_permanent`, `cancelled`. API responses also include a user-facing `status`: `pending`, `uploading`, `verifying`, `imported`, `failed` or `duplicate`; the existing `state` field remains for compatibility.

- `stored` = the file is safely in the library. `indexed` = it is also in the library index. Photos and videos use the existing library index and thumbnail/browsing workflow. If indexing fails the file stays stored and only indexing is retried.
- Content duplicates (same SHA-256) are not stored again; the asset is `indexed` with `duplicateOf` set.

### Sync database migration

The sync database applies an additive migration that stores an optional client-declared SHA-256 and the path of a matching original already in the library. Existing rows receive `NULL` values; existing device, session, and asset records and all original media remain unchanged. No photo-library index schema migration is required.

To roll back, first stop MiLeo and make a backup of `wifi-sync.db` together with its SQLite WAL/SHM files. Restore the complete pre-migration database snapshot and run the previous application version. Do not remove or restore over library photos as part of a database rollback.

### Native client guidance

The native Android client (M2) lives in [`mobile/android`](../mobile/android/README.md). For its architecture, permissions, background limits, and the iOS plan, see [MOBILE_SYNC.md](./MOBILE_SYNC.md).

- **Android**: enumerate with `MediaStore`, use the media `_ID` (+ volume) as `sourceAssetId`, schedule with `WorkManager` (network-unmetered constraint), upload with HEAD→PUT chunks, pin the fingerprint from the QR with a custom `X509TrustManager`.
- **iOS**: enumerate with `PhotoKit` (`PHAsset.localIdentifier` as `sourceAssetId`), export resources to a temp file, upload with a background `URLSession`; pin via `URLSessionDelegate` server-trust evaluation.

## Phone web app (live library)

The sync server also serves a mobile web app at `https://<ip>:<port>/` (and `/app`). Scanning the pairing QR code opens it and pairs automatically; afterwards the phone remembers the pairing. It shows the PC's current library live: category tabs (All / Photos / Videos / PDFs), search by name or tag, favorites filter, a viewer with swipe navigation, video playback with seeking, and a favorite button that writes back to the PC's index (the desktop app refreshes a few seconds later). The menu shows the desktop's signed-in account, lets you pick a library, jump to the upload page (`/pair`) or unpair.

- When the desktop is signed in to an account, a paired phone must also sign in with that same account (email and password are checked against the account server by the desktop; the phone stays signed in until you press Sign out in its ⋮ menu (it survives app restarts; signing in again is only needed if the desktop switches to a different account or the device is unpaired)). Until then `/me` reports `loginRequired`, and `/libraries*` returns `403 login_required`. Routes: `POST /login {email,password}`, `POST /logout`. With no account on the desktop (local mode) there is nothing to sign in to, so pairing alone grants access.
- **This phone** (`/device`, bottom menu → Phone): add one or more folders on the phone (e.g. `DCIM`, `Pictures`, `Movies`); photos and videos from all of them are gathered and grouped by app (Camera, Screenshots, WhatsApp, Zalo, Messenger, Telegram, Facebook, Instagram, TikTok, Downloads, Other), guessed from the folder names. Filter by app, sort by newest or largest, preview, select (button or long-press, **All** selects the current app) and permanently delete. It runs entirely on the phone through the browser's File System Access API, so it needs Chrome on Android 132+ (not iPhone/Safari), and Android blocks pickers for the storage root, `Download` and `Android/` (so WhatsApp's newer `Android/media` folder cannot be chosen). Deletion is permanent, with no recycle bin.
- A bottom menu gives one-tap access to **Library**, **Folders**, **Timeline**, **Favorites** and **More** (library picker, Send/upload page, account, sign out, unpair).
- **Select and delete:** tap **Select** or long-press a photo, video, document or folder card, tap more, then **Delete**. Files go to the PC's **Recycle Bin** (restorable); deleting a folder trashes all files inside, including nested ones, but leaves empty directories. API: `GET /libraries/{id}/folders?parent=`, `items?folder=`, `POST /libraries/{id}/delete {paths, folders}`. Edits are written to the library index directly, so a simultaneous desktop edit can race (last writer wins).
- The Timeline (year pills, month cards with sample thumbnails; tap a month to expand it and open items). API: `GET /libraries/{id}/timeline?kind=&q=&favorite=1` returns month buckets, and `items` accepts `month=YYYY-MM`.
- The ⤴ button in the viewer shares the actual file (photo, video or PDF) through the phone's share sheet, or downloads it where the browser cannot share files. Large videos are loaded into phone memory first.
- Video tiles show a first-frame preview that the phone decodes from the file itself; swipe left/right in the viewer to move between photos and videos (on a video, swipe above the seek bar).
- Files are streamed from the PC on demand (HTTP range requests); thumbnails are generated on the PC (cached in `wifi-sync/thumbs`). HEIC/DNG have no thumbnail; PDFs open in the phone's PDF viewer.
- The paired device token is also stored in an HttpOnly, SameSite=Strict cookie so `<img>`/`<video>` can load files. Cookie-authenticated writes must send the `X-Still-App` header.
- Browsing is read-only apart from favorites: it cannot delete, rename or move files.
- The server only accepts private-network clients. To use it away from home, connect the phone with a VPN to your home network (for example WireGuard or Tailscale) rather than exposing the port to the internet.
- Routes (device token required): `GET /api/v1/me`, `GET /libraries`, `GET /libraries/{id}/items?kind=&q=&favorite=1&offset=&limit=`, `GET /libraries/{id}/file?path=`, `GET /libraries/{id}/thumb?path=&w=`, `POST /libraries/{id}/favorite {path, favorite}`, `POST|DELETE /session` (cookie).

## Chat with admin and notifications on the phone

- The 💬 button in the phone app opens **Chat with admin** and **Notifications** — the same conversation as the desktop's 💬 panel. Users can send text and photos (photos are shrunk on the phone to about 1600 px, at most ~1.4 MB). Admins reply from the desktop admin dashboard (Messages page).
- Available only when the desktop is signed in to an account and the phone is signed in to that same account (`/me` reports `chat: true`). The phone never receives the account token: the desktop relays every request to the account server.
- Every device of a user is notified: the desktop (in-app badge + OS notification when unfocused) and every signed-in phone (live badge, `(n)` title prefix, app badge, vibration and a tap-to-open banner; a system notification is shown only where the browser allows it). Reading on any device clears the unread counts everywhere.
- Phone alerts work while the phone page is open (foreground or recently backgrounded tab). Background push is not implemented. The optional app-shell service worker does not provide it, and service-worker registration itself requires certificate trust.
- Signing out on the desktop or the phone ends the phone's live stream immediately.
- Routes (device token or cookie, phone signed in): `GET /chat/stream` (Server-Sent Events: `unread`, `message`, `notification`, `status`), `GET /chat/status`, `GET /chat/messages?after=`, `POST /chat/messages {text, image?:{type,data(base64)}}` (png/jpeg/gif/webp), `POST /chat/read`, `GET /chat/notifications`, `POST /chat/notifications/read {ids?}`, `GET /chat/images/{id}`. Errors: `403 login_required`, `409 chat_unavailable` (desktop signed out), `503 chat_offline` (account server unreachable).

## Sync administration (Admin dashboard, Milestone M3)

The sync admin pages live in the existing **Admin dashboard** (sidebar button, administrator sign-in required). Every value comes from `wifi-sync.db`, the library index files or the file system. No statistic is hard-coded.

- **Overview.** Shows:
  - total library assets (photos, videos and documents in the index, missing files excluded);
  - uploaded assets (new files added from devices, duplicates excluded);
  - paired, registered and connected devices;
  - pending and failed jobs, library size and free disk space;
  - recent sessions, devices, failed jobs and security events.
- **Connected devices.** Shows name, platform, registration date, last seen, connection status and synced/pending/failed counts. *Revoke* immediately invalidates the device token: the next request gets `401`, and the device's unfinished jobs are cancelled. Already imported photos are kept.
- **Sync history.** Has two views:
  - **Sessions:** device, status, media, error type and date filters, plus CSV export.
  - **Individual files** (`admin:files`): device, status, file name and date filters. The status filter uses pending, uploading, verifying, imported, duplicate, failed or cancelled. Each row shows the file name, size, verification result (SHA-256 verified, checksum mismatch, duplicate, not verified yet) and error details. Library paths and full hashes are never shown.
- **Upload queue** (`admin:queue`). Lists active, pending and failed jobs.
  - *Retry* (`admin:asset-retry`) gives a failed job a fresh retry budget. Files already stored in the library are only re-indexed, never uploaded again.
  - *Cancel* (`admin:asset-cancel`) requires confirmation and works only for pending, uploading or retrying jobs. It is refused while the file is transferring or being verified, and for files already in the library. Cancel discards only the partial temp file in `incoming/`; nothing is deleted from the phone or the library. Cancel is final on the desktop: the phone sees `409 asset_closed`, shows the file as failed, and a retry on the phone uploads it as a new job.
  - *Pause receiving* / *Resume receiving* stop and start the sync server for all devices. Pause cannot be applied to a single device. Phones keep their own queues and continue when the desktop is reachable again.
- **Storage & system.** Shows library paths, disk capacity, database `quick_check` and schema version, indexing status, sync server status, the data directory, and the `incoming/` temporary directory with the size of its partial files.
- **Activity logs.** Records:
  - pairing: `pairing_code_created`, `device_paired`;
  - devices: `device_revoked`, `device_renamed`, `device_removed`;
  - uploads: `upload_imported`, `upload_duplicate`, `upload_failed`;
  - recovery: `recovery` (interrupted uploads resumed at server start);
  - administrator actions: `retry_requested`, `asset_cancelled`, `uploads_paused`, `uploads_resumed`, `config_changed`, `server_started`, `server_stopped`;
  - authentication failures.

  Tokens and pairing codes are never logged. The log keeps the most recent 5,000 events.

No schema change was needed for M3. Cancelled jobs use the existing `cancelled` asset state.

## Data and migrations

State is kept in `wifi-sync/wifi-sync.db` (SQLite via Node's built-in `node:sqlite`, which prints an experimental warning). Schema migrations use `PRAGMA user_version`; migration 1 creates `settings`, `pairing_codes`, `devices`, `sync_sessions`, `assets` and `idempotent_responses`. The existing JSON photo index is unchanged; imported images are added to it through `indexStore.addPhoto`.

## Tests

`npm run test:index` runs `tests/wifi-sync.test.cjs` (pairing, auth, revocation, upload, idempotency, duplicates, resume, restart recovery, invalid/oversize files, disk space, path traversal, TLS pinning, index regression). `tests/admin.test.cjs` covers the admin dashboard backend: overview counts, file-level history filters, the upload queue, cancel safety, retry, pause/resume, activity events and revocation.

## Back gesture

On the phone, the Android back button/swipe closes the top overlay first (viewer, selection, menu, This phone preview), then goes up one folder level, instead of leaving the app.

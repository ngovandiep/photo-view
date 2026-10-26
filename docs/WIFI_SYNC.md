# Wi-Fi Photo Sync

The desktop app can receive photos and videos from a phone over the local Wi-Fi network. No cloud service is involved.

## Setup

1. Add at least one photo folder in the app (it becomes the destination library).
2. Open **Wi-Fi Sync** in the sidebar and press **Start sync server**. The server listens on this PC's private LAN address only (never on all interfaces, never from public IPs).
3. Press **Show pairing code**. A QR code and an 8-character code appear; each works once and expires after 2 minutes.
4. On the phone (same Wi-Fi) scan the QR code or open the shown `https://<ip>:<port>` address. The certificate is self-signed, so the browser shows a warning. Compare the fingerprint shown in the desktop app with the certificate details, then continue.
5. Pick photos and upload. Files land in `<library>/Wi-Fi Sync/<Device>/<YYYY>/<MM>/`.

Windows Firewall may ask to allow the app on private networks; allow it.

## Security model

- HTTPS with a self-signed certificate created once and stored in the app data folder (`wifi-sync/`). The private key is encrypted with the OS keystore (Electron `safeStorage`) when available. The SHA-256 fingerprint is in the QR code so native clients can pin it.
- Pairing codes are random, single-use, short-lived and stored only as hashes. Claiming is atomic. Attempts are rate limited per IP.
- Each device receives its own random 256-bit token, stored only as a hash. Revoking a device invalidates it immediately and cancels its pending uploads.
- Requests from non-private IP addresses are rejected. General and failed-auth requests are rate limited.
- Uploads are limited by extension allowlist, declared media type, magic-byte check, max file size (default 4 GB) and free disk space. Declared size is enforced while streaming.
- File names and folder names are sanitized; destination paths are verified to stay inside the library; existing files are never overwritten (`name (1).jpg`).

## API (v1)

Base: `https://<ip>:<port>/api/v1`. Errors are `{ "error": { "code", "message" } }`. Authenticated routes need `Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/ping` | Public. `{service, apiVersion, appVersion, tls}` |
| POST | `/pairing/claim` | `{code, deviceName, platform}` → `201 {deviceId, token}` |
| GET / DELETE | `/device` | Device info / unpair (revoke) |
| POST | `/sessions` | Header `Idempotency-Key` (required). Repeating a key returns the same session |
| GET | `/sessions/{id}` | Session with progress counts |
| POST | `/sessions/{id}/assets` | `{assets:[{sourceAssetId, filename, mediaType, size, capturedAt(ms)}]}` (max 500). Per-item result or error. Re-registering the same `sourceAssetId` returns the existing asset |
| HEAD | `/assets/{id}/content` | Headers `Upload-Offset`, `Upload-Length`, `Upload-State` |
| PUT | `/assets/{id}/content` | Raw bytes. Header `Upload-Offset` must equal the server offset, otherwise `409` with the correct `Upload-Offset`. Any chunk size; resume by sending the rest |
| GET | `/assets/{id}` | Asset state |
| POST | `/sessions/{id}/complete` | Closes the session and records last sync time |
| POST | `/assets/verify-delete` | `{assets:[{assetId, sha256}]}` → per item `safeToDelete` (true only if stored, the hash matches the PC copy, and the file exists on the PC) or a `reason` |
| POST | `/assets/{id}/deleted` | `{sha256}`. Call after deleting on the phone; re-verifies, then records `deviceDeletedAt`. `409` if not safe |

Registration accepts an optional `folderPath` (for example `DCIM/Camera`). The PC mirrors it as `<library>/Wi-Fi Sync/<Device>/DCIM/Camera/`, so phone folders appear as the same folders in the library tree. Without it, files go to `<YYYY>/<MM>`.

### Transfer, then delete from the phone

Compute the SHA-256 on the phone, call `verify-delete`, ask the user to approve, delete only the `safeToDelete` files, then call `/deleted`. The phone web page does this when the browser supports `showDirectoryPicker` (Chrome-based browsers; "Link a folder"). iOS Safari and many Android browsers lack it, so use a native client there. Files over 200 MB are skipped in the web page.

Asset states: `discovered → queued → uploading → stored → indexed`, plus `failed_retryable` (automatic exponential backoff, permanent after 6 tries; retry button in the desktop UI), `failed_permanent`, `cancelled`.

- `stored` = the file is safely in the library. `indexed` = it is also in the library index. If indexing fails the file stays stored and only indexing is retried.
- Content duplicates (same SHA-256) are not stored again; the asset is `indexed` with `duplicateOf` set.
- Videos are stored but not added to the photo index (the app indexes images only); they finish as `indexed` with `error: "video-not-indexed"`.

### Native client guidance

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

## Data and migrations

State is kept in `wifi-sync/wifi-sync.db` (SQLite via Node's built-in `node:sqlite`, which prints an experimental warning). Schema migrations use `PRAGMA user_version`; migration 1 creates `settings`, `pairing_codes`, `devices`, `sync_sessions`, `assets` and `idempotent_responses`. The existing JSON photo index is unchanged; imported images are added to it through `indexStore.addPhoto`.

## Tests

`npm run test:index` runs `tests/wifi-sync.test.cjs` (pairing, auth, revocation, upload, idempotency, duplicates, resume, restart recovery, invalid/oversize files, disk space, path traversal, TLS pinning, index regression).

## Back gesture

On the phone, the Android back button/swipe closes the top overlay first (viewer, selection, menu, This phone preview), then goes up one folder level, instead of leaving the app.


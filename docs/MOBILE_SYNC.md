# MiLeo Sync: mobile client (Milestone M2)

MiLeo Sync for Android is a native app that backs up a phone's photos and videos to a paired MiLeo Photo Library PC over the local network. It uses the M1 desktop sync API (`/api/v1`, see [WIFI_SYNC.md](./WIFI_SYNC.md)) without changing it.

| Platform | Status |
| --- | --- |
| Android 8.0+ (API 26+) | Implemented in [`mobile/android`](../mobile/android/README.md). Builds; JVM unit tests and real-server contract tests pass; smoke-tested end-to-end on an Android 11 emulator. Not yet tested on physical devices or OEM builds with aggressive battery management. |
| iOS | **Not implemented.** See [iOS follow-up](#ios-follow-up). |

## Why a native app

| Option | Background backup | Verdict |
| --- | --- | --- |
| Existing phone web app (PWA) | None: browsers cannot read the photo library in the background or resume uploads when closed. | Kept for browsing and manual uploads. |
| Cross-platform (Flutter / React Native) | Possible, but only through native plugins for MediaStore/WorkManager and PhotoKit/background `URLSession`. Adds a second toolchain. | Not chosen. |
| **Native: Kotlin + Jetpack Compose (Android first)** | Direct access to MediaStore, WorkManager, and foreground services. | **Chosen.** iOS will be native Swift later. |

The Electron desktop stack is not reused on the phone. It cannot run there, and reliable background sync depends on OS-specific APIs.

## Android architecture

```
ui/        MainActivity (Compose), SyncViewModel
android/   SyncWorker + SyncScheduler (WorkManager), MediaScanner (MediaStore), SyncPrefs (Keystore-encrypted token)
data/      Room queue database (mileo-sync-queue.db, table `queue`)
core/      Pure Kotlin, no Android APIs; covered by JVM tests:
           PairingLinks, PinnedHttp, SyncApi, QueuePlanner, UploadEngine, PairingFlow
```

### Pairing

1. The desktop shows a QR code with the link `https://<ip>:<port>/app#code=…&fp=<SHA-256 cert fingerprint>&v=1`.
2. The app reads the code with the Google Play services code scanner, which needs no CAMERA permission. You can also paste the link.
3. The app accepts only `https` links to private-LAN or loopback IPv4 addresses with a 64-hex fingerprint.
4. TLS trusts exactly that certificate (fingerprint pinning). No CA is involved, and the pin is re-checked for resumed sessions.
5. `POST /pairing/claim` returns a per-device token. The app encrypts it with an AndroidKeyStore AES-GCM key. The token is excluded from Android cloud backup and device transfer.

Other pairing behaviour:

- **Disconnect** revokes the token on the desktop when it can be reached, then forgets it locally. The phone keeps its upload history.
- If the desktop revokes the device, the next request returns 401. The app stops all background work and shows a "removed on the desktop" banner with a "Pair again" action.
- Re-pairing with the same desktop (same fingerprint) keeps completed history, so nothing is re-uploaded. Pairing with a different desktop resets the queue.

### Persistent upload queue

Each MediaStore item is a row keyed by `"<volume>:<_ID>"`. A scan updates the queue with `QueuePlanner.reconcile` as follows:

- New items become `pending`.
- Unsupported file types become `skipped`.
- Items whose size or modified date changed are re-queued as a new version.
- Items that are deselected or deleted become `skipped`. They are reactivated if they come back.
- `completed` items are never re-queued unless the file itself changes.

The server-side `sourceAssetId` is `android:<volume>:<_ID>:<size>:<dateModified>[:g<n>]`. This makes registration idempotent across retries, restarts, and re-pairing.

### Upload engine

`UploadEngine.run()` works through the items that are due, newest first. For each item it:

1. Computes the SHA-256 of the file.
2. Registers the asset with the expected hash.
3. Asks the server how many bytes it already has (`HEAD`).
4. Sends the rest in 8 MB chunks (`PUT` with `Upload-Offset`).

The server re-hashes the assembled file. A mismatch is reported as **failed** ("Desktop rejected the file"). An item is marked **completed** only after the server reports it stored or indexed, or as a duplicate of an existing library file.

Error handling:

- **Network loss:** the item stays `pending` and is retried with exponential backoff (30 s doubling, max 1 h). The next attempt resumes from the server's offset.
- **409, 429 and 5xx responses:** treated as transient. After 8 attempts the item becomes `failed`, and the user can retry it.
- **File changed while reading:** the upload restarts as a new version.
- **File deleted on the phone:** the item becomes `skipped`.

The app never deletes, moves, or modifies anything on the phone.

### Scheduling and rules

| Mode | How it runs |
| --- | --- |
| Sync now | A one-time WorkManager job. |
| Automatic backup | A 15-minute periodic job plus a MediaStore content-change trigger. |

- Rules apply as WorkManager constraints: **Wi-Fi only** (unmetered network, on by default) and **Only while charging**.
- **Pause** cancels scheduled work. **Resume** re-enables it.
- While uploading, the worker runs as a `dataSync` foreground service with a progress notification.

## Permissions and privacy

| Permission | Why |
| --- | --- |
| `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` (Android 13+), `READ_EXTERNAL_STORAGE` (12 and below) | Read only the selected media type. Partial "selected photos" access on Android 14+ is supported and explained in the app. |
| `ACCESS_MEDIA_LOCATION` | Only if the user turns on "Keep photo location". Otherwise Android removes GPS data and backups have no location. |
| `INTERNET`, `ACCESS_NETWORK_STATE` | Talk to the desktop on the LAN and apply the Wi-Fi rule. |
| `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC` | Show upload progress while a backup runs. |

There is no CAMERA permission, no analytics, and no Internet endpoint. Files go only to the paired desktop over pinned TLS.

## Background limits (what we do not promise)

Android decides when background work runs. MiLeo Sync does **not** promise continuous or instant backup.

- Periodic work runs at most every 15 minutes, and later under Doze, App Standby buckets, or battery saver.
- Some OEM builds (Xiaomi, Huawei, Samsung, and others) may kill or delay background work unless the user exempts the app.
- Android 12+ restricts starting foreground services from the background. If that is refused, the worker continues without the notification, and the OS may stop it sooner.
- Android 15 limits `dataSync` foreground services to about 6 hours per day. Work that is interrupted resumes on the next run without re-sending data.
- If the desktop is off or unreachable, the job returns "retry" and WorkManager reschedules it.

## Known limitations

- **No duplicate check before upload.** The M1 API deduplicates after the bytes arrive. The local queue prevents re-uploads from the same phone, but a file that already exists on the desktop (for example, copied there manually) is sent once and then reported as "already on desktop". No duplicate library asset is created.
- **Desktop IP changes.** If the desktop's LAN IP changes, the user must scan a new QR code. Re-pairing with the same desktop keeps history.
- **QR scanning requires Google Play services.** On other devices, paste the link instead.
- **Test coverage.** Not yet tested on physical devices. Only debug builds exist; release signing is not configured.
- **iOS** is not implemented.

## iOS follow-up

Planned as a separate native Swift/SwiftUI app with the same queue semantics:

- **Enumeration.** Use PhotoKit with `PHAsset.localIdentifier` (plus modification date) as `sourceAssetId`. Support limited-library access (`PHAuthorizationStatus.limited`, `presentLimitedLibraryPicker`).
- **Upload.** Export the asset's original resource with `PHAssetResourceManager` to a temporary file. Upload with a **background `URLSession`**, which continues after the app is suspended. Pin the fingerprint in `urlSession(_:didReceive:completionHandler:)`.
- **Scheduling.** Use `BGAppRefreshTask` / `BGProcessingTask` (with `requiresExternalPower` for the charging rule). iOS decides when these run and may not run them for days. Opening the app triggers a sync. There is no equivalent of Android's content-change trigger.
- **Credentials.** Store the device token in the Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).
- **Build requirements.** Requires macOS with Xcode. It cannot be built on the current Windows development machine.

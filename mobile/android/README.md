# MiLeo Sync for Android

A native Android client (Kotlin, Jetpack Compose, WorkManager, Room) that backs up photos and videos to a paired MiLeo Photo Library desktop. For architecture, permissions, and limits, see [docs/MOBILE_SYNC.md](../../docs/MOBILE_SYNC.md).

## Requirements

- JDK 17+ (`JAVA_HOME`).
- Android SDK (`ANDROID_HOME` or `local.properties` with `sdk.dir=...`). The Android Gradle Plugin downloads missing platform and build tools.
- The Gradle wrapper is included (Gradle 8.9). Android Studio is optional.

## Build and install

```powershell
cd mobile\android
.\gradlew.bat :app:assembleDebug        # app\build\outputs\apk\debug\app-debug.apk
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

On the PC: **MiLeo → Wi-Fi Sync → turn on → Pair a phone**. Then scan the QR code in the app.

## Tests

```powershell
.\gradlew.bat :app:testDebugUnitTest     # JVM unit tests; contract tests are skipped
.\gradlew.bat :app:lintDebug
```

### Contract tests against the real desktop server

[`tools/contract-server.cjs`](tools/contract-server.cjs) starts the actual M1 sync service from `electron/wifi-sync` with TLS. It uses a temporary library and database on 127.0.0.1 and has a small control API. Run it from the repository root after `npm install`:

```powershell
node mobile\android\tools\contract-server.cjs          # prints CONTROL_URL=http://127.0.0.1:<port>
# in another terminal
cd mobile\android
$env:MILEO_CONTRACT_URL='http://127.0.0.1:<port>'; .\gradlew.bat :app:testDebugUnitTest
# stop the server
Invoke-RestMethod -Method Post http://127.0.0.1:<port>/shutdown
```

`DesktopContractTest` covers these scenarios:

- Two devices pairing.
- Photo and video upload.
- Network interruption mid-upload with resume.
- Duplicate and repeat uploads (no new library asset).
- Desktop restart and outage.
- Invalid and revoked credentials.
- Wrong certificate and reused pairing codes.
- Corrupted content (fails SHA-256 verification).
- Malformed and unsupported filenames.

## Emulator testing

The Android emulator reaches the PC's loopback through `10.0.2.2`, which the app accepts as a private address.

1. Start the contract server.
2. Get a link with `Invoke-RestMethod -Method Post <CONTROL_URL>/pair`.
3. Replace `127.0.0.1` with `10.0.2.2` and paste the link into the app.

## Data

- **Queue:** `mileo-sync-queue.db` (Room, schema exported to [`app/schemas`](app/schemas)). A future schema change must add a Room `Migration` and keep the exported JSON.
- **Settings and pairing:** SharedPreferences `mileo_sync`. The device token is encrypted with the AndroidKeyStore key `mileo_device_token`.
- **Backups:** Android backup and device-to-device transfer are disabled for the app's data.

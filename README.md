# MiLeo Photo Library

*Your memories. Your library. Your world.*

A personal photo browser built with HTML, CSS, and vanilla JavaScript. It can run as a static browser app or as a Windows Electron desktop app. Both modes read selected photos and videos without changing originals; the core app has no backend, database server, cloud integration or AI classification (the optional account server and Wi-Fi sync are described below). Videos (MP4, M4V, MOV, WebM, MKV, OGV, AVI, 3GP) are indexed alongside photos and play in the viewer with the built-in player; playback depends on the codec, so some HEVC/H.265 or AVI files may not play.

For the Windows desktop build and usage instructions, see the [Vietnamese guide](VI_README.md). Electron stores registered folder paths and versioned JSON indexes in its per-user `userData` directory. The desktop app remembers accessible folders between launches and uses native dialogs for folder selection and index backup/restore. Build with `npm install`, `npm start`, and `npm run dist:win` from this directory. The generated installer is unsigned unless you configure code signing.

## Branding (MiLeo)

The product is **MiLeo Photo Library** (short name **MiLeo**), named after Mike (Minh Khang) and Leo (Quang Đăng). Its tagline is *"Your memories. Your library. Your world."* The phone companion and Wi-Fi sync are **MiLeo Sync**; **MiLeo AI** is reserved for future AI-powered features. There are no AI features in this version.

These values are defaults. An administrator can change them in **Admin dashboard → Branding**: application name, short name, slogan, mobile sync name, AI features name, website URL (http/https only, shown as a sidebar link that opens in the system browser), and logo (PNG, JPEG or WebP, up to 512 KB). Changes apply immediately to the desktop window and to phones the next time they load the page. **Reset to defaults** restores MiLeo. Settings are stored in `branding.json` inside the app's `userData` folder. Changes are recorded in the activity log.

Runtime branding cannot rename installed files. The executable, installer, Start Menu shortcut and phone Home Screen icons keep the names they were built or installed with. Packaging names are set in `package.json`.

For compatibility, some internal identifiers keep the old "Still" name. These include the Windows app ID `com.still.photolibrary`, the `%APPDATA%\Still Photo Library` data folder, the `still-photo-library-index` JSON format, the `still-media` protocol, `still.db` and `still-*` storage keys. Existing libraries, accounts and pairings therefore carry over after the upgrade.

## MiLeo Sync: Wi-Fi photo sync (desktop app)

The desktop app can optionally receive photos from a phone over the local network (HTTPS, QR pairing, per-device revocation, resumable uploads). It is off until you press **Start sync server** in the sidebar's **Wi-Fi Sync** panel. The same server also hosts a **mobile web app**: scan the pairing QR code with the phone camera to browse, search, play and favorite the PC's library live (see "Phone web app" in the doc below). See [docs/WIFI_SYNC.md](docs/WIFI_SYNC.md) for setup, security model and the API.

## Backup, integrity and recovery (desktop)

Use **Admin dashboard > Backup & recovery** for verified metadata snapshots,
optional original-media copies, read-only integrity checks and restart-based
restore. Originals are never overwritten by recovery; restored credentials
are invalidated. Backups must use a separate, trusted local destination.
See [Backup and recovery procedures](docs/BACKUP_RECOVERY.md) for safety,
limitations and the tested restore procedure.

## Family devices and shared albums (desktop)

Use **Admin dashboard > Family & sharing** to associate local accounts with
profiles and paired devices, grant read-only album access, and set per-device
upload policies. Family mode is opt-in and off by default for compatibility;
when enabled, unassigned devices cannot upload or browse. Existing Desktop
navigation and local albums are unchanged.
See [Family sharing, external storage and VPN architecture](docs/FAMILY_SHARING.md)
for setup, access rules, migration/rollback and deployment limitations.

## Open

Open [index.html](index.html) directly in a current desktop browser. Click **Open folder** and choose `D:\Image`, or a smaller collection to start. The adjacent folder icon always offers the directory-file-input fallback. Files are never scanned automatically. After reload, reselect the folder and import the JSON index backup to restore annotations.

If `file://` folder access or storage behaves inconsistently, optionally serve **this application folder only**, not the photo archive, using an existing static-file server. For example, with Python already installed:

```powershell
py -m http.server 8080 --bind 127.0.0.1 --directory D:\Image\photo-library
```

Then open `http://localhost:8080`. This is optional static-file hosting, not an application backend. Photos still come from the explicit browser folder selection, not HTTP URLs. Stop the server with Ctrl+C. No server was needed for the tested direct-file workflow.

## Actual Workspace Inspection

Read-only filesystem inventory on 2026-10-25, before adding this prototype:

- The workspace is the real photo/video archive, not an existing application repository.
- 17,515 files total; 11,217 image candidates by extension.
- 6,781 HEIC, 4,003 JPEG (4,002 `.jpg` and one `.jpeg`), 433 PNG; extensions counted case-insensitively.
- Also 5,168 MOV, 525 MP4, 575 AAE edit sidecars, 25 extensionless files, two ZIP archives, and one each LNK, rescache, and TMP.
- No directory access failures were reported by the filesystem scan. These are extension counts, not proof that every file is decodable or unique.

| Collection | Image Candidates | Observed Organization |
| --- | ---: | --- |
| Iphone | 7,987 | 106APPLE through 114APPLE; 2021 through 2025; nested month/export folders |
| Bphone | 2,550 | 2021/img, 2021/video, new/video, old |
| Mũi né - phan thiết - 24122024 | 249 | Travel/event folder; JPG exports and extensionless files |
| Thôi Nôi Đăng | 215 | Event collection; timestamp-prefixed JPEG names |
| Gialai | 133 | Place-named collection; hashed JPEG names |
| Trung Thu 2024- Casa Vạn Phúc | 46 | Nested exported folder with encoding artifacts and a __MACOSX sidecar tree |
| Khang tốt nghiệp | 18 | Graduation-named event collection |
| daily | 6 | Numeric and exported JPEG names |
| thanhthanh | 5 | HEIC examples with sequential iPhone filenames |
| Sao Vui | 4 | Social-export-style JPEG names |
| Samsung | 2 | Cần giờ camping subfolder |
| Archive root | 2 | khang.jpg and a z-prefixed JPEG |

Representative paths include `Bphone/2021/img/IMG_20211122_110652.jpg`, `Iphone/106APPLE/IMG_6003.HEIC`, `Iphone/2021/2021__03/IMG_5181.PNG`, and `Thôi Nôi Đăng/20211023173148_IMG_8305.jpg`. Month folders include `2021__03`, `202202__`, and `202301_a`; suffixes like `_a` and `_b` are preserved rather than interpreted.

The first sampled extensionless file began `00 00 00 1C 66 74 79 70 6D 70 34 32`, consistent with an MP4 container. This does not establish the format of the other 24 files. Extensionless files are deliberately skipped, not renamed or guessed to be images. AAE sidecars, videos, shortcuts, ZIP archives, `._` files, and `__MACOSX` contents are not gallery photos. Archives are not extracted; shortcuts are not followed.

### Categories and Dates

The sidebar preserves the actual granted hierarchy. Phone sources, year/month exports, and named events are useful categories because those are existing organizational boundaries. Folder segments are offered as tag suggestions in the details panel. No categories are hard-coded into the application, and no people or subjects are inferred from image contents.

Folder names may suggest travel, a graduation, camping, a family milestone, or Mid-Autumn festivities, but those are folder-name interpretations, not verified image labels. In particular, the travel folder's `24122024` suffix conflicts with sampled file modification dates in December 2023. The application does not treat it as a capture date.

## Folder Access and Compatibility

| Mechanism | Behavior |
| --- | --- |
| File System Access API | Preferred when `showDirectoryPicker` is available in a secure context, normally Chrome/Edge desktop. Explicit read-only permission. Traverses directory handles and keeps handles in memory; file metadata and bytes are read only when needed. Includes empty directories. |
| `input webkitdirectory` | Fallback in current supporting desktop Chrome, Edge, Firefox, and Safari versions. Browser enumerates selected files and supplies `webkitRelativePath`. No retained directory permission. Reconstructs folders represented in the file list; genuinely empty directories cannot be recovered. |

Browser/OS versions differ, especially on mobile. The browser may block protected directories or embedded-page pickers. The application reports picker failures and offers the input fallback; unsupported browsers receive a compatibility message. Input enumeration can take time before JavaScript receives the file list, so progress during that browser-owned step is unavailable. JavaScript indexing shows progress after access is provided.

File handles and access grants are not persisted or assumed to survive a reload. Reopen the same root and import its JSON index to restore tags, albums, favorites, and first-indexed times. Selecting a different nesting level changes relative identities. Browser root names are not full disk paths: two unrelated roots with the same name and matching relative paths can share annotations. Use distinct root names or separate browser profiles for those libraries; the app does not rename folders.

### Image Support

Recognized extensions: JPG, JPEG, PNG, GIF, WebP, AVIF, BMP, HEIC, HEIF, TIF, TIFF, DNG. The Windows desktop app decodes HEIC/HEIF locally to an in-memory JPEG preview because Chromium does not consistently support those formats. The source photo is never converted or modified, and photo bytes are not sent anywhere. TIFF/RAW support remains browser-dependent. In a regular browser, HEIC/HEIF preview still depends on browser support.

HEIC preview uses `heic-convert` (ISC) and `libheif-js` (LGPL-3.0); their license files are included in the packaged application.

The viewer cannot recover data from removed, inaccessible, corrupt, or unsupported files. Failed thumbnails show a neutral "No preview available" placeholder, never a substitute photo. Regrant access if necessary. Unicode and already-garbled export names are preserved exactly.

## Browsing

Use **Install on Phone** in the top bar to open the existing Wi-Fi companion with a QR code or copyable pairing URL, and see Android/iPhone installation instructions. This reuses the Desktop LAN server; full PWA installation/offline-shell support depends on browser support and trusting its self-signed certificate. See [Wi-Fi setup and installation](docs/WIFI_SYNC.md#install-on-phone).

Click a folder name or its open button to browse it without changing its pin status or position. Folder navigation never automatically pins folders. Use the folder's right-click menu to pin or unpin it explicitly.

- Photos: responsive paginated grid; optional filename overlays, hover/focus filenames, and favorite buttons.
- Folders: expandable, lazily built tree with inclusive descendant image counts. Choosing a folder includes its descendants. Zero-count directories are retained when the browser exposes them.
- Search: filename, folder, relative path, and user tags; case-insensitive, with combining accent marks folded. Multiple search words must all match.
- Filters: folder and extension. Sorting: filename, validated filename-derived date, filesystem modification time, or first indexed. Unknown dates sort last.
- Timeline: calendar-validated `YYYYMMDD` filename prefixes, optionally after `IMG_`, `VID_`, or `PXL_`, grouped by month. These dates are explicitly **unverified filename dates**, not EXIF capture dates. Sequential names like `IMG_6003` stay in Unknown date. Year/month folders do not establish a date for individual photos.
- Favorites, Tags, Albums: logical memberships; a photo can have multiple tags and albums without copying or moving it. Edit comma-separated memberships and update the in-memory index in the viewer. Export or save the JSON index to keep changes across reloads. Folder-name suggestion buttons add tags to the editor.
- Recently Added: first indexed timestamp stored in the JSON index, not filesystem creation time or camera capture time. Newly scanned files receive near-identical first-indexed times.

No EXIF parser is included. Browser `File` objects expose byte size and modification time, not an authoritative original capture timestamp. Index `dateTaken` is null unless an imported index supplies a validated date. Modification dates are never called capture dates. With directory handles, choosing modification sorting triggers a cancellable, eight-at-a-time metadata read; it does not read the image contents. Dimensions become available when a preview or viewer image is decoded.

## Persistent JSON Index

The application keeps a versioned index in memory and never embeds photo bytes. Its top-level structure is:

```json
{
	"format": "still-photo-library-index",
	"version": 1,
	"root": "Image",
	"createdAt": "ISO-8601 timestamp",
	"updatedAt": "ISO-8601 timestamp",
	"albums": [{ "id": "stable-id", "name": "Album name" }],
	"entries": []
}
```

Each entry records a normalized path-based `id`, relative `path`, `name`, parent `folder`, lowercase `extension`, `size`, millisecond `lastModified`, `dateTaken` (null without EXIF parsing), user `metadata` (`tags`, `favorite`, and `albumIds`), `contentHash` (null, reserved for a future feature), `firstIndexedAt`, `missing`, and `missingSince`. Paths use `/` separators and Unicode NFC normalization; case is preserved. Content hashes are not calculated.

### Backup and Restore

- **Export JSON** downloads the current index. The downloaded file is the portable backup. It contains paths, file metadata, annotations, and album definitions, not images or file handles.
- **Save index JSON** uses `showSaveFilePicker` when available and explicitly invoked. If unsupported or unavailable, it falls back to downloading the JSON.
- **Import JSON** validates the format, version, paths, records, metadata, and album references before changing the current index. Imports over 100 MB and indexes over 500,000 entries are rejected. Unsupported versions or malformed data leave the existing index unchanged.
- To restore, import the backup, then explicitly open the matching folder and grant read permission again. If a folder is already active, its root name must match the imported index. A reload does not restore directory permissions.
- After a scan, the UI reports added, updated, unchanged, missing, and access-error counts. A change in path, size, or modification time updates file metadata without replacing tags, favorite status, album IDs, or imported `dateTaken` values. Index IDs are normalized relative paths. The `contentHash` field is reserved for possible future move detection; no hashes are read or computed now.
- Missing entries are retained. Only paths in accessible portions of a scan can be marked missing. Entries under folders that failed access are protected from being newly marked missing, and already-missing entries under those folders are withheld from the review/removal list until that folder is accessible again. **Review missing** lists remaining paths separately; **Keep entries in index** leaves them untouched, while the explicit remove button removes only those listed entries from the in-memory JSON index. No original file is changed or removed.
- LocalStorage is reserved for small UI preferences (sort order and filename-overlay choice). The index and annotation edits remain in memory until exported/saved; unexported changes are lost on reload. Earlier app versions stored annotations under `still-library-v1:<root>`; on scanning that same root the app migrates those annotations into the JSON index and removes the migrated legacy key.
- Exporting/saving an index is always local. The app does not upload index data or photos.

## Viewer and Dependencies

PhotoSwipe **5.4.4**, MIT license, is loaded on demand from these pinned URLs:

- `https://cdn.jsdelivr.net/npm/photoswipe@5.4.4/dist/umd/photoswipe.umd.min.js`
- `https://cdn.jsdelivr.net/npm/photoswipe@5.4.4/dist/photoswipe.css`

Source and license: https://github.com/dimsemenov/PhotoSwipe/tree/v5.4.4

It needs internet access unless cached. The built-in dialog displays the image while PhotoSwipe loads and remains usable if script/CSS loading fails or times out. PhotoSwipe provides zoom/pan and touch gestures; navigation follows the entire currently filtered list, including other pages. Details remain visible beside the image on desktop and below it on mobile. Escape closes the viewer. Inputs retain arrow-key editing. The fallback supports previous/next buttons, left/right arrows, Escape, zoom buttons, double-click zoom, drag pan when zoomed, and one-finger swipe navigation at fit size. Pinch-to-zoom is provided by PhotoSwipe, not the fallback. Native dialog semantics provide modal focus containment and a labeled close control.

Lucide **0.468.0**, ISC license, is vendored as [lucide.min.js](lucide.min.js) for offline tool icons. Original distribution and embedded license notice are retained. Source/license: https://github.com/lucide-icons/lucide/tree/0.468.0

DM Sans and Manrope fonts use Google Fonts when online and fall back to local sans-serif fonts. CDN/font requests disclose ordinary connection metadata to those providers, but **no image bytes, image URLs, filenames, or tags are sent to them**. The application has no upload or analytics endpoint. Object URLs reference browser-local blobs only. For a network-free session, block external requests; the built-in viewer and local icons still work. Third-party scripts execute with page privileges, as with any CDN dependency; self-host reviewed PhotoSwipe assets if that trust model is unsuitable.

## Performance and Safety

- At most 72 photo cards in the DOM, regardless of library size. Page navigation replaces the page instead of accumulating cards.
- The JSON index contains metadata only. localStorage is not used as a per-photo database; users choose when to export/save the index.
- IntersectionObserver defers preview work until near the viewport. At most three thumbnail jobs run concurrently; queued jobs that leave the viewport or belong to an old grid are dropped, and the scheduler yields between batches so input and scrolling can run.
- HEIC conversion runs serially in a reusable worker thread, not Electron's main event loop, with a 60-second conversion timeout. Thumbnail decoding/resizing uses asynchronous ImageBitmap APIs where available, releases bitmap memory after use, and draws only the resized image on the UI thread; older browsers retain the image-element fallback.
- Only visible/near-visible photos are decoded into transient canvases. Cached page thumbnails have a maximum 480px edge; original preview URLs are immediately revoked after thumbnail creation. Thumbnail URLs are revoked on page/filter/root changes and page exit.
- There are no existing dedicated thumbnails in the inspected layout. Generating the first preview therefore requires decoding that local original; a resized source cannot be obtained without reading it. The app does not eagerly read every full-resolution image. No hashes or image-content classification are calculated.
- Viewer originals load on demand, with no preloading of the entire collection. URLs are released when slides are destroyed, the viewer closes, access is replaced, or the page exits. PhotoSwipe may retain a small adjacent-slide buffer.
- File metadata is O(n); filtering is O(n); sorting is O(n log n). Search is debounced by 180ms. Indexing yields periodically. The model still retains all entries, and sorting runs on the main thread: this is not a promise of instant 100,000-image operations on every device.
- IDs use complete root-relative paths, not basenames; identical names in different folders remain separate. Renaming/moving a file externally changes its annotation identity. The application itself has no rename, write, move, delete, extraction, or conversion operations.
- localStorage holds only small display/sort preferences. Exported JSON backups are portable between browsers and computers; keep them somewhere safe because the app does not synchronize them. `file://` preference storage behavior is implementation-dependent; switching to localhost creates a different origin. Browser privacy settings or clearing site data can reset preferences. Annotations are in-memory until the index is exported or saved.

## Validation Performed

Tested in the VS Code integrated Chromium browser, opening the application directly from disk:

- Page initialization, offline local scripts, and desktop/mobile layouts.
- Actual JPEG samples `daily/1.jpg`, `daily/2.jpg`, and `Bphone/2021/img/IMG_20211122_110652.jpg`; PNG sample `Iphone/2021/2021__03/IMG_5181.PNG`; HEIC sample `Iphone/106APPLE/IMG_6003.HEIC`.
- Actual JPEG/PNG decoding and resized previews; HEIC remains browser-dependent.
- Recursive directory-handle traversal using an in-memory File System Access-compatible handle tree backed by four actual selected JPEG/PNG files. Confirmed nested paths, folder counts, deep-folder filtering, thumbnails, and full-size viewer decoding through the handle-based read path. This exercises traversal and on-demand `getFile()`, but does not grant or test an OS/browser directory permission.
- Nested path preservation and folder-tree selection, folder/format filtering, filename/path/tag search, tag saving, logical albums, favorites, filename-date/unknown-date grouping, and modification-time ordering.
- PhotoSwipe CDN loading, image navigation within the filtered list, changing details, Escape, and containment beside/below details.
- CDN requests deliberately blocked: fallback zoom, arrow navigation, and Escape still worked.
- 390×844 mobile viewport: two-column grid, sidebar toggle, no horizontal document overflow; image stage and details stack without overlap. Desktop layouts were checked at 1140px and 1440px widths. A screenshot caught PhotoSwipe using the full-window viewport inside its smaller stage; `getViewportSizeFn` now uses stage dimensions. Subsequent decoded-image bounds checks confirmed fit within both the 390×485 mobile stage and 1140×896 desktop stage.
- Synthetic 10,000-entry fixture made from one real sample's bytes, with virtual test paths, not 10,000 claimed real imported photographs: 72 DOM cards, 139 pages, working second-page navigation, and distinct IDs/search for duplicate basenames in separate folders. No fixture copies were written to disk.
- JSON schema round-trip, metadata preservation after scan, inaccessible-path protection, missing-file review, explicit missing-entry removal, and unsupported-version rejection using browser-driven fixtures.
- JSON export control serialized a real sample index with path, size, modification timestamp, `dateTaken: null`, tags, favorite state, and album ID. Import restored annotations; version 99 was rejected without replacing the active index.
- Preference storage was checked separately from index data. No photo bytes or per-photo metadata were stored in localStorage.

The integrated browser's automated directory upload timed out both through `setInputFiles(directory)` and its file chooser. Clicking the native `showDirectoryPicker` button exposed no controllable OS dialog in this browser tool. Real files could be supplied individually; for nested-path input tests, the harness assigned their **actual** root-relative paths before dispatching the normal input change event. For the File System Access traversal test, the harness provided an in-memory handle tree backed by actual selected file bytes. Thus input indexing, real decoding, folder-tree behavior, and handle traversal were exercised, but a successful native directory permission dialog/grant was **not** verified end to end. The filesystem inventory itself was independently accessible and completed without access errors.

Not yet verified: a complete browser import of all 11,217 images; 100,000 real-image load; Safari/Firefox/native mobile browsers; physical multi-touch/pinch gestures; OS permission revocation; native Save File Picker behavior; and every corrupt-file variant. Treat the 10,000-entry result as a bounded model/DOM check, not a full archive benchmark.

The workspace's JavaScript diagnostic provider reports `Unexpected ES6 feature` for arrow functions and other legacy-style warnings. This task intentionally uses modern ES6+ syntax; the loaded application was validated by executing it in the browser, not by downgrading to that checker's older language mode. HTML and CSS checks reported no errors.

### Repeatable Manual Check

1. Open the page, connect `daily`, and confirm six JPEG photos without modifying originals.
2. Reconnect the archive root; expand Bphone → 2021 → img and check counts/search against the filesystem.
3. Filter PNG, then HEIC. Expect PNG previews. In the Windows desktop app, HEIC/HEIF files should also preview; the original files remain unchanged.
4. Compare Filename date and Modified sorts. Timeline must retain Unknown date and never claim capture dates.
5. Open a JPEG, navigate with arrows, zoom/pan, add two tags and two albums, save, favorite, and close with Escape. Check the corresponding logical views and tag search.
6. Export the JSON index, reload, reconnect the same root, import the backup, and confirm tags/favorites/albums are restored. The page asks for folder access again after reload.
7. Block external network access and repeat viewer navigation/zoom using the fallback. Check at desktop and narrow mobile widths.

## Files

- [index.html](index.html): accessible application shell and offline dialog.
- [styles.css](styles.css): responsive layout, grid, folder tree, and viewer styling.
- [app.js](app.js): access/indexing, model, filters, thumbnails, annotations, and viewer integration.
- [index-store.js](index-store.js): versioned schema, validation, normalization, and incremental reconciliation, separated from rendering.
- [lucide.min.js](lucide.min.js): pinned, unmodified third-party icon distribution.
- [README.md](README.md): actual inventory, setup, design decisions, dependencies, and validation limitations.

Only this `photo-library` directory was added. Original archive files were not renamed, moved, modified, or deleted.
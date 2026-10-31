# MiLeo Backup, Integrity and Recovery (M4)

Desktop only. Open **Admin dashboard > Backup & recovery**. These operations
use the existing JSON library indexes, Node SQLite databases, scanner,
reconciliation and thumbnail pipeline. No database or index schema is changed.

With M5 installed, the same sync snapshot also contains family profiles, device
ownership/policies and album grants. Verified schema-4 (M4) and schema-5 backups
are accepted; older snapshots migrate on normal startup. Restore clears family
sign-ins, revokes every device and disables receiving, while retaining restored
family grants and policies. Re-pair phones and assign the new device registrations.
See [M5 migration and rollback](FAMILY_SHARING.md#persistence-migration-and-rollback).

## Before starting

1. Finish any library scan and save annotations. The dashboard flushes pending
   renderer index saves before backup or recovery.
2. Pause receiving in **Upload queue**. Wait for in-flight uploads to finish.
   Backup snapshots and index recovery refuse to run while the LAN server is
   receiving. Restart receiving yourself afterwards.
3. Choose an existing backup destination outside application data and every
   registered library. Overlapping parents, nested folders and linked paths
   are rejected. A separate physical disk is strongly recommended; separate
   folders on one disk do not protect against disk failure.
4. Protect that destination with filesystem permissions and preferably
   BitLocker or equivalent disk encryption. M4 backup folders are **not
   encrypted**. They contain private filenames, annotations, account password
   hashes and chat records. Only open backups you trust: checksums detect
   damage, not malicious replacement of both data and manifest.

## Create and verify a backup

Choose **Create verified backup**:

- By default, copies library registration, versioned JSON indexes (including
  albums, annotations and known hashes), per-account browsing UI state,
  branding including its embedded logo, and consistent SQLite snapshots of
  the sync and embedded account databases.
- Select **Also copy original photos, videos and supported documents** to
  include the files discovered by the existing library scanner. This includes
  supported files not yet indexed. This is not a full-disk backup: unsupported
  files and external sidecars such as AAE files are not included.
- Original-media backup fails rather than publishing a verified backup if a
  non-missing indexed original is absent, a scan is incomplete, a known hash
  mismatches, a source changes during copying, or an I/O operation fails.
  Records already marked missing remain represented in the metadata.
- Caches, partial uploads, login tokens, saved passwords, TLS private keys,
  JWT signing secrets and administrator credentials are not exported.
  The existing local administrator credentials are preserved during restore.

Library writers are briefly gated while metadata is captured. SQLite uses
`VACUUM INTO`, not a copy of live database/WAL files. Snapshots and JSON
capture are synchronous inside the drained writer gate, so application
callbacks cannot interleave their writes. Copying originals is streamed by
the filesystem and does not hold the library writer gate; changes by other
applications are checked and can cause a failed backup.

Each file gets a SHA-256 entry in `manifest.json`; databases also pass SQLite
integrity and foreign-key checks. Only after verification is the unique
`.mileo-<id>.partial` folder renamed to `mileo-<id>`. There is no overwrite of
an earlier backup. **Verify** re-reads all listed files and checks them again.
Never open a backup database with tools that might modify it.

The history shows persisted state, progress, errors and a per-job **Report**.
After a crash, unfinished jobs are marked **interrupted**, not successful.
Their partial folders are retained for investigation but are not restore
points. Run another backup. There is no automatic backup retention, cleanup,
scheduling or interrupted-copy resume in M4.

## Check storage integrity

**Check library integrity** does not write indexes or originals:

| Result | Meaning |
|---|---|
| `verified` | File exists and its SHA-256 matches the stored baseline. |
| `mismatch` | Its hash differs. Preserve the file and investigate. |
| `missing` | The referenced file or root could not be found. |
| `unreadable` / `unreadable_index` | Access, path, or metadata error; not proof of corruption. |
| `no_hash` | No previous hash exists. Existence was checked, but content is not verified. |
| `size_mismatch` | No hash exists and file size differs from the index. |
| `conflicting_hashes` | Library and sync records disagree about the baseline. |
| `changed_during_check` | File changed while being checked; retry when it is stable. |

Stored-but-unindexed sync assets are included. Missing roots and unreadable
indexes are explicitly reported. Integrity checks never silently establish a
new hash baseline or delete files. A metadata-only backup verifies metadata,
not the current health of original media.

## Restore a verified backup

1. Select the completed backup's **Restore metadata**, or **Open existing
   backup** and select its `mileo-<id>` directory if local history was lost.
   Opening re-verifies it and registers a new local history entry.
2. Optionally select **Restore + missing originals**. This requires a backup
   containing originals and the same registered library IDs/paths. On a
   replacement installation, register those folders before staging original
   recovery. Cross-machine root remapping is not implemented.
3. Read and accept the native confirmation. Verification and staging happen
   first; live databases are not replaced while the app is running.
4. When the job is **awaiting_restart**, select **Restart and restore**.
5. Before servers, authentication and library UI start, MiLeo verifies the
   staged files again, saves current allowlisted metadata and database
   sidecars in `recovery/rollback-<restore-job-id>`, and installs staged
   metadata with per-file temporary files and atomic replacement.
6. Original recovery creates missing files only. Existing identical files are
   `already_present`; different existing files are `conflict`. Neither is
   overwritten. Newly recovered originals are retained even if later metadata
   recovery must roll back.
7. All restored device credentials and account refresh tokens are revoked,
   the account signing secret is rotated, saved login credentials are retired
   into rollback storage, and the desktop starts signed out. Sign in again,
   enable receiving and pair each phone again. LAN sync stays disabled until
   explicitly enabled.
8. Review the restore report, then run integrity and index reconciliation.

Backup settings and job reports live separately under `userData/recovery/`
as versioned, atomically written JSON. They are **not** rolled back with the
library databases. No schema migration is necessary. M4 does not modify or
remove existing legacy index backups.

### Interrupted or failed restore

Restore intent and each metadata replacement are journaled. If startup sees
an interrupted replacement, it restores the prior metadata from rollback
storage before starting services and marks the restore failed. A restart
during rollback retries rollback. If rollback cannot finish, startup stops
with an error instead of using a partially restored database.

Keep the backup, staged folder, rollback directory and job report. Resolve
disk/access errors, restart to finish rollback, then stage the verified backup
again. Do not copy a live SQLite `.db` over an open database, mix its old WAL
with a new database, or manually delete original media to resolve conflicts.
Completed restore rollback directories are retained; they are not automatic
future restore points. Create a fresh verified backup before further changes.

## Reconcile indexes and rebuild thumbnails

**Reconcile and rebuild** uses the existing scanner and `indexStore.reconcile`.
It first records integrity findings, copies each previous index into the
existing `photo-library/backups` folder, adds newly discovered supported
files, preserves annotations and missing-file records, and respects
inaccessible paths. Recovery retains known hash baselines rather than
silently accepting altered content.

If an index is unreadable, its original bytes are retained and the report
states that unreadable annotations cannot be merged. Rebuilding that index
requires a complete scan. Restore a verified metadata backup instead when
you need to recover those annotations.

The derived phone thumbnail directory is renamed to
`recovery/retired-thumbnails-<id>`. A cache overlapping a registered original
library is never retired. The window reloads after index recovery
(with an explicit error if it failed) to clear desktop in-memory previews and
stale index state, including any completed per-library changes.
The existing renderer and phone API regenerate thumbnails on demand as media
is viewed; M4 does not pre-generate every thumbnail or add another indexer.
Originals are never deleted or overwritten by reconciliation.

## Compatibility and operational limits

- M4 targets the default embedded account database and local signing secret.
  `DB_PATH`, `STILL_API_URL` or `JWT_SECRET` overrides are refused for snapshots
  and pending startup restore; external account services need their own backup
  procedures. Stop the app and remove these overrides before local recovery.
- Original storage must have enough space for recovered files; backup storage
  must fit a complete snapshot. I/O and disk-full errors fail the job; partial
  and rollback data are retained, not silently discarded.
- Backups are explicit manual snapshots, not a continuous filesystem
  snapshot. Do not modify originals while copying or verifying them.
- Machine-bound TLS/private credentials are deliberately not portable. A
  replacement installation creates new credentials and needs fresh pairing.

## Tested recovery procedures

Run `node --test tests\backup.test.cjs tests\library-api.test.cjs` from the
repository root. These tests use isolated temporary directories and real
SQLite databases, never the user's library. They exercise verified
metadata/original backup, WAL-aware snapshots, re-verification, opening
existing backups, restore on simulated application restart, credential
invalidation, missing-only media recovery, preserving conflicting originals,
interrupted-job history, rollback after an interrupted metadata replacement,
checksum/SQLite corruption, unsafe paths and junctions, index reconciliation,
and regeneration through the existing thumbnail API after cache retirement.

These are automated filesystem/backend/API tests. They do not simulate
physical disk failure or power-loss durability, or establish that a packaged
Electron restart was exercised.

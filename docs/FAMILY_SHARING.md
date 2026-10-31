# MiLeo Hybrid Family Experience (M5)

Desktop remains authoritative. This milestone extends the existing sync server,
account directory, JSON albums and Admin dashboard; it does not create another
library, cloud service, mobile client or storage engine.

## Set up family access

1. Make a verified backup in **Admin > Backup & recovery** before upgrading.
2. In **User management**, create a local password account for each member.
   Never share the Desktop account password. A contributor needs an **editor**
   or **admin** account; an account with the existing **viewer** role cannot sync.
3. In **Family & sharing**, create a profile linked to that account:
   - **Read-only:** can browse/download granted albums, but cannot upload.
   - **Contributor:** can additionally upload, subject to the account role and
     device policy. This does not grant Desktop administration or library-wide
     browsing. Shared albums remain read-only even for contributors.
4. Pair each phone separately using its own short-lived QR credential. Assign
   each device to a profile and save its upload policy.
5. Create albums using the existing Desktop library controls. Grant selected
   albums to each profile in **Family & sharing**. Grants reference the existing
   library and album IDs; media is not copied.
6. Enable **Family mode** after reviewing the assignments and grants.
7. Refresh the phone web app and sign in with the assigned local account. Choose
   a library and then a shared album in its menu. An empty shared-library list
   means no current album grants, not an empty Desktop archive.

Family mode is **off by default** for compatibility. In legacy mode, paired
devices can upload without a profile, and web browsing retains the existing
Desktop-account sign-in behavior. Disabling Family mode intentionally restores
that broader legacy access; the dashboard requires confirmation. Per-device
upload policies still apply in legacy mode.

Family mode requires the embedded account directory. External account-server
overrides without a local directory are not supported for family profiles and
fail explicitly rather than allowing access.

## Access rules

| Action in Family mode | Unassigned/disabled profile | Read-only | Contributor |
|---|---|---|---|
| Upload/register/resume | Denied | Denied | Allowed by account + device policy |
| Browse shared albums | Denied | Assigned-account sign-in required | Assigned-account sign-in required |
| Browse unshared files/library | Denied | Denied | Denied |
| Favorite/delete shared originals | Denied | Denied | Denied |
| Desktop account chat | Denied | Denied | Denied |
| Manage profiles/grants/policies | Desktop Admin unlock required | Same | Same |

Every request authenticates the current device token. Family browsing additionally
checks the current profile, active account and saved device sign-in. Listings,
counts, search, folder counts, timelines, file ranges/HEAD and thumbnails all use
the granted album membership. A guessed path or a cached thumbnail file does not
bypass the checks. Linked aliases are not served through family file routes.
Private media responses use `no-store`; the service worker caches only the public
app shell. Removing a grant or changing album membership applies on the next
request without waiting for the old library index cache.

Device assignment or profile edits invalidate affected family sign-ins.
Disabling a profile/account blocks its access; restoring it can restore its
previous grants. Changing an account to viewer blocks contributor uploads on
the next policy check. Revoking a device invalidates its credential permanently
and cancels unfinished uploads; restoring an account does not revive that token.
Already downloaded photos cannot be withdrawn from a recipient.

Accounts retain their existing Desktop roles. Family grants are the LAN browsing
boundary, not a local operating-system sandbox: someone with physical Desktop
access or a privileged Desktop login can still use the local library.

## Device policies and upload history

Admin can assign an owner profile, pause/resume receiving for one device,
allow photos/videos independently, and set its maximum file size. The effective
size limit is the smaller of the global and per-device limits.

- New sessions, asset registration, resumed PUTs and verification recheck policy.
  Active upload loops check policy/revocation between chunks. An already-issued
  filesystem write may finish; later chunks are not accepted after denial.
- Pausing retains partial bytes and the offset. Resume the policy and retry
  from the phone; no original is deleted.
- Bytes already safely committed before revocation remain on Desktop. If
  revocation overlaps final filesystem placement, the original is preserved and
  its cancelled job records the placed path, rather than resurrecting the job.
- Each device keeps its own token, source identifiers, queue and session history,
  even when several devices have the same owner.
- The existing global destination library/folder and safe collision handling
  remain unchanged. Sharing an album does not change the upload destination or
  automatically add uploads to that album.
- `GET /api/v1/device` now includes `policy` with `familyEnabled`, `profileId`,
  effective `uploadEnabled`, `allowImages`, `allowVideos`, `maxFileSizeMB`.
  Denied uploads return `403 upload_policy`; batch registrations may return
  per-item `upload_policy` errors. Offsets remain available through HEAD.

The Android M2 client remains protocol-compatible and displays server rejection
errors. It does not have a new family-browsing screen or a device-policy editor.
Its existing Wi-Fi/charging and media-selection rules remain phone-side
WorkManager constraints. The server cannot infer charging or enforce phone
network selection. Native iOS remains the documented M2 follow-up; iPhone web
browsing/manual upload uses these same server rules.

## External drives and NAS

Use the existing **Open folder** workflow to register a drive, mapped network
drive, or reachable Windows UNC share. Run Desktop as the Windows user who has
access to that share. Keep the drive letter, mount/share path and permissions
stable: library identity is based on the normalized absolute path.

Leave MiLeo's application-data SQLite databases and JSON indexes on the local
Desktop disk. Only original-media roots and separately configured backup
destinations should be on external storage. Do not move a live SQLite database
onto SMB/NFS or share it between multiple Desktop writers.

Disconnecting a root does not unregister it. The scanner preserves records,
annotations, albums and hashes for inaccessible roots rather than treating an
incomplete scan as deletion. Phone metadata can still be listed from the local
index; file access reports unavailable storage. Upload placement resolves an
existing root first instead of recreating an absent mount path. Reconnect at the
same path, refresh/rescan and retry failed jobs. Safe exclusive-copy fallback is
used where hard links are unsupported; existing originals are never overwritten.

Duplicate detection verifies the current original's size and SHA-256 on disk,
not just its saved sync history. A missing, modified or disconnected original
cannot cause MiLeo to discard a newly received copy as a duplicate. If placement
is unavailable, verified incoming bytes remain on the local Desktop disk as a
retryable job. After reconnecting, retry can reuse a verified original or safely
place a new copy. Uploads that cannot check destination storage return
`503 storage_unavailable`; they do not recreate an absent library root.

This is filesystem compatibility, not a NAS discovery/client or credential
manager. A different path is a different library; there is no automatic volume
remapping. MiLeo cannot distinguish an incorrectly mounted replacement disk at
the same path, guarantee a NAS's flush durability, or prevent another application
from modifying media. Keep independent verified backups.

## Remote access architecture: VPN only, not automatically enabled

Supported design: phone -> separately managed authenticated VPN -> private LAN
route -> MiLeo's existing HTTPS private LAN address. Keep Desktop authoritative,
retain per-device tokens and family grants, and verify/pin its certificate just
as on the LAN.

- No Internet-facing listener, UPnP, router port forwarding, public upload proxy,
  VPN installation or automated tunnel is introduced.
- The server still binds one explicit private interface, not all interfaces.
  Startup rejects public addresses, wildcard bindings (`0.0.0.0` / `::`) and
  hostname bindings before creating a certificate or opening a listener.
  Private IPv6 addresses must be valid IP literals, not names with private-looking
  prefixes. Loopback listeners remain available for local testing.
  Both the listener and incoming client address must pass its private-address
  checks. Configure VPN routing/firewall rules so the private LAN endpoint is
  reachable and clients have an accepted private source address.
- Native Android pairing currently accepts private/loopback IPv4 endpoints.
  A VPN that routes to that existing private LAN endpoint is the intended design.
  A public overlay address, hostname-only endpoint, CGNAT `100.64.0.0/10` address,
  IPv6-only native pairing or arbitrary public reverse proxy is not automatically
  compatible. Do not weaken address or TLS checks to make it work.
- Android Wi-Fi-only rules can intentionally prevent cellular/VPN backup.
  VPN reachability does not override OS background limits or local network rules.
- Use a stable LAN address and restrict the host firewall to intended LAN/VPN
  ranges. Pair initially on a trusted LAN and compare the certificate fingerprint.
  Do not disable HTTPS or publish a pairing QR in public.

This milestone documents the architecture; no live remote/VPN deployment has
been configured or tested by the implementation.

## Persistence, migration and rollback

Sync SQLite migration **5** adds `family_profiles`, `album_grants`,
`family_logins` and device ownership/policy columns. Account schema, library
JSON formats, paths, originals and existing device/session rows are retained.
`familyEnabled` is a persisted setting defaulting to false.

Before upgrading an on-disk schema-4 sync database, startup creates a unique
`wifi-sync.db.pre-family-<uuid>.db` SQLite snapshot using `VACUUM INTO` and verifies
SQLite integrity and foreign keys. A failure prevents migration. This local
snapshot is an additional database rollback aid, **not** a substitute for an M4
backup of indexes/accounts/configuration/originals. Preserve it until the upgrade
has been validated; no automatic deletion/retention is performed.

M4 backups include the family tables, grants and device policy automatically.
Restore accepts verified sync schema 4 or 5. Schema 4 is migrated on normal
startup; schema 5 retains family settings, but family sign-ins are cleared, all
device credentials are revoked and receiving is disabled. Pair phones again and
assign new registrations. Newer unknown schemas are rejected.

To roll back:

1. Stop receiving and close Desktop completely.
2. Preserve the current app-data directory and all new original-media files.
3. With the compatible M4 app, restore the complete verified pre-M5 backup using
   the [recovery procedure](BACKUP_RECOVERY.md). An M4 binary must not open the
   migrated live sync database; migration 5 is not reversed by dropping tables.
4. For expert database-only emergency rollback, with every SQLite handle closed,
   preserve the current database **and its WAL/SHM sidecars together**, then restore
   the verified pre-family database snapshot as a consistent unit. This loses
   post-snapshot sync jobs/history and does not roll back account/index changes;
   never delete imported originals to make metadata match. Reconcile and inspect.

Automated tests cover family read/write boundaries, grant removal, account
disablement/role changes, revoked and policy-paused transfers, persistent restart
state, schema-4 migration/snapshot, M4 restore with family-state retention and
credential invalidation, and simulated removable-root disconnect/reconnect.
Additional acceptance tests exercise two devices with the same owner, name,
source asset identifier and session idempotency key, separate sync timestamps
and histories, stale/missing duplicate originals, and storage loss during
verification and across restart.
Real NAS hardware, VPN routing and packaged Electron lifecycle require deployment
testing; filesystem/API fixture tests are not claims of those environments.

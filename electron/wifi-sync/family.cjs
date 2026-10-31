'use strict';

const crypto = require('node:crypto');
const { transaction } = require('./db.cjs');
const { can } = require('../permissions.cjs');

function createFamily(repo, listAccounts) {
  const db = repo.db;
  const q = sql => db.prepare(sql);
  const accounts = () => {
    const rows = listAccounts?.();
    if (!Array.isArray(rows)) throw new Error('The local account directory is unavailable.');
    return rows;
  };
  const profiles = () => q('SELECT * FROM family_profiles ORDER BY name, id').all();
  const grants = () => q('SELECT * FROM album_grants ORDER BY profile_id, library_id, album_id').all();
  const device = id => q('SELECT * FROM devices WHERE id = ? AND removed_at IS NULL').get(id);
  function context(deviceId) {
    const current = device(deviceId);
    if (!current || current.revoked_at !== null) return { device: null, profile: null, signedIn: false };
    const profile = current.profile_id ? q('SELECT * FROM family_profiles WHERE id = ? AND enabled = 1').get(current.profile_id) : null;
    const account = profile && accounts().find(account => account.id === profile.account_id && typeof account.email === 'string' && account.email.toLowerCase() === profile.email && !account.disabled_at);
    const login = q('SELECT profile_id FROM family_logins WHERE device_id = ?').get(deviceId);
    return { device: current, profile: account ? profile : null, account: account || null, signedIn: Boolean(account && login?.profile_id === profile.id) };
  }
  function saveProfile(input) {
    if (!input || typeof input !== 'object') throw new Error('A family profile is required.');
    const account = accounts().find(row => row.id === input.accountId && !row.disabled_at);
    const name = String(input.name || '').trim();
    if (!account || typeof account.email !== 'string' || !account.email || !name || name.length > 100 || !['viewer', 'contributor'].includes(input.role) || typeof input.enabled !== 'boolean') throw new Error('Choose an active local account with email, profile name, role and enabled state.');
    if (input.role === 'contributor' && !can(account.role, 'sync')) throw new Error('Contributor profiles require an editor or admin local account. Change the account role in User management first.');
    const id = input.id || crypto.randomUUID();
    if (input.id && !profiles().some(row => row.id === id)) throw new Error('Family profile not found.');
    return transaction(db, () => {
      q(`INSERT INTO family_profiles (id, account_id, email, name, role, enabled) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, email=excluded.email, name=excluded.name, role=excluded.role, enabled=excluded.enabled`)
        .run(id, account.id, account.email.toLowerCase(), name, input.role, Number(input.enabled));
      q('DELETE FROM family_logins WHERE profile_id = ?').run(id);
      repo.logEvent({ category: 'security', kind: 'family_profile_saved', message: `Family profile "${name}" updated.` });
      return id;
    });
  }
  function saveDevice(id, policy) {
    if (!device(id)) throw new Error('Device not found.');
    if (!policy || (policy.profileId !== null && !profiles().some(row => row.id === policy.profileId))) throw new Error('Select a family profile or Unassigned.');
    if (['uploadEnabled', 'allowImages', 'allowVideos'].some(key => typeof policy[key] !== 'boolean') || !Number.isSafeInteger(policy.maxFileSizeMB) || policy.maxFileSizeMB < 1 || policy.maxFileSizeMB > 1048576) throw new Error('Invalid upload policy. Maximum size must be 1-1048576 MB.');
    transaction(db, () => {
      q('UPDATE devices SET profile_id=?, upload_enabled=?, allow_images=?, allow_videos=?, max_file_size_mb=? WHERE id=?')
        .run(policy.profileId, Number(policy.uploadEnabled), Number(policy.allowImages), Number(policy.allowVideos), policy.maxFileSizeMB, id);
      q('DELETE FROM family_logins WHERE device_id=?').run(id);
      repo.logEvent({ category: 'security', kind: 'device_policy_saved', message: 'Device ownership and upload policy updated.', deviceId: id });
    });
  }
  function setGrant(profileId, libraryId, albumId, enabled) {
    if (!profiles().some(row => row.id === profileId) || typeof enabled !== 'boolean') throw new Error('Invalid album grant.');
    if (enabled) q('INSERT OR IGNORE INTO album_grants VALUES (?, ?, ?)').run(profileId, libraryId, albumId);
    else q('DELETE FROM album_grants WHERE profile_id=? AND library_id=? AND album_id=?').run(profileId, libraryId, albumId);
    repo.logEvent({ category: 'security', kind: 'album_grant_saved', message: enabled ? 'Read-only album access granted.' : 'Album access removed.' });
  }
  function allowedAlbums(profileId, libraryId) {
    return q('SELECT album_id FROM album_grants WHERE profile_id=? AND library_id=?').all(profileId, libraryId).map(row => row.album_id);
  }
  function signIn(deviceId, user) {
    const current = context(deviceId);
    if (!current.profile || user?.id !== current.profile.account_id || String(user.email).toLowerCase() !== current.profile.email) return false;
    q('INSERT INTO family_logins VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET profile_id=excluded.profile_id').run(deviceId, current.profile.id);
    repo.logEvent({ category: 'security', kind: 'family_signed_in', message: 'Assigned family account signed in.', deviceId });
    return true;
  }
  function uploadProblem(deviceId, asset = null) {
    const current = device(deviceId);
    if (!current || current.revoked_at !== null) return 'Device access has been revoked.';
    if (!current.upload_enabled) return 'Uploads are paused for this device.';
    if (repo.getSettings().familyEnabled) {
      const { profile, account } = context(deviceId);
      if (!profile) return 'Admin must assign an enabled family profile with an active local account.';
      if (profile.role !== 'contributor') return 'This family profile has read-only access.';
      if (!can(account.role, 'sync')) return 'The linked local account has read-only permissions.';
    }
    if (asset) {
      const kind = asset.media_kind || asset.kind;
      if ((kind === 'image' && !current.allow_images) || (kind === 'video' && !current.allow_videos)) return 'This media type is disabled for this device.';
      if (asset.size > Math.min(current.max_file_size_mb, repo.getSettings().maxFileSizeMB) * 1024 * 1024) return 'File exceeds the device upload size limit.';
    }
    return null;
  }
  return { accounts, profiles, grants, context, saveProfile, saveDevice, setGrant, allowedAlbums, signIn, uploadProblem,
    signOut: id => q('DELETE FROM family_logins WHERE device_id=?').run(id) };
}

module.exports = { createFamily };

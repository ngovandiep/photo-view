'use strict';

// viewer: browse, search and see sync status. editor: also change the library and run sync. admin: everything.
const CAPABILITIES = {
  viewer: { edit: false, sync: false },
  editor: { edit: true, sync: true },
  admin: { edit: true, sync: true }
};

const normalizeRole = value => {
  const role = String(value || '').toLowerCase();
  return role in CAPABILITIES ? role : 'viewer';
};

const permissionsFor = role => ({ ...CAPABILITIES[normalizeRole(role)] });
const can = (role, capability) => permissionsFor(role)[capability] === true;

module.exports = { CAPABILITIES, normalizeRole, permissionsFor, can };

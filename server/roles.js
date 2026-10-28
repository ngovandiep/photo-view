'use strict';

const ROLES = ['viewer', 'editor', 'admin'];

// Accounts created before roles were split used 'user', which was view-only in spirit.
const normalizeRole = value => {
  const role = String(value || '').toLowerCase();
  return ROLES.includes(role) ? role : 'viewer';
};

module.exports = { ROLES, normalizeRole };

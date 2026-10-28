(() => {
  'use strict';
  const api = window.desktopAuth;
  if (!api) { return; }

  const el = (tag, props = {}, children = []) => {
    const node = Object.assign(document.createElement(tag), props);
    children.forEach(child => node.append(child));
    return node;
  };
  const cleanError = error => String(error && error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  let mode = 'login';
  const email = el('input', { type: 'email', id: 'auth-email', autocomplete: 'email', required: true, maxLength: 320 });
  email.setAttribute('list', 'auth-email-suggestions');
  const emailSuggestions = el('datalist', { id: 'auth-email-suggestions' });
  const EMAIL_DOMAINS = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com'];
  email.addEventListener('input', () => {
    const at = email.value.indexOf('@');
    const local = at === -1 ? email.value.trim() : email.value.slice(0, at);
    const typed = at === -1 ? '' : email.value.slice(at + 1).toLowerCase();
    const options = local ? EMAIL_DOMAINS.filter(domain => domain.startsWith(typed) && domain !== typed).map(domain => `${local}@${domain}`) : [];
    emailSuggestions.replaceChildren(...options.map(value => el('option', { value })));
  });
  const name = el('input', { type: 'text', id: 'auth-name', autocomplete: 'name', maxLength: 100 });
  const password = el('input', { type: 'password', id: 'auth-password', autocomplete: 'current-password', required: true, minLength: 8, maxLength: 200 });
  const EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10.3 10.3 0 0 1 12 19C5.6 19 2 12 2 12a18 18 0 0 1 4.1-5.1M9.9 5.2A9.7 9.7 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M2 2l20 20"/></svg>';
  const reveal = el('button', { type: 'button', className: 'reveal', title: 'Show password', innerHTML: EYE });
  reveal.setAttribute('aria-label', 'Show password');
  reveal.setAttribute('aria-pressed', 'false');
  reveal.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    reveal.innerHTML = show ? EYE_OFF : EYE;
    reveal.title = show ? 'Hide password' : 'Show password';
    reveal.setAttribute('aria-label', reveal.title);
    reveal.setAttribute('aria-pressed', String(show));
    password.focus();
  });
  const passwordField = el('div', { className: 'password-field' }, [password, reveal]);
  const remember = el('input', { type: 'checkbox', id: 'auth-remember', checked: true });
  const rememberLabel = el('label', { className: 'remember' }, [remember, ' Remember my login on this device']);
  const message = el('p', { id: 'auth-message', role: 'alert' });
  const submit = el('button', { type: 'submit', className: 'primary' });
  const toggle = el('button', { type: 'button', className: 'quiet' });
  const skip = el('button', { type: 'button', className: 'quiet' }, ['Continue without an account']);
  const nameLabel = el('label', {}, ['Name', name]);
  const form = el('form', { id: 'auth-form' }, [
    el('div', { className: 'eyebrow' }, ['ACCOUNT']),
    el('h2', { id: 'auth-title' }),
    nameLabel,
    el('label', {}, ['Email', email, emailSuggestions]),
    el('label', {}, ['Password', passwordField]),
    rememberLabel,
    message, submit, toggle, skip
  ]);
  const overlay = el('div', { id: 'auth-overlay', hidden: true }, [form]);
  const accountBar = el('div', { id: 'account-bar' });

  function render() {
    const login = mode === 'login';
    form.querySelector('#auth-title').textContent = login ? 'Sign in to Still' : 'Create your account';
    submit.textContent = login ? 'Sign in' : 'Create account';
    toggle.textContent = login ? 'No account? Create one' : 'Have an account? Sign in';
    nameLabel.hidden = login;
    rememberLabel.hidden = !login;
    password.autocomplete = login ? 'current-password' : 'new-password';
    message.textContent = '';
  }

  const ROLE_LABELS = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' };
  function applyPermissions(state) {
    const permissions = state.permissions || { edit: false, sync: false };
    document.body.dataset.role = state.role || 'viewer';
    document.body.dataset.canEdit = String(permissions.edit === true);
    document.body.dataset.canSync = String(permissions.sync === true);
    document.dispatchEvent(new CustomEvent('still:permissions', { detail: { role: state.role || 'viewer', userKey: state.signedIn && state.user && Number.isInteger(state.user.id) ? `u${state.user.id}` : 'local', ...permissions } }));
  }

  function renderAccount(state) {
    applyPermissions(state);
    accountBar.replaceChildren();
    menuButton.hidden = !state.signedIn;
    const role = ROLE_LABELS[state.role] || 'Viewer';
    if (state.signedIn) {
      const label = state.user ? state.user.displayName || state.user.email : 'Signed in';
      accountBar.append(el('span', { className: 'account-name' }, [label]), el('span', { className: `role-badge role-${state.role || 'viewer'}`, title: state.permissions && state.permissions.edit ? 'You can edit the library and run Wi-Fi sync.' : 'View-only: you can browse but not change anything.' }, [role]));
      drawerName.textContent = label;
      drawerEmail.textContent = state.user ? state.user.email : '';
      avatar.textContent = (label[0] || '?').toUpperCase();
    } else {
      closeDrawer();
      const inn = el('button', { type: 'button', className: 'quiet' }, ['Sign in']);
      inn.addEventListener('click', show);
      accountBar.append(el('span', { className: 'account-name' }, ['Local only']), el('span', { className: 'role-badge role-viewer', title: 'Sign in with an editor account to make changes.' }, ['View-only']), inn);
    }
  }

  function openDrawer() { drawer.hidden = false; backdrop.hidden = false; menuButton.setAttribute('aria-expanded', 'true'); drawer.querySelector('button').focus(); }
  function closeDrawer() { drawer.hidden = true; backdrop.hidden = true; menuButton.setAttribute('aria-expanded', 'false'); }

  const menuButton = el('button', { type: 'button', id: 'account-menu-button', className: 'icon-button', title: 'Account menu', hidden: true }, ['☰']);
  menuButton.setAttribute('aria-label', 'Account menu');
  menuButton.setAttribute('aria-haspopup', 'true');
  menuButton.setAttribute('aria-expanded', 'false');
  const avatar = el('div', { className: 'drawer-avatar' });
  const drawerName = el('strong');
  const drawerEmail = el('span', { className: 'muted' });
  const drawerStatus = el('p', { id: 'drawer-status', role: 'status' });
  const profileInput = el('input', { type: 'text', maxLength: 100, 'aria-label': 'Display name' });
  const profileForm = el('form', { id: 'profile-form', hidden: true }, [profileInput, el('button', { type: 'submit', className: 'primary' }, ['Save name'])]);
  const item = (icon, text, onClick) => {
    const button = el('button', { type: 'button', className: 'drawer-item' }, [el('span', { 'aria-hidden': 'true' }, [icon]), text]);
    button.addEventListener('click', onClick);
    return button;
  };
  const syncItem = item('⇅', 'Sync favorites, tags & albums', async () => {
    syncItem.disabled = true;
    drawerStatus.textContent = 'Syncing…';
    try {
      const result = await api.sync();
      drawerStatus.textContent = `Synced ${result.libraries} folder(s): ${result.pushed} annotated photos uploaded, ${result.merged} updated from your account.`;
      if (result.merged) { setTimeout(() => location.reload(), 1200); }
    } catch (error) {
      drawerStatus.textContent = cleanError(error);
      const state = await api.status().catch(() => null);
      if (state && !state.signedIn) { renderAccount(state); show(); }
    } finally {
      syncItem.disabled = false;
    }
  });
  const drawer = el('aside', { id: 'account-drawer', hidden: true, 'aria-label': 'Account menu' }, [
    el('div', { className: 'drawer-head' }, [avatar, el('div', {}, [drawerName, drawerEmail]), el('button', { type: 'button', className: 'icon-button', title: 'Close menu', id: 'drawer-close' }, ['×'])]),
    el('div', { className: 'eyebrow' }, ['YOUR ACCOUNT']),
    item('♡', 'My favorites', () => { closeDrawer(); const nav = document.querySelector('[data-view="favorites"]'); if (nav) nav.click(); }),
    syncItem,
    item('✎', 'Edit profile', () => { profileInput.value = drawerName.textContent; profileForm.hidden = !profileForm.hidden; if (!profileForm.hidden) profileInput.focus(); }),
    profileForm,
    drawerStatus,
    el('div', { className: 'drawer-spacer' }),
    item('⎋', 'Sign out', async () => { closeDrawer(); await api.logout(); show(); })
  ]);
  const backdrop = el('div', { id: 'drawer-backdrop', hidden: true });
  menuButton.addEventListener('click', () => (drawer.hidden ? openDrawer() : closeDrawer()));
  backdrop.addEventListener('click', closeDrawer);
  drawer.querySelector('#drawer-close').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !drawer.hidden) { closeDrawer(); menuButton.focus(); } });
  profileForm.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      renderAccount(await api.updateProfile(profileInput.value));
      profileForm.hidden = true;
      drawerStatus.textContent = 'Profile updated.';
    } catch (error) {
      drawerStatus.textContent = cleanError(error);
    }
  });

  async function show() {
    render();
    overlay.hidden = false;
    const saved = await api.savedCredentials().catch(() => null);
    if (saved && !email.value) { email.value = saved.email; password.value = saved.password; }
    (saved ? submit : email).focus();
  }

  toggle.addEventListener('click', () => { mode = mode === 'login' ? 'register' : 'login'; render(); });
  skip.addEventListener('click', async () => { renderAccount(await api.continueLocal()); overlay.hidden = true; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    message.textContent = '';
    try {
      const state = mode === 'login' ? await api.login(email.value, password.value, remember.checked) : await api.register(email.value, password.value, name.value);
      password.value = '';
      renderAccount(state);
      overlay.hidden = true;
    } catch (error) {
      message.textContent = cleanError(error);
    } finally {
      submit.disabled = false;
    }
  });

  document.addEventListener('DOMContentLoaded', async () => {
    document.body.append(overlay, drawer, backdrop);
    const topbar = document.querySelector('.topbar');
    if (topbar) { topbar.append(menuButton); }
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) { sidebar.insertBefore(accountBar, sidebar.querySelector('.sidebar-footer')); }
    const state = await api.status().catch(() => ({ signedIn: false, localOnly: true }));
    renderAccount(state);
    if (!state.signedIn && !state.localOnly) { show(); }
    // Picks up role changes made by an administrator without requiring a restart.
    const refreshRole = async () => { if (document.hidden || !overlay.hidden) return; const next = await api.status().catch(() => null); if (next && (next.role !== document.body.dataset.role || next.signedIn !== !menuButton.hidden)) renderAccount(next); };
    setInterval(refreshRole, 30000);
    window.addEventListener('focus', refreshRole);
  });
})();

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
  const name = el('input', { type: 'text', id: 'auth-name', autocomplete: 'name', maxLength: 100 });
  const password = el('input', { type: 'password', id: 'auth-password', autocomplete: 'current-password', required: true, minLength: 8, maxLength: 200 });
  const message = el('p', { id: 'auth-message', role: 'alert' });
  const submit = el('button', { type: 'submit', className: 'primary' });
  const toggle = el('button', { type: 'button', className: 'quiet' });
  const skip = el('button', { type: 'button', className: 'quiet' }, ['Continue without an account']);
  const nameLabel = el('label', {}, ['Name', name]);
  const form = el('form', { id: 'auth-form' }, [
    el('div', { className: 'eyebrow' }, ['ACCOUNT']),
    el('h2', { id: 'auth-title' }),
    nameLabel,
    el('label', {}, ['Email', email]),
    el('label', {}, ['Password', password]),
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
    password.autocomplete = login ? 'current-password' : 'new-password';
    message.textContent = '';
  }

  function renderAccount(state) {
    accountBar.replaceChildren();
    menuButton.hidden = !state.signedIn;
    if (state.signedIn) {
      const label = state.user ? state.user.displayName || state.user.email : 'Signed in';
      accountBar.append(el('span', { className: 'account-name' }, [label]));
      drawerName.textContent = label;
      drawerEmail.textContent = state.user ? state.user.email : '';
      avatar.textContent = (label[0] || '?').toUpperCase();
    } else {
      closeDrawer();
      const inn = el('button', { type: 'button', className: 'quiet' }, ['Sign in']);
      inn.addEventListener('click', show);
      accountBar.append(el('span', { className: 'account-name' }, ['Local only']), inn);
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

  function show() { render(); overlay.hidden = false; email.focus(); }

  toggle.addEventListener('click', () => { mode = mode === 'login' ? 'register' : 'login'; render(); });
  skip.addEventListener('click', async () => { renderAccount(await api.continueLocal()); overlay.hidden = true; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    message.textContent = '';
    try {
      const state = mode === 'login' ? await api.login(email.value, password.value) : await api.register(email.value, password.value, name.value);
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
  });
})();

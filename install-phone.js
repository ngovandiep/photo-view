(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const dialog = $('phone-install-dialog');
  const api = window.wifiSync;
  let status = null;
  let pairing = null;
  let busy = false;
  let timer;
  let refreshTimer;

  function error(message = '') {
    $('phone-install-error').textContent = message;
    $('phone-install-error').hidden = !message;
  }

  function render() {
    const running = Boolean(status?.running);
    if (!running || pairing && (pairing.expiresAt <= Date.now() || status.pairing?.code !== pairing.code)) pairing = null;
    const count = status?.devices.filter(device => !device.revoked_at).length || 0;
    $('phone-install-status').textContent = !api
      ? `Open the ${window.AppBrand?.current.appName || 'MiLeo Photo Library'} desktop app to share a library over Wi-Fi. This browser Preview cannot start a LAN server.`
      : !status ? 'Connection status unavailable.'
        : running ? `Server running. ${count} paired phone${count === 1 ? '' : 's'} (not necessarily online).`
          : 'Wi-Fi server stopped. Start it to connect your phone.';
    const button = $('phone-install-connect');
    button.textContent = busy ? 'Please wait...' : running ? pairing ? 'Generate new pairing code' : 'Show pairing QR code' : 'Start and show QR code';
    button.disabled = !api || busy || !status || !status.libraries.length || document.body.dataset.canSync === 'false';
    if (api && status && !status.libraries.length) $('phone-install-status').textContent = 'Add a photo folder first, then connect your phone.';
    if (api && document.body.dataset.canSync === 'false') $('phone-install-status').textContent += ' An Editor must start the server and generate pairing codes.';
    $('phone-install-link').hidden = !running;
    $('phone-install-url').value = running ? pairing?.link || `${status.url}/app` : '';
    $('phone-install-fingerprint').textContent = status?.fingerprint || '';
    const image = $('phone-install-qr');
    image.hidden = !pairing;
    if (pairing) image.src = pairing.qr;
    else image.removeAttribute('src');
    $('phone-install-code').textContent = pairing?.code || '';
    $('phone-install-expiry').textContent = pairing ? `Expires in ${Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000))}s` : 'Generate a code to pair a new phone. Existing pairings are remembered by the phone.';
  }

  async function request(action) {
    const result = await action();
    if (!result.ok) throw new Error(result.error);
    return result;
  }

  async function refresh() {
    if (!api || !dialog.open || busy) return;
    try { status = (await request(api.status)).status; render(); }
    catch (failure) { error(`Could not read Wi-Fi status: ${failure.message}`); }
  }

  $('install-phone').addEventListener('click', async () => {
    dialog.showModal();
    error(); render();
    await refresh();
    if (dialog.open) { clearInterval(timer); timer = setInterval(render, 1000); }
  });
  $('phone-install-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dialog.close(); }
  });
  dialog.addEventListener('close', () => {
    clearInterval(timer); clearTimeout(refreshTimer);
    $('install-phone').focus();
  });
  $('phone-install-connect').addEventListener('click', async () => {
    if (!api || busy) return;
    busy = true; error(); render();
    try {
      if (!status.running) status = (await request(api.start)).status;
      const nextPairing = (await request(api.pair)).pairing;
      const nextStatus = (await request(api.status)).status;
      status = nextStatus; pairing = nextPairing;
    } catch (failure) { error(`Could not connect your phone: ${failure.message}`); }
    finally { busy = false; render(); }
  });
  $('phone-install-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('phone-install-url').value);
      $('phone-install-expiry').textContent = 'URL copied. Open it on your phone.';
    } catch {
      $('phone-install-url').focus(); $('phone-install-url').select();
      error('Clipboard access is unavailable. Copy the selected URL manually.');
    }
  });
  document.addEventListener('still:permissions', () => { if (dialog.open) render(); });
  api?.onEvent(event => {
    if (event.type === 'device-paired') pairing = null;
    if (dialog.open) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 300);
    }
  });
})();

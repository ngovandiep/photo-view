'use strict';

const CACHE = 'still-shell-v6';
const FILES = [
  '/app', '/pair', '/device', '/app.js', '/app.css', '/chat.js', '/chat.css',
  '/uploader.js', '/uploader.css', '/device.js', '/device.css',
  '/install.js', '/install.css', '/brand.js', '/manifest.webmanifest',
  '/icon-180.png', '/icon-192.png', '/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('still-shell-') && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Never intercept API requests, photo bytes, credentials or other origins.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search) return;
  const pathname = url.pathname === '/' ? '/app' : url.pathname;
  if (!FILES.includes(pathname)) return;
  event.respondWith(fetch(event.request).catch(async () => {
    const cached = await caches.match(pathname, { cacheName: CACHE });
    if (cached) return cached;
    return Response.error();
  }));
});

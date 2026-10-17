/* Prosol Foods — service worker. Keeps the app itself on the phone so it opens without signal.
 * It never touches requests to the server (script.google.com): data is handled by the app's own outbox. */
'use strict';
var VERSION = '3fb62eea6615';
var ASSETS = ["./","index.html","app.js","styles.css","config.js","manifest.webmanifest","map.html","map.js","icons/apple-touch-icon.png","icons/icon-192.png","icons/icon-512.png","icons/maskable-512.png"];
var CACHE = 'prosol-' + VERSION;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS.map(function (a) { return new Request(a, { cache: 'reload' }); })); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('prosol-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function fromNetwork(req, ms) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
    fetch(req).then(function (r) { clearTimeout(t); if (r && r.ok) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); } resolve(r); }, function (err) { clearTimeout(t); reject(err); });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // API calls and maps links pass straight through
  if (req.mode === 'navigate') {
    // newest page when the network answers quickly, otherwise the copy on the phone
    e.respondWith(fromNetwork(req, 4000).catch(function () { return caches.match('index.html', { ignoreSearch: true }); }));
    return;
  }
  if (VERSION === 'dev') { e.respondWith(fromNetwork(req, 4000).catch(function () { return caches.match(req, { ignoreSearch: true }); })); return; }
  // released build: files are versioned by the cache name, so the phone's copy is always the right one
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || fromNetwork(req, 15000); }));
});

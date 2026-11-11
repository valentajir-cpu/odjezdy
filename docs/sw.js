/* Odjezdy MHD - service worker
 * Nejdriv sit (aby se hned projevila nova verze), pri vypadku ulozena kopie.
 * Diky tomu stranka i jizdni rad funguji bez signalu (bez zivych dat).
 */
"use strict";

// ============================================================
// 1. NASTAVENI
// ============================================================
var CACHE = "odjezdy-v1";
var SHELL = ["./", "index.html", "app.js", "data.json", "manifest.json", "icon.svg", "icon-192.png"];
var TIMEOUT_MS = 6000;

// ============================================================
// 2. INSTALACE A UKLID
// ============================================================
self.addEventListener("install", function (ev) {
  ev.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).catch(function () { }));
  self.skipWaiting();
});

self.addEventListener("activate", function (ev) {
  ev.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// ============================================================
// 3. POZADAVKY (jen vlastni soubory stranky)
// ============================================================
self.addEventListener("fetch", function (ev) {
  var req = ev.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // ziva data a hledani adres jdou primo

  ev.respondWith(new Promise(function (resolve, reject) {
    var done = false;
    var timer = setTimeout(function () {
      caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit && !done) { done = true; resolve(hit); }
      });
    }, TIMEOUT_MS);
    fetch(req).then(function (res) {
      clearTimeout(timer);
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      if (!done) { done = true; resolve(res); }
    }).catch(function (err) {
      clearTimeout(timer);
      caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (done) return;
        done = true;
        if (hit) resolve(hit); else reject(err);
      });
    });
  }));
});

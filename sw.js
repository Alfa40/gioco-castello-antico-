"use strict";

// Bump this on every deploy that changes any cached file — it's the only
// thing that invalidates the old cache and lets players pick up the new
// version (see the fetch handler below for how updates actually reach an
// already-installed app).
const CACHE_VERSION = "crazy-town-v2";

const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./simulation.js",
  "./script.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./generated-images/pixel/player.jpg",
  "./generated-images/pixel/player_body.png",
  "./generated-images/pixel/enemy_balordo.jpg",
  "./generated-images/pixel/enemy_balordo.png",
  "./generated-images/pixel/enemy_nervoso.jpg",
  "./generated-images/pixel/enemy_nervoso.png",
  "./generated-images/pixel/enemy_imprevedibile.jpg",
  "./generated-images/pixel/enemy_imprevedibile.png",
  "./generated-images/pixel/enemy_bruto.jpg",
  "./generated-images/pixel/enemy_bruto.png",
  "./generated-images/pixel/enemy_tiratore.jpg",
  "./generated-images/pixel/enemy_tiratore.png",
  "./generated-images/pixel/enemy_driveby.jpg",
  "./generated-images/pixel/enemy_driveby.png",
  "./generated-images/pixel/weapon_fists.png",
  "./generated-images/pixel/weapon_knife1.png",
  "./generated-images/pixel/weapon_knife2.png",
  "./generated-images/pixel/weapon_bat.png",
  "./generated-images/pixel/weapon_pole.png",
  "./generated-images/pixel/weapon_hammer.png",
  "./generated-images/pixel/weapon_pistol.png",
  "./generated-images/pixel/weapon_smg.png",
  "./generated-images/pixel/weapon_sniper.png",
  "./generated-images/pixel/weapon_shotgun.png",
  "./generated-images/pixel/weapon_rocket.png",
];

self.addEventListener("install", (event) => {
  // Take over from any previously-waiting service worker immediately
  // instead of waiting for every open tab to close — see the CACHE_VERSION
  // comment above for the tradeoff this implies.
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate: serve instantly from cache when available (so the
// game also works offline / on a flaky connection), while always fetching a
// fresh copy in the background to update the cache for next time — so a new
// CACHE_VERSION deploy is picked up on the *next* load after this one,
// without the player ever seeing a loading stall waiting on the network.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});

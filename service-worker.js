// ═══════════════════════════════════════════════════
//  Wandermark Service Worker
//  Handles: caching, offline support, push notifications,
//           background geofence checks
// ═══════════════════════════════════════════════════

const CACHE_NAME = 'wandermark-v1';
const CACHE_VERSION = 1;

// Files to cache for offline use
const STATIC_ASSETS = [
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  // Google Fonts (cached on first load)
  'https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;1,300&display=swap'
];

// ═══════════════════════════════════════════════════
// INSTALL — cache static assets
// ═══════════════════════════════════════════════════
self.addEventListener('install', event => {
  console.log('[SW] Installing Wandermark Service Worker v' + CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Caching static assets');
        // Cache what we can — don't fail install if fonts are unavailable
        return cache.addAll(STATIC_ASSETS).catch(err => {
          console.warn('[SW] Some assets failed to cache:', err);
        });
      })
      .then(() => self.skipWaiting())
  );
});

// ═══════════════════════════════════════════════════
// ACTIVATE — clean up old caches
// ═══════════════════════════════════════════════════
self.addEventListener('activate', event => {
  console.log('[SW] Activating Wandermark Service Worker');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ═══════════════════════════════════════════════════
// FETCH — serve from cache, fall back to network
// Strategy: Cache-first for static assets,
//           Network-first for everything else
// ═══════════════════════════════════════════════════
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and browser extensions
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // Cache-first strategy for our own assets + fonts
  if (url.origin === self.location.origin || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) {
          // Return cache immediately, update in background
          const networkFetch = fetch(request).then(response => {
            if (response && response.status === 200) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
            }
            return response;
          }).catch(() => {});
          return cached;
        }
        // Not in cache — fetch from network and cache it
        return fetch(request).then(response => {
          if (!response || response.status !== 200) return response;
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          return response;
        }).catch(() => {
          // Offline fallback
          return caches.match('/index.html');
        });
      })
    );
    return;
  }

  // Network-first for external requests (maps APIs etc.)
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});

// ═══════════════════════════════════════════════════
// PUSH NOTIFICATIONS
// Receives push events from a server (if you add
// a backend later) or triggered locally
// ═══════════════════════════════════════════════════
self.addEventListener('push', event => {
  let data = { title: 'Wandermark', body: 'You have a place reminder nearby!', placeId: null };

  if (event.data) {
    try { data = { ...data, ...event.data.json() }; }
    catch (e) { data.body = event.data.text(); }
  }

  const options = {
    body: data.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-96.png',
    tag: 'wandermark-' + (data.placeId || 'general'),
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 200],
    data: { placeId: data.placeId, url: '/index.html' },
    actions: [
      { action: 'directions', title: '🗺️ Directions' },
      { action: 'snooze',     title: '😴 Snooze' },
      { action: 'dismiss',    title: '✕ Dismiss'  }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ═══════════════════════════════════════════════════
// NOTIFICATION CLICK — handle action buttons
// ═══════════════════════════════════════════════════
self.addEventListener('notificationclick', event => {
  const { action, notification } = event;
  const { placeId } = notification.data || {};
  notification.close();

  if (action === 'directions') {
    // Open app focused on directions for this place
    event.waitUntil(
      clients.openWindow('/index.html?action=directions&place=' + (placeId || ''))
    );
    return;
  }

  if (action === 'snooze') {
    // Message all open clients to snooze this place
    event.waitUntil(
      clients.matchAll({ type: 'window' }).then(clientList => {
        for (const client of clientList) {
          client.postMessage({ type: 'SNOOZE_PLACE', placeId });
        }
        if (clientList.length === 0) {
          return clients.openWindow('/index.html?action=snooze&place=' + (placeId || ''));
        }
      })
    );
    return;
  }

  // Default: open the app
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      return clients.openWindow('/index.html');
    })
  );
});

// ═══════════════════════════════════════════════════
// NOTIFICATION CLOSE
// ═══════════════════════════════════════════════════
self.addEventListener('notificationclose', event => {
  console.log('[SW] Notification closed:', event.notification.tag);
});

// ═══════════════════════════════════════════════════
// MESSAGE — receive messages from the app
// (e.g. to trigger background geofence check)
// ═══════════════════════════════════════════════════
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};

  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (type === 'CACHE_URLS') {
    event.waitUntil(
      caches.open(CACHE_NAME).then(cache => cache.addAll(payload.urls || []))
    );
    return;
  }

  if (type === 'NEARBY_ALERT') {
    // App is telling us to show a notification (when app is open)
    const { placeName, distance } = payload || {};
    self.registration.showNotification(`📍 ${placeName} is nearby!`, {
      body: `You're only ${distance} away — you wanted to visit!`,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      tag: 'wandermark-nearby',
      vibrate: [200, 100, 200],
      requireInteraction: true,
      actions: [
        { action: 'directions', title: '🗺️ Directions' },
        { action: 'snooze',     title: '😴 Snooze'     }
      ]
    });
    return;
  }
});

// ═══════════════════════════════════════════════════
// BACKGROUND SYNC — retry failed operations
// (useful when user saves a place offline)
// ═══════════════════════════════════════════════════
self.addEventListener('sync', event => {
  if (event.tag === 'sync-places') {
    console.log('[SW] Background sync: syncing places');
    // When you add a backend, sync localStorage data here
    event.waitUntil(Promise.resolve());
  }
});

console.log('[SW] Wandermark Service Worker loaded successfully');

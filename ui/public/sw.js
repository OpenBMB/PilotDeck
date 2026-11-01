// Service Worker for PilotDeck PWA
// Cache only manifest (needed for PWA install). HTML and JS are never pre-cached
// so a rebuild + refresh always picks up the latest assets.
// Bump this token whenever a cached asset's contents change (icons, manifest).
// The activate handler below purges every cache whose name doesn't match,
// so existing PWAs pick up the new visuals on the next page load.
const CACHE_NAME = 'pilotdeck-v2';
const urlsToCache = [
  '/manifest.json'
];

// Install event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Fetch event — network-first. Hashed assets are safe to cache, but JS/CSS
// chunks must still prefer the network so a long-lived desktop window does not
// keep an old entry chunk that imports files removed by a newer build.
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Never intercept API requests or WebSocket upgrades
  if (url.includes('/api/') || url.includes('/ws')) {
    return;
  }

  // Navigation requests (HTML) — always go to network, no caching
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/manifest.json').then(() =>
        new Response('<h1>Offline</h1><p>Please check your connection.</p>', {
          headers: { 'Content-Type': 'text/html' }
        })
      ))
    );
    return;
  }

  // Hashed JS/CSS chunks — network-first. If the app was rebuilt while the
  // page stayed open, the old chunk may no longer exist; let the app-level
  // dynamic import recovery reload into the fresh index.html.
  if (url.includes('/assets/') && /\.(?:js|css)(?:\?|$)/.test(new URL(url).pathname)) {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Other hashed assets (fonts/images) — cache-first since filenames change per build
  if (url.includes('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Everything else — network-first
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Activate event — purge old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    ).then(() => updateNotificationBadge())
  );
  self.clients.claim();
});

// Persist deduplication and pending conversations across service-worker restarts.
let notificationQueue = Promise.resolve();
function notificationState(update) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('pilotdeck-notifications', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('state', 'readwrite');
      const store = tx.objectStore('state');
      const read = store.get('notifications');
      let result;
      read.onsuccess = () => {
        const state = read.result || { seen: [], pending: {}, scope: null, preferences: null, lastSound: 0 };
        // Existing v1 databases have no read progress yet.
        state.readProgress ||= {};
        result = update(state);
        state.seen = state.seen.slice(-2048);
        store.put(state, 'notifications');
      };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
function serializeNotifications(action) {
  const result = notificationQueue.catch(() => {}).then(action);
  notificationQueue = result;
  return result;
}
async function updateNotificationBadge() {
  // Pending conversations still restore sidebar unread dots, but web/PWA never
  // publishes a global count. Also remove badges from earlier worker versions.
  try {
    await self.navigator.clearAppBadge?.();
  } catch { /* Badging is optional in browsers and desktop environments. */ }
}
async function isConversationVisible(data) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return (await Promise.all(clients.map(client => new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 250);
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data?.viewed === true); };
    client.postMessage({ type: 'notification:context', data }, [channel.port2]);
  })))).some(Boolean);
}
function notificationRecord(data) {
  return { sessionId: data.sessionId, id: data.eventId, createdAt: data.createdAt };
}
function atOrBefore(record, progress) {
  if (!record || !progress) return false;
  if (record.id === progress.id) return true;
  const time = Date.parse(record.createdAt);
  const boundary = Date.parse(progress.createdAt);
  // An undated legacy event cannot supersede known progress. Never substitute
  // its receipt time, which would make a delayed old push appear new.
  return Number.isFinite(boundary) && (!Number.isFinite(time) || time <= boundary);
}
async function closeReadNotifications(scope, progress) {
  const notifications = await self.registration.getNotifications();
  for (const notification of notifications) {
    const data = notification.data;
    if (data?.scope === scope && atOrBefore(notificationRecord(data), progress[data.sessionId])) notification.close();
  }
}
async function showNotificationOnce(payload, forwardToClients = false) {
  const data = payload.data || {};
  const record = notificationRecord({ ...data, eventId: data.eventId || payload.id,
    createdAt: data.createdAt || payload.event?.createdAt });
  const visible = await isConversationVisible(data);
  let accepted = false;
  let show = false;
  let silent = payload.silent === true;
  const state = await notificationState(state => {
    if (state.scope && data.scope && state.scope !== data.scope) return;
    const key = JSON.stringify([data.scope, data.sessionId, data.eventId || payload.id]);
    if (state.seen.includes(key)) return;
    state.seen.push(key);
    if (record.sessionId && record.id) {
      if (atOrBefore(record, state.readProgress[record.sessionId]) || atOrBefore(record, state.pending[record.sessionId])) return;
      if (visible) {
        state.readProgress[record.sessionId] = record;
        if (atOrBefore(state.pending[record.sessionId], record)) delete state.pending[record.sessionId];
      } else state.pending[record.sessionId] = record;
    }
    accepted = true;
    const preferences = state.preferences || payload.preferences || {};
    show = !visible && preferences.enabled !== false;
    silent = silent || preferences.sound === false || Date.now() - state.lastSound < 2000;
    if (show && !silent) state.lastSound = Date.now();
    // A stale push must not reveal previews after the local preference changed.
    if (preferences.preview === false && payload.event) {
      payload.body = payload.body.split('\n')[0];
    }
    return state;
  });
  if (state) {
    await updateNotificationBadge(state);
    if (visible) await closeReadNotifications(data.scope, state.readProgress);
  }
  // Rejected pushes must not re-enter the page's notification/badge path.
  if (accepted && forwardToClients && payload.event) {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: 'notification:received', notification: payload.event });
  }
  if (!show) return false;
  await self.registration.showNotification(payload.title || 'PilotDeck', {
    body: payload.body || '', icon: '/logo-256.png', badge: '/logo-128.png', data,
    tag: `${data.scope || ''}:${data.sessionId || 'global'}`, renotify: true, silent,
  });
  return true;
}

self.addEventListener('message', event => {
  const { type, value } = event.data || {};
  if (!type?.startsWith('notification:')) return;
  event.waitUntil(serializeNotifications(async () => {
    let result;
    if (type === 'notification:show') result = await showNotificationOnce(value);
    else if (type === 'notification:preferences') {
      await notificationState(state => {
        if (value.scope && state.scope && state.scope !== value.scope) { state.pending = {}; state.seen = []; state.readProgress = {}; }
        state.scope = value.scope || state.scope;
        state.preferences = value.preferences;
        return state;
      }).then(updateNotificationBadge);
      result = true;
    } else if (type === 'notification:pending') {
      result = await notificationState(state => value.scope === state.scope ? Object.values(state.pending) : []);
    } else if (type === 'notification:read') {
      const state = await notificationState(state => {
        if (value.scope !== state.scope) return state;
        for (const record of value.records || []) {
          if (!record.sessionId || !record.id) continue;
          const key = JSON.stringify([value.scope, record.sessionId, record.id]);
          if (!state.seen.includes(key)) state.seen.push(key);
          const pending = state.pending[record.sessionId];
          // Old pages send only the ID. Recover its timestamp when available.
          const progress = { ...record, createdAt: record.createdAt || (pending?.id === record.id ? pending.createdAt : undefined) };
          const previous = state.readProgress[record.sessionId];
          const enrich = previous?.id === progress.id && Number.isFinite(Date.parse(progress.createdAt)) &&
            (!Number.isFinite(Date.parse(previous.createdAt)) || Date.parse(progress.createdAt) > Date.parse(previous.createdAt));
          if (enrich || !atOrBefore(progress, previous)) state.readProgress[record.sessionId] = progress;
          if (atOrBefore(pending, state.readProgress[record.sessionId])) delete state.pending[record.sessionId];
        }
        return state;
      });
      await updateNotificationBadge(state);
      if (value.scope === state.scope) await closeReadNotifications(value.scope, state.readProgress);
      result = true;
    }
    event.ports[0]?.postMessage(result);
  }).catch(() => event.ports[0]?.postMessage(false)));
});

// Both live page events and Web Push go through the same persistent deduplication.
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'PilotDeck', body: event.data.text() };
  }

  event.waitUntil(serializeNotifications(async () => {
    await showNotificationOnce(payload, true);
  }));
});

// Notification click event
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const provider = event.notification.data?.provider || null;
  const urlPath = sessionId ? `/session/${encodeURIComponent(sessionId)}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          await client.focus();
          client.postMessage({
            type: 'notification:navigate',
            sessionId: sessionId || null,
            provider,
            scope: event.notification.data?.scope,
            eventId: event.notification.data?.eventId,
            urlPath
          });
          return;
        }
      }
      return self.clients.openWindow(urlPath);
    })
  );
});

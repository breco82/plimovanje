const CACHE_NAME = 'plima-tracker-v36';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './index.css',
  './index.js',
  './Arcots.js',
  './TideCalculator.js',
  './manifest.json',
  './icon.svg',
  'https://code.highcharts.com/stock/highstock.js',
  'https://code.highcharts.com/modules/exporting.js',
  'https://code.highcharts.com/modules/accessibility.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

// Install Event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('Caching shell assets...');
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event (Network First, falling back to cache if offline)
self.addEventListener('fetch', event => {
  // Avoid caching ARSO HTML tables or Bazdara API requests, we want live measurements
  if (event.request.url.includes('arso.gov.si') || event.request.url.includes('bazdara-99a47') || event.request.url.includes('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Clone response and cache it
        const resClone = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, resClone);
        });
        return response;
      })
      .catch(() => {
        // If network fails, serve from cache
        return caches.match(event.request);
      })
  );
});

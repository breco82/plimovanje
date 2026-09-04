const CACHE_NAME = 'plima-tracker-v48';
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

// Install Event - cache core shell immediately
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// Activate Event - purge outdated caches and claim clients immediately
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event - Stale-While-Revalidate for app assets, pure network for all APIs
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Never cache live measurement or forecast endpoints
  if (url.includes('arso.gov.si') || 
      url.includes('bazdara-99a47') || 
      url.includes('script.google.com') || 
      url.includes('open-meteo.com') || 
      url.includes('corsproxy.io') || 
      url.includes('allorigins.win') || 
      url.includes('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Stale-While-Revalidate for static assets (opens instantly < 50ms)
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      const fetchPromise = fetch(event.request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200) {
          const resClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, resClone);
          });
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});

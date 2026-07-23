const CACHE_NAME = 'theview-stock-v34.10.1-test-wjb-story';
const REQUIRED_ASSETS = [
  './',
  './index.html',
  './main.css?v=34.10.1-test',
  './app.js?v=34.10.1-test'
];
const OPTIONAL_ASSETS = [
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE_NAME);
    await cache.addAll(REQUIRED_ASSETS);
    await Promise.allSettled(OPTIONAL_ASSETS.map(asset=>cache.add(asset)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key!==CACHE_NAME).map(key=>caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event=>{
  if(event.data?.type==='SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  if(event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if(url.origin !== self.location.origin) return;

  const isDocument = event.request.mode === 'navigate' || event.request.destination === 'document';
  const isCode = ['script','style'].includes(event.request.destination);

  if(isDocument || isCode){
    event.respondWith((async()=>{
      try{
        const response=await fetch(event.request,{cache:'no-store'});
        if(response?.ok){
          const cache=await caches.open(CACHE_NAME);
          await cache.put(event.request,response.clone());
        }
        return response;
      }catch(_){
        return (await caches.match(event.request)) || (isDocument ? await caches.match('./index.html') : Response.error());
      }
    })());
    return;
  }

  event.respondWith((async()=>{
    const cached=await caches.match(event.request);
    if(cached) return cached;
    const response=await fetch(event.request);
    if(response?.ok){
      const cache=await caches.open(CACHE_NAME);
      await cache.put(event.request,response.clone());
    }
    return response;
  })());
});

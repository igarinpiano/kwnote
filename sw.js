// Offline cache for the app shell (only registered on https / localhost).
// Network first so updates show up immediately; the cache is the fallback.
var CACHE = "kwnote-v2";
var SHELL = ["index.htm", "script.js", "sync.js", "qr.js", "style.css", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener("activate", function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener("fetch", function(e){
  var url = new URL(e.request.url);
  if(e.request.method !== "GET" || url.origin !== location.origin || url.pathname.indexOf("/api/") !== -1) return;
  e.respondWith(fetch(e.request).then(function(res){
    if(res.ok){ var copy = res.clone(); caches.open(CACHE).then(function(c){ c.put(e.request, copy); }); }
    return res;
  }).catch(function(){
    return caches.match(e.request, {ignoreSearch: true}).then(function(hit){ return hit || caches.match("index.htm"); });
  }));
});

// Offline cache for the app shell (only registered on https / localhost).
// Network first, revalidating with the server every time (cheap 304s), so a
// deploy is picked up immediately instead of after the 10-minute HTTP cache
// of GitHub Pages. The cache is only the offline fallback.
var CACHE = "kwnote-v3";
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
  // a navigation Request can't be re-initialised, so rebuild it from the URL
  var req = e.request.mode === "navigate"
    ? new Request(e.request.url, {cache: "no-cache", credentials: "same-origin"})
    : new Request(e.request, {cache: "no-cache"});
  e.respondWith(fetch(req).then(function(res){
    if(res.ok){ var copy = res.clone(); caches.open(CACHE).then(function(c){ c.put(e.request, copy); }); }
    return res;
  }).catch(function(){
    return caches.match(e.request, {ignoreSearch: true}).then(function(hit){ return hit || caches.match("index.htm"); });
  }));
});

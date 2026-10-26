/* 玄机排盘 Service Worker：壳预缓存 + 缓存优先 + 后台更新
   策略：
   - 页面导航与同源静态资源：缓存优先，命中即出；命中后后台按 ETag 重验证并更新缓存。
     未命中走网络并写入缓存，断网回落已缓存页与资源。
   - 预取：首屏加载后由 app.js 逐页请求全站 HTML，本件按静态资源路径缓存，后续导航直接命中缓存。
   - 跨域请求（节假日、IP 归属、地磁、AI 接口等外部数据源）一律不拦截，直连网络。
   - 预缓存逐项 cache.add 并容忍单项失败，避免任一资源波动导致安装整体失败。
   版本升级：CACHE 名尾号递增，activate 时清除旧仓。 */
const CACHE = 'xj-shell-v25';
/* 壳只预缓存"打开就能看"的最小集：页面、清单、框架脚本、界面字体与当年农历表。
   历法整包与各页术语数据按 visit 时进运行时缓存，不在这里抢首访带宽。 */
const SHELL = [
  './',
  './index.html',
  './404.html',
  './manifest.webmanifest',
  './assets/meta.js',
  './assets/app.js',
  './assets/fonts/noto-serif-sc.css',
  './assets/fonts/nssc-chrome.woff2',
  './assets/fonts/site-sym.css',
  './assets/lunar-today-2026.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.allSettled(SHELL.map(function (u) { return c.add(u); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;               /* 跨域数据接口直连 */
  if (req.headers.get('range')) return;                     /* 分段请求不缓存 */

  e.respondWith((async function () {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res && res.ok && (res.type === 'basic' || res.type === 'default')) {
        const cp = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, cp); });
      }
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        return (await caches.match('./index.html')) || Response.error();
      }
      return (await caches.match(req)) || Response.error();
    }
  })());

  /* 命中缓存后仍按 ETag 重验证，缓存随源更新。 */
  e.waitUntil((async function () {
    const hit = await caches.match(req);
    if (!hit) return;
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res && res.ok) {
        const cp = res.clone();
        const c = await caches.open(CACHE);
        await c.put(req, cp);
      }
    } catch (err) { /* 后台更新失败，保留旧缓存 */ }
  })());
});

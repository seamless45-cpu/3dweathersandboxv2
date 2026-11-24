import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const src = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const listeners = {};
const calls = { put: [], match: [], deleted: [], fetched: [], skipped: false, claimed: false };
let networkUp = true;

class FakeCache {
  constructor(name) { this.name = name; this.entries = new Map(); }
  async put(request, response) {
    const url = typeof request === 'string' ? request : request.url;
    if (response.status === 206) throw new TypeError('206 is not cacheable');
    this.entries.set(url, response);
    calls.put.push({ cache: this.name, url });
  }
  async match(request) {
    const url = typeof request === 'string' ? request : request.url;
    calls.match.push({ cache: this.name, url });
    return this.entries.get(url) ?? undefined;
  }
}
const caches = new Map();
const cacheStorage = {
  async open(name) { if (!caches.has(name)) caches.set(name, new FakeCache(name)); return caches.get(name); },
  async keys() { return [...caches.keys()]; },
  async delete(name) { caches.delete(name); calls.deleted.push(name); return true; },
};

const scopeHref = 'https://example.github.io/3dweathersandboxv2/';
const registration = { scope: scopeHref };

function makeResponse(body, { ok = true, type = 'basic', status = 200, url = '' } = {}) {
  return { ok, type, status, _body: body, url, clone() { return makeResponse(body, { ok, type, status, url }); } };
}

async function fetchImpl(input) {
  const url = typeof input === 'string' ? input : input.url;
  calls.fetched.push(url);
  if (!networkUp) throw new TypeError('Failed to fetch');
  if (url.includes('icon-512.png') && globalThis.__failUrl) return makeResponse('', { ok: false, status: 404 });
  return makeResponse(`body:${url}`, { url });
}

class FakeResponse {
  constructor(body, init = {}) { this._body = body; this.status = init.status ?? 200; this.statusText = init.statusText ?? ''; this.ok = this.status >= 200 && this.status < 300; }
}

const self = {
  registration,
  location: { origin: 'https://example.github.io' },
  addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
  skipWaiting: async () => { calls.skipped = true; },
  clients: { claim: async () => { calls.claimed = true; } },
};

const context = vm.createContext({
  self, caches: cacheStorage, fetch: fetchImpl, Response: FakeResponse,
  console, URL, Promise, TypeError, Error, setTimeout,
});
vm.runInContext(src, context, { filename: 'sw.js' });

async function dispatch(type, event) {
  const pending = [];
  const evt = { ...event, waitUntil: (p) => pending.push(p) };
  for (const fn of listeners[type] ?? []) fn(evt);
  await Promise.allSettled(pending);
  return evt;
}

const results = [];
const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail });

await dispatch('install', {});
check('install calls skipWaiting', calls.skipped);
const shell = caches.get('meteolab-shell-v1');
check('install created the versioned cache', !!shell);
check('install precached 8 entries', shell?.entries.size === 8, `got ${shell?.entries.size}`);
check('precache keyed to scope root', [...(shell?.entries.keys() ?? [])].includes(scopeHref + 'manifest.webmanifest'));

globalThis.__failUrl = true;
const sizeBefore = shell?.entries.size ?? 0;
await dispatch('install', {});
check('install tolerates a failed asset', (shell?.entries.size ?? 0) >= sizeBefore - 1, 'install aborted on a 404');
globalThis.__failUrl = false;

caches.set('meteolab-shell-v0', new FakeCache('meteolab-shell-v0'));
caches.set('unrelated-cache', new FakeCache('unrelated-cache'));
await dispatch('activate', {});
check('activate deletes the previous shell', calls.deleted.includes('meteolab-shell-v0'));
check('activate leaves unrelated caches alone', !calls.deleted.includes('unrelated-cache'));
check('activate claims clients', calls.claimed);

let responded;
await dispatch('fetch', { request: { method: 'GET', mode: 'navigate', url: scopeHref }, respondWith: (p) => { responded = p; } });
let res = await responded;
check('navigation goes to the network when online', res._body.startsWith('body:'), res._body);
check('navigation response is cached for offline', [...(shell?.entries.keys() ?? [])].includes(scopeHref));

networkUp = false;
calls.match.length = 0;
await dispatch('fetch', { request: { method: 'GET', mode: 'navigate', url: scopeHref + '?preset=supercell_alley' }, respondWith: (p) => { responded = p; } });
res = await responded;
check('offline navigation serves the cached shell', res._body.startsWith('body:'), res._body);
check('offline navigation keyed to scope root, ignoring the query', calls.match.some((m) => m.url === scopeHref), JSON.stringify(calls.match.slice(-3)));

caches.delete('meteolab-shell-v1');
await dispatch('fetch', { request: { method: 'GET', mode: 'navigate', url: scopeHref }, respondWith: (p) => { responded = p; } });
let threw = false;
try { await responded; } catch { threw = true; }
check('offline with no cache rejects (browser shows its offline page)', threw);

networkUp = true;
caches.set('meteolab-shell-v1', new FakeCache('meteolab-shell-v1'));
const fresh = caches.get('meteolab-shell-v1');
await fresh.put(scopeHref + 'icons/icon-192.png', makeResponse('cached-icon'));
await dispatch('fetch', { request: { method: 'GET', mode: 'cors', url: scopeHref + 'icons/icon-192.png' }, respondWith: (p) => { responded = p; } });
res = await responded;
check('cached asset served from cache', res._body === 'cached-icon', res._body);

networkUp = false;
await dispatch('fetch', { request: { method: 'GET', mode: 'cors', url: scopeHref + 'icons/icon-512.png' }, respondWith: (p) => { responded = p; } });
res = await responded;
check('missing asset offline yields a 504 rather than throwing', res.status === 504, `status ${res.status}`);

let intercepted = false;
await dispatch('fetch', { request: { method: 'GET', mode: 'cors', url: 'https://cdn.example.com/x.js' }, respondWith: () => { intercepted = true; } });
check('cross-origin requests are not intercepted', !intercepted);

intercepted = false;
await dispatch('fetch', { request: { method: 'POST', mode: 'cors', url: scopeHref + 'api' }, respondWith: () => { intercepted = true; } });
check('non-GET requests are not intercepted', !intercepted);

let posted = null;
const port = { postMessage: (m) => { posted = m; } };
let skipAfterMessage = false;
const savedSkip = self.skipWaiting;
self.skipWaiting = async () => { skipAfterMessage = true; };
for (const fn of listeners.message ?? []) fn({ data: { type: 'GET_VERSION' }, ports: [port] });
check('GET_VERSION returns the cache name', posted?.cache === 'meteolab-shell-v1', JSON.stringify(posted));
for (const fn of listeners.message ?? []) fn({ data: { type: 'SKIP_WAITING' }, ports: [] });
await new Promise((r) => setTimeout(r, 0));
check('SKIP_WAITING activates the waiting worker', skipAfterMessage);
self.skipWaiting = savedSkip;

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `  [${r.detail}]`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

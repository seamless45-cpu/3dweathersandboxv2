// Exercises src/pwa.ts in a simulated browser: no DOM, just the globals the module reads.
//
// Run after `npm run build:pages` (it bundles the module itself, so it needs no build).
import { build } from 'esbuild';
import vm from 'node:vm';

const bundled = await build({
  entryPoints: ['src/pwa.ts'],
  bundle: true, write: false, format: 'iife', globalName: 'PWA', platform: 'browser',
  logLevel: 'error',
});
const code = bundled.outputFiles[0].text;

function makeEnv({ standalone = false, ios = false, online = true, storage = new Map() } = {}) {
  const handlers = {};
  const mediaMatches = standalone;
  const listeners = [];
  const windowObj = {
    location: {
      protocol: 'https:', href: 'https://example.github.io/3dweathersandboxv2/',
      search: '', pathname: '/3dweathersandboxv2/', hash: '',
    },
    history: {
      // A real replaceState rewrites the whole location, query included. The mock must do the
      // same or the "consumed once" behaviour cannot be observed.
      replaceState: (_a, _b, url) => {
        const u = new URL(url, 'https://example.github.io');
        windowObj.location.href = u.href;
        windowObj.location.search = u.search;
        windowObj.location.pathname = u.pathname;
        windowObj.location.hash = u.hash;
      },
    },
    addEventListener: (t, fn) => { (handlers[t] ??= []).push(fn); },
    matchMedia: (q) => ({ matches: q.includes('standalone') ? mediaMatches : false, addEventListener: () => {} }),
    navigator: {
      userAgent: ios ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' : 'Mozilla/5.0 (X11; Linux x86_64)',
      platform: ios ? 'iPhone' : 'Linux x86_64',
      maxTouchPoints: ios ? 5 : 0,
      onLine: online,
      serviceWorker: {
        controller: null,
        register: async () => ({ scope: '/3dweathersandboxv2/', waiting: null, installing: null, active: {}, addEventListener: () => {}, update: async () => {} }),
        addEventListener: (t, fn) => listeners.push([t, fn]),
      },
    },
  };
  if (standalone) windowObj.navigator.standalone = true;
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
  };
  const ctx = vm.createContext({
    window: windowObj, document: { readyState: 'complete', addEventListener: () => {}, visibilityState: 'visible' },
    navigator: windowObj.navigator, localStorage, console, URL, URLSearchParams, Promise, Math, Object, Array, Set, Map, String, Number, Boolean, Error, TypeError, JSON,
  });
  vm.runInContext(code, ctx, { filename: 'pwa.js' });
  return { PWA: ctx.PWA, windowObj, handlers, storage, listeners };
}

const results = [];
const check = (n, ok, d = '') => results.push({ n, ok, d });

// ---- initial state --------------------------------------------------------------------------
{
  const { PWA } = makeEnv();
  PWA.initPwa();
  const s = PWA.getPwaSnapshot();
  check('starts not-installable in a browser tab', s.installState === 'unsupported', s.installState);
  check('standalone is false in a tab', s.standalone === false);
}

// ---- beforeinstallprompt makes it installable ------------------------------------------------
{
  const { PWA, handlers } = makeEnv();
  PWA.initPwa();
  let prevented = false;
  const promptFn = async () => {};
  const event = { preventDefault: () => { prevented = true; }, prompt: promptFn, userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }) };
  for (const fn of handlers['beforeinstallprompt'] ?? []) fn(event);
  check('beforeinstallprompt is suppressed', prevented);
  check('install becomes available', PWA.getPwaSnapshot().installState === 'available');
  check('canInstall() reports true', PWA.canInstall() === true);
}

// ---- accepting the prompt -------------------------------------------------------------------
{
  const { PWA, handlers } = makeEnv();
  PWA.initPwa();
  const event = { preventDefault() {}, prompt: async () => {}, userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }) };
  for (const fn of handlers['beforeinstallprompt'] ?? []) fn(event);
  const outcome = await PWA.promptInstall();
  check('accepting the prompt resolves "accepted"', outcome === 'accepted', outcome);
  check('accepting marks the app installed', PWA.getPwaSnapshot().installState === 'installed');
  check('canInstall() false afterwards', PWA.canInstall() === false);
}

// ---- dismissing persists across reloads ------------------------------------------------------
{
  const storage = new Map();
  const first = makeEnv({ storage });
  first.PWA.initPwa();
  const event = { preventDefault() {}, prompt: async () => {}, userChoice: Promise.resolve({ outcome: 'dismissed' }) };
  for (const fn of first.handlers['beforeinstallprompt'] ?? []) fn(event);
  const outcome = await first.PWA.promptInstall();
  check('dismissing resolves "dismissed"', outcome === 'dismissed', outcome);
  check('dismissal is written to storage', storage.get('meteolab.pwa.installDismissed') === '1');
  // Reload: a fresh module instance with the same storage.
  const second = makeEnv({ storage });
  second.PWA.initPwa();
  check('dismissal survives a reload', second.PWA.getPwaSnapshot().installState === 'dismissed');
  // A new prompt event must not override the stored choice.
  for (const fn of second.handlers['beforeinstallprompt'] ?? []) fn(event);
  check('a later prompt does not un-dismiss', second.PWA.getPwaSnapshot().installState === 'dismissed');
}

// ---- standalone detection --------------------------------------------------------------------
{
  const { PWA } = makeEnv({ standalone: true });
  PWA.initPwa();
  check('installed app is detected as standalone', PWA.getPwaSnapshot().standalone === true);
  check('installed app reports installed', PWA.getPwaSnapshot().installState === 'installed');
}

// ---- offline events --------------------------------------------------------------------------
{
  const { PWA, handlers, windowObj } = makeEnv({ online: true });
  PWA.initPwa();
  check('starts online', PWA.getPwaSnapshot().offline === false);
  windowObj.navigator.onLine = false;
  for (const fn of handlers['offline'] ?? []) fn({});
  check('offline event updates state', PWA.getPwaSnapshot().offline === true);
  windowObj.navigator.onLine = true;
  for (const fn of handlers['online'] ?? []) fn({});
  check('online event clears it', PWA.getPwaSnapshot().offline === false);
}

// ---- iOS manual install ----------------------------------------------------------------------
{
  const { PWA } = makeEnv({ ios: true });
  PWA.initPwa();
  check('iOS reports a manual install path', PWA.isIosSafari() === true);
  const desktop = makeEnv();
  desktop.PWA.initPwa();
  check('desktop does not report iOS', desktop.PWA.isIosSafari() === false);
  const installedIos = makeEnv({ ios: true, standalone: true });
  installedIos.PWA.initPwa();
  check('installed iOS app offers no manual prompt', installedIos.PWA.isIosSafari() === false);
}

// ---- snapshot identity (useSyncExternalStore requires a new object only on change) -----------
{
  const { PWA } = makeEnv();
  PWA.initPwa();
  const a = PWA.getPwaSnapshot();
  let calls = 0;
  const unsub = PWA.subscribePwa(() => { calls++; });
  // Setting the same value must not notify.
  a.offline = false;
  check('no notification for a no-op change', calls === 0, `calls=${calls}`);
  unsub();
}

// ---- preset launch URL -----------------------------------------------------------------------
{
  const { PWA, windowObj } = makeEnv();
  windowObj.location.search = '?preset=supercell_alley&x=1';
  windowObj.location.href = 'https://example.github.io/3dweathersandboxv2/?preset=supercell_alley&x=1';
  const preset = PWA.takePresetFromUrl();
  check('launch preset is read from the URL', preset === 'supercell_alley', preset);
  check('launch preset is stripped from the address bar', windowObj.location.href === 'https://example.github.io/3dweathersandboxv2/?x=1', windowObj.location.href);
  const again = PWA.takePresetFromUrl();
  check('a second call finds no preset', again === null, again);
}

let failed = 0;
for (const r of results) { if (!r.ok) failed++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${r.ok ? '' : `  [${r.d}]`}`); }
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

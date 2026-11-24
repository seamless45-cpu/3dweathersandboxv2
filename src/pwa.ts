/**
 * Progressive-web-app plumbing: service-worker registration, the install prompt, offline
 * detection and update notification.
 *
 * Deliberately framework-free and dependency-free. It is imported for its side effects from
 * `main.tsx` and publishes state through a tiny subscribe/snapshot store, so the React tree can
 * use it via `useSyncExternalStore` without any provider, context or extra bundle weight.
 *
 * The service worker itself lives in `public/sw.js` and is copied verbatim into the build. It
 * has to: the single-file build inlines every module into `index.html`, so a worker generated
 * from a source module would be inlined into the document and never registered as a worker.
 */

export type InstallState = 'unsupported' | 'available' | 'manual' | 'installed' | 'dismissed';
export type SwState = 'unsupported' | 'registering' | 'ready' | 'update' | 'error';

export interface PwaSnapshot {
  /** Whether the browser offers an install prompt right now. */
  installState: InstallState;
  /** True when running as an installed app rather than a browser tab. */
  standalone: boolean;
  /** Service-worker lifecycle. */
  swState: SwState;
  /** A new build has been fetched and is waiting to take over. */
  updateReady: boolean;
  /** The browser reports no network connection. */
  offline: boolean;
  /** Populated when registration fails, for the settings panel. */
  error: string | null;
}

/**
 * The `beforeinstallprompt` event is not in the DOM lib. Chromium fires it with a `prompt()`
 * method and a `userChoice` promise; Firefox and Safari simply never fire it.
 */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

const DISMISS_KEY = 'meteolab.pwa.installDismissed';

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // iOS Safari predates `display-mode: standalone` in some versions and exposes navigator.standalone.
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  let matchesMedia = false;
  try {
    matchesMedia = window.matchMedia?.('(display-mode: standalone)').matches === true;
  } catch {
    // A restricted document (sandboxed iframe, some kiosk shells) can throw here. Running as an
    // installed app is a nice-to-have, not a reason to fail to boot.
  }
  return matchesMedia || iosStandalone;
}

/**
 * Reads a persisted flag without ever throwing.
 *
 * `localStorage` is not merely absent in some contexts — referencing it is fine, but *calling*
 * it throws a `SecurityError` when cookies/site-data are blocked, in Safari private browsing on
 * older iOS, in a sandboxed iframe, and in some enterprise kiosk profiles. `initialState()` runs
 * at module scope, before React has mounted, so an exception here aborts `main.tsx` entirely and
 * the user is left staring at a blank white page with no error and no way to recover. That is
 * exactly what a "white box" report looks like, so every storage access is fenced off.
 */
function readFlag(key: string): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function initialState(): PwaSnapshot {
  const installed = detectStandalone();
  const dismissed = readFlag(DISMISS_KEY);
  return {
    installState: installed ? 'installed' : dismissed ? 'dismissed' : 'unsupported',
    standalone: installed,
    swState: 'unsupported',
    updateReady: false,
    offline: typeof navigator !== 'undefined' && navigator.onLine === false,
    error: null,
  };
}

let snapshot: PwaSnapshot = initialState();
let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<PwaSnapshot>): void {
  const next = { ...snapshot, ...patch };
  // Avoid re-rendering the whole UI on no-op updates: `useSyncExternalStore` compares by
  // identity, so every emitted object must be a genuinely new state or the same one.
  const changed = (Object.keys(patch) as (keyof PwaSnapshot)[]).some(
    (key) => snapshot[key] !== next[key]
  );
  if (!changed) return;
  snapshot = next;
  for (const fn of listeners) fn();
}

export function subscribePwa(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getPwaSnapshot(): PwaSnapshot {
  return snapshot;
}

/** True where the browser can genuinely install the app (drives whether the button is offered). */
export function canInstall(): boolean {
  return deferredPrompt !== null && snapshot.installState === 'available';
}

/**
 * iOS and iPadOS never fire `beforeinstallprompt` — installation is done from the Share sheet.
 * Detecting that lets the UI explain how, instead of the app silently having no install path on
 * a platform where installing to the home screen is the normal way to use a web app.
 */
export function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!iOS) return false;
  // Every browser on iOS is WebKit, so the Share-sheet instructions apply to all of them.
  return !snapshot.standalone;
}

/**
 * Shows the browser's install prompt. Must be called from a user gesture: Chromium rejects a
 * programmatic prompt that is not inside one.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferredPrompt;
  if (!event) return 'unavailable';
  deferredPrompt = null;
  try {
    await event.prompt();
    const choice = await event.userChoice;
    if (choice.outcome === 'accepted') {
      set({ installState: 'installed', standalone: true });
    } else {
      set({ installState: 'dismissed' });
      try {
        localStorage.setItem(DISMISS_KEY, '1');
      } catch {
        /* private mode: the dismissal simply does not persist */
      }
    }
    return choice.outcome;
  } catch (err) {
    set({ error: err instanceof Error ? err.message : String(err) });
    return 'unavailable';
  }
}

/** The active registration, once `registerServiceWorker` has resolved. */
let registration: ServiceWorkerRegistration | null = null;

/** Ask the waiting service worker to activate now and reload into the new build. */
export function applyUpdate(): void {
  const waiting = registration?.waiting;
  if (!waiting) {
    window.location.reload();
    return;
  }
  // `controllerchange` fires once the new worker has claimed the page; reloading there is more
  // reliable than racing the message with a fixed timeout.
  navigator.serviceWorker.addEventListener(
    'controllerchange',
    () => window.location.reload(),
    { once: true }
  );
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

async function registerServiceWorker(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    set({ swState: 'unsupported' });
    return;
  }

  // A worker only makes sense over HTTPS or on localhost. Vite's dev server qualifies, but the
  // preview origin is HTTPS, and a `file://` open has no service worker at all.
  if (window.location.protocol === 'file:') {
    set({ swState: 'unsupported' });
    return;
  }

  set({ swState: 'registering' });
  try {
    // The worker is resolved relative to the *document*, not to `BASE_URL` or the injected `base`.
    //
    // On GitHub Pages the app is served from the repository root
    // (https://<user>.github.io/3dweathersandboxv2/), and `scripts/copyPagesBuild.mjs` copies only
    // the inlined HTML to the repository root while the PWA assets are copied alongside it. The
    // built HTML references its manifest as "./manifest.webmanifest", i.e. relative to the page.
    // Registering against an absolute BASE_URL-derived path instead would put the worker at a
    // path where no file exists under the Pages layout, and would give it a scope the manifest
    // does not live under — which browsers reject for installation purposes.
    //
    // "./" makes the worker's scope the page's own directory in every deployment: the origin root
    // for a local build, "/3dweathersandboxv2/" on Pages, and relative to the document during
    // `vite dev`. The worker is allowed to claim its own directory, so the scope is valid.
    const swUrl = new URL('./sw.js', window.location.href).href;
    const scope = new URL('./', window.location.href).href;
    const reg = await navigator.serviceWorker.register(swUrl, { scope });
    registration = reg;

    if (reg.waiting && navigator.serviceWorker.controller) {
      set({ swState: 'update', updateReady: true });
    } else {
      set({ swState: 'ready' });
    }

    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        // "installed" with an existing controller means this is an update, not a first install.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          set({ swState: 'update', updateReady: true });
        }
        // A worker that fails to install (a syntax error, a 404 on sw.js, a rejected install
        // handler) becomes `redundant`. There is no `updatefailed` event — the page would
        // otherwise stay on the old build with no indication that the new one was dropped.
        if (installing.state === 'redundant' && reg.waiting === null && reg.active) {
          set({ swState: 'error', error: 'The new service worker failed to install; still serving the previous build.' });
        }
      });
    });

    // Check for a new deployment when the tab regains focus, so a long-lived session notices.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  } catch (err) {
    set({
      swState: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Wire up every browser event the UI needs. Safe to call once, from `main.tsx`. */
export function initPwa(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('beforeinstallprompt', (event) => {
    // Suppress Chrome's own mini-infobar; the in-app strip is the affordance.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    // Respect a previous dismissal *across reloads*. Without this the persisted choice was
    // written but never read again, because every fresh `beforeinstallprompt` reset the state to
    // "available" — so the strip reappeared on every visit no matter what the user chose. The
    // browser's own "Install app" menu entry is untouched, so dismissing our strip never makes
    // the app un-installable.
    if (snapshot.installState !== 'installed' && snapshot.installState !== 'dismissed') {
      set({ installState: 'available' });
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    set({ installState: 'installed', standalone: true });
  });

  window.addEventListener('online', () => set({ offline: false }));
  window.addEventListener('offline', () => set({ offline: true }));

  // Every browser event above is optional chrome on top of the simulation: if the platform
  // refuses to hand one over, booting must still continue. This listener used to be a bare
  // chained call, so a thrown `matchMedia` (sandboxed document, restricted profile) aborted
  // `initPwa()` — and with it the whole of `main.tsx` — leaving a blank page.
  try {
    window
      .matchMedia?.('(display-mode: standalone)')
      .addEventListener?.('change', (event) => {
        set({
          standalone: event.matches,
          installState: event.matches ? 'installed' : snapshot.installState,
        });
      });
  } catch {
    /* display-mode changes are cosmetic; ignore a document that will not report them */
  }

  // The service worker must not delay first paint; the app is already interactive by the time it
  // registers, and `load` fires after the WebGL scene has had its first frame.
  if (document.readyState === 'complete') {
    void registerServiceWorker();
  } else {
    window.addEventListener('load', () => void registerServiceWorker(), { once: true });
  }
}

/**
 * Reads `?preset=` from the URL so an installed shortcut can launch straight into a scenario.
 * Returns the matching preset id, or null. The query is then removed from the address bar so a
 * later reload does not silently re-apply the preset over the user's edits.
 */
export function takePresetFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const preset = params.get('preset');
  if (!preset) return null;
  params.delete('preset');
  const query = params.toString();
  const clean = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  try {
    window.history.replaceState(null, '', clean);
  } catch {
    /* history can be unavailable in a sandboxed frame; the preset still applies */
  }
  return preset;
}

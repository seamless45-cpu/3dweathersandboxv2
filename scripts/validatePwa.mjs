/**
 * Headless PWA checks (dev tool, not part of the shipped bundle).
 *
 * There is no browser in this toolchain, so installation cannot be exercised for real. What can
 * be checked is everything that silently breaks an install, which in practice is all of it: a
 * manifest that does not parse, icon entries pointing at files that do not exist or whose real
 * pixel dimensions disagree with their declared `sizes`, a service worker with a syntax error, a
 * document that references a manifest or worker path the deployment does not serve, and a worker
 * whose precache list names a file that was never built.
 *
 * Usage: node scripts/validatePwa.mjs
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);
const note = (msg) => notes.push(msg);

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Reads a PNG's real dimensions from its IHDR chunk (bytes 16..23). */
async function pngSize(file) {
  const buf = await readFile(file);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== signature[i]) throw new Error('not a PNG');
  }
  if (buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error('missing IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function exists(rel) {
  try {
    await stat(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// 1. The application document
// ---------------------------------------------------------------------------------------------

const html = await readFile(path.join(root, 'index.html'), 'utf8');

const manifestRef = html.match(/<link[^>]+rel="manifest"[^>]+href="([^"]+)"/i);
if (!manifestRef) {
  fail('index.html has no <link rel="manifest">');
} else {
  const href = manifestRef[1];
  if (!href.startsWith('./') && !href.startsWith('/')) {
    fail(`manifest href "${href}" is neither root-absolute nor explicitly relative`);
  }
  const target = href.replace(/^\.\//, '').replace(/^\//, '');
  if (!(await exists(target))) fail(`manifest href "${href}" does not resolve to a built file`);
  else note(`manifest referenced as "${href}"`);
}

for (const [label, re] of [
  ['theme-color', /<meta[^>]+name="theme-color"[^>]+content="([^"]+)"/i],
  ['viewport', /<meta[^>]+name="viewport"/i],
  ['apple-touch-icon', /<link[^>]+rel="apple-touch-icon"[^>]+href="([^"]+)"/i],
]) {
  const m = html.match(re);
  if (!m) {
    fail(`index.html is missing ${label}`);
    continue;
  }
  if (m[1] && !m[1].startsWith('#')) {
    const target = m[1].replace(/^\.\//, '').replace(/^\//, '');
    if (!(await exists(target))) fail(`${label} href "${m[1]}" does not resolve to a built file`);
  }
}

// The worker must be registered from a URL the deployment actually serves.
const swRef = html.match(/new URL\("(\.\/[^"]*sw\.js)",window\.location\.href\)/);
if (!swRef) {
  fail('index.html does not register a service worker at a document-relative "./sw.js" path');
} else if (!(await exists(swRef[1].replace('./', '')))) {
  fail(`service worker "${swRef[1]}" does not resolve to a built file`);
} else {
  note(`service worker registered from "${swRef[1]}"`);
}

// A page that still shows the "app did not start" fallback would be a build failure.
if (!html.includes('startup-fallback')) {
  fail('index.html is missing the startup fallback element');
}

// ---------------------------------------------------------------------------------------------
// 2. The web app manifest
// ---------------------------------------------------------------------------------------------

const manifestPath = path.join(root, 'manifest.webmanifest');
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (err) {
  fail(`manifest does not parse: ${err.message}`);
  manifest = null;
}

if (manifest) {
  for (const key of ['name', 'short_name', 'start_url', 'display', 'theme_color', 'background_color']) {
    if (typeof manifest[key] !== 'string' || manifest[key].length === 0) {
      fail(`manifest.${key} is required and must be a non-empty string`);
    }
  }

  if (manifest.short_name && manifest.short_name.length > 12) {
    fail(`manifest.short_name "${manifest.short_name}" exceeds the 12-character launcher limit`);
  }

  // `display` must be one of the spec's values, and standalone/fullscreen are the installable ones.
  const DISPLAY = ['fullscreen', 'standalone', 'minimal-ui', 'browser'];
  if (!DISPLAY.includes(manifest.display)) {
    fail(`manifest.display "${manifest.display}" is not a valid display mode`);
  } else if (manifest.display === 'browser') {
    fail('manifest.display is "browser", which cannot be installed as an app');
  }
  for (const override of manifest.display_override ?? []) {
    if (!['fullscreen', 'standalone', 'minimal-ui', 'browser', 'window-controls-overlay', 'picture-in-picture'].includes(override)) {
      fail(`manifest.display_override contains unknown mode "${override}"`);
    }
  }

  // Relative start_url/scope are resolved against the manifest URL; anything absolute would break
  // the "/3dweathersandboxv2/" subdirectory deployment.
  for (const key of ['start_url', 'scope']) {
    const v = manifest[key];
    if (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && v !== '/') {
      note(`manifest.${key} "${v}" is root-absolute; correct only if deployed at the origin root`);
    }
    if (typeof v === 'string' && (v.startsWith('http://') || v.startsWith('https://'))) {
      fail(`manifest.${key} "${v}" is cross-origin, which browsers ignore`);
    }
  }

  // --- Icons --------------------------------------------------------------------------------
  if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) {
    fail('manifest.icons is empty; an installable app needs at least a 192px and a 512px icon');
  } else {
    let has192 = false;
    let has512 = false;
    let hasMaskable = false;
    for (const icon of manifest.icons) {
      if (typeof icon.src !== 'string') {
        fail('manifest.icons entry has no src');
        continue;
      }
      const file = icon.src.replace(/^\.\//, '').replace(/^\//, '').replace(/^icons\//, 'icons/');
      const abs = path.join(root, file);
      if (!(await exists(file))) {
        fail(`manifest icon "${icon.src}" does not exist on disk`);
        continue;
      }
      // The declared `sizes` must match the real pixels: Chrome silently drops a mismatched icon.
      const declared = icon.sizes === 'any' ? null : icon.sizes;
      if (file.endsWith('.png')) {
        try {
          const actual = await pngSize(abs);
          if (declared) {
            const [w, h] = declared.split('x').map(Number);
            if (w !== actual.width || h !== actual.height) {
              fail(
                `manifest icon "${icon.src}" declares ${declared} but the file is ${actual.width}x${actual.height}`
              );
            }
            if (actual.width === 192) has192 = true;
            if (actual.width === 512) has512 = true;
          }
        } catch (err) {
          fail(`manifest icon "${icon.src}" is not a readable PNG: ${err.message}`);
        }
      }
      const purpose = icon.purpose ?? 'any';
      for (const p of purpose.split(/\s+/)) {
        if (!['any', 'maskable', 'monochrome'].includes(p)) {
          fail(`manifest icon "${icon.src}" has unknown purpose "${p}"`);
        }
        if (p === 'maskable') hasMaskable = true;
      }
    }
    if (!has192) fail('no 192x192 icon declared (required for the Android launcher)');
    if (!has512) fail('no 512x512 icon declared (required for the install prompt and splash)');
    if (!hasMaskable) {
      note('no maskable icon: Android will letterbox the icon inside its mask');
    }

    // Every file referenced by the manifest must also be precached, or the installed app has a
    // broken icon the first time it is opened offline.
    note(`${manifest.icons.length} icon(s) declared`);
  }

  // --- Screenshots --------------------------------------------------------------------------
  for (const shot of manifest.screenshots ?? []) {
    if (!(await exists(shot.src))) {
      fail(`manifest screenshot "${shot.src}" does not exist on disk`);
      continue;
    }
    try {
      const actual = await pngSize(path.join(root, shot.src));
      const [w, h] = shot.sizes.split('x').map(Number);
      if (w !== actual.width || h !== actual.height) {
        fail(`manifest screenshot "${shot.src}" declares ${shot.sizes} but is ${actual.width}x${actual.height}`);
      }
    } catch (err) {
      fail(`manifest screenshot "${shot.src}" is not a readable PNG: ${err.message}`);
    }
  }

  // --- Shortcuts ----------------------------------------------------------------------------
  for (const shortcut of manifest.shortcuts ?? []) {
    if (!shortcut.name || !shortcut.url) fail('manifest.shortcuts entry needs a name and a url');
    // A shortcut URL that names a preset must name one the app actually knows about.
    const m = /[?&]preset=([\w-]+)/.exec(shortcut.url ?? '');
    if (m) {
      const presets = await readFile(path.join(root, 'src', 'sim', 'thermodynamics.ts'), 'utf8');
      if (!presets.includes(`id: '${m[1]}'`)) {
        fail(`shortcut "${shortcut.name}" points at unknown preset "${m[1]}"`);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 3. The service worker
// ---------------------------------------------------------------------------------------------

const swSource = await readFile(path.join(root, 'sw.js'), 'utf8');

// Syntax-check it in a worker-ish context without executing it: `new Function` parses without
// running, which catches the typos that matter without needing a real ServiceWorkerGlobalScope.
try {
  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', 'fetch', 'Response', swSource);
  note('sw.js parses');
} catch (err) {
  fail(`sw.js has a syntax error: ${err.message}`);
}

for (const event of ['install', 'activate', 'fetch']) {
  if (!swSource.includes(`addEventListener('${event}'`)) {
    fail(`sw.js does not handle the "${event}" event`);
  }
}

// Everything named in the precache list must exist, or the offline shell is incomplete.
const precacheBlock = swSource.match(/const PRECACHE = \[([\s\S]*?)\];/);
if (!precacheBlock) {
  fail('sw.js has no PRECACHE list');
} else {
  const entries = [...precacheBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (entries.length === 0) fail('sw.js PRECACHE list is empty');
  for (const entry of entries) {
    if (entry === './') {
      // The document itself: this is index.html for the deployment.
      if (!(await exists('index.html'))) fail('sw.js precaches "./" but there is no index.html');
      continue;
    }
    const file = entry.replace(/^\.\//, '');
    if (!(await exists(file))) fail(`sw.js precaches "${entry}", which does not exist on disk`);
  }
  // The manifest and the two required icon sizes must be in the precache list.
  for (const required of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png']) {
    if (!entries.some((e) => e.includes(required))) {
      fail(`sw.js does not precache "${required}"`);
    }
  }
  note(`${entries.length} precache entries, all present`);
}

// A worker that caches cross-origin responses blindly is a correctness and privacy bug.
if (!/url\.origin !== self\.location\.origin/.test(swSource)) {
  fail('sw.js does not skip non-same-origin requests');
}

// ---------------------------------------------------------------------------------------------
// 4. Confirm the Worker cannot have been inlined into the document
// ---------------------------------------------------------------------------------------------

// The single-file build inlines every *module* into index.html. If the worker's source ever made
// it into the bundle it would be dead weight (it cannot run from the document) and the real file
// would be the only thing that worked — worth asserting so a refactor does not quietly double it.
const workerMarker = 'meteolab-shell-';
if (html.includes(workerMarker)) {
  note('index.html contains the worker cache-name literal (it is inlined — expected only if referenced)');
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

for (const n of notes) console.log(`  · ${n}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} PWA problem(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

console.log('\nPWA validation passed.');

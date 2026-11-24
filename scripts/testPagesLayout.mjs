// Serve the repository root the way GitHub Pages does — index.html at the deployment root, PWA
// assets beside it — and check that the document's relative references all resolve. Run this after
// `npm run build:pages`, since it validates the *deployed* tree rather than `dist/`.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = path.join(root, decodeURIComponent(url.pathname));
  try {
    const st = await stat(file);
    if (st.isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(5199, '127.0.0.1', r));
const base = 'http://127.0.0.1:5199';

const html = await (await fetch(`${base}/index.html`)).text();
const refs = [...html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)].map((m) => m[1]);
const manifestRef = html.match(/<link[^>]+rel="manifest"[^>]+href="(\.\/[^"]+)"/)?.[1];
const swRef = html.match(/new URL\("(\.\/[^"]*sw\.js)"/)?.[1];

const results = [];
const check = (n, ok, d = '') => results.push({ n, ok, d });

for (const ref of new Set([...refs, manifestRef, swRef].filter(Boolean))) {
  const target = ref.replace('./', '');
  const r = await fetch(`${base}/${target}`);
  check(`served ${ref}`, r.ok, `status ${r.status}`);
}

// The manifest's own icon paths are relative to the manifest, which sits at the deployment root.
const manifest = await (await fetch(`${base}/${manifestRef.replace('./', '')}`)).json();
for (const icon of manifest.icons) {
  const r = await fetch(`${base}/${icon.src}`);
  check(`icon resolves ${icon.src}`, r.ok, `status ${r.status}`);
}
for (const shot of manifest.screenshots ?? []) {
  const r = await fetch(`${base}/${shot.src}`);
  check(`screenshot resolves ${shot.src}`, r.ok, `status ${r.status}`);
}

// start_url and scope are relative to the manifest: "./" -> the deployment root.
check('manifest start_url resolves to the deployment root', new URL(manifest.start_url, `${base}/manifest.webmanifest`).href === `${base}/`,
  new URL(manifest.start_url, `${base}/manifest.webmanifest`).href);
// A shortcut URL is relative to the deployment root, and its query survives.
const shortcut = manifest.shortcuts?.[0];
if (shortcut) {
  const u = new URL(shortcut.url, `${base}/`);
  const r = await fetch(u.href);
  check(`shortcut resolves ${shortcut.url}`, r.ok && u.searchParams.get('preset') === 'supercell_alley', u.href);
}

server.close();
let failed = 0;
for (const r of results) { if (!r.ok) failed++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${r.ok ? '' : `  [${r.d}]`}`); }
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

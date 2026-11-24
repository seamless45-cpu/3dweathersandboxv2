/**
 * Publishes a GitHub Pages build into the repository root.
 *
 * Pages serves the repository root, and the app is shipped as a single inlined HTML document, so
 * the deployable artefact has always been `index.html` at the root. A PWA cannot work that way:
 * the manifest, the service worker and the icons are *separate files* that the browser requests
 * by URL, and they must sit next to the document that references them — otherwise the install
 * prompt never appears and the worker's scope does not cover the page.
 *
 * So this script mirrors the whole of `dist/` to the root, not just the HTML. That is safe to do
 * verbatim: the single-file build inlines every script and stylesheet, so `dist/` contains only
 * the HTML, the worker, the manifest and the icons — there are no content-hashed bundle files to
 * filter out.
 */
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');

/**
 * Recursively mirror `dist/` into the repository root.
 *
 * `index.html` is the entry document, so `dist/app.html` is written *as* `index.html`; every other
 * file keeps its relative path, which is what the built HTML's "./…" references expect.
 */
async function mirror(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const written = [];

  for (const entry of entries) {
    const from = path.join(sourceDir, entry.name);
    if (entry.isDirectory()) {
      written.push(...(await mirror(from, path.join(targetDir, entry.name))));
      continue;
    }
    // The single-file build names its entry `app.html`; the deployed entry is `index.html`.
    const name = entry.name === 'app.html' ? 'index.html' : entry.name;
    const to = path.join(targetDir, name);
    await copyFile(from, to);
    written.push(path.relative(root, to));
  }
  return written;
}

const files = await mirror(dist, root);
files.sort();
console.log(`Copied ${files.length} file(s) to the repository root for GitHub Pages:`);
for (const f of files) {
  const { size } = await stat(path.join(root, f));
  console.log(`  ${f.padEnd(38)} ${(size / 1024).toFixed(1).padStart(8)} kB`);
}

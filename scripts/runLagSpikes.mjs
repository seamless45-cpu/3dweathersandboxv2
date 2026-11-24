#!/usr/bin/env node
/**
 * Bundles and runs scripts/lagSpikes.ts under Node (no browser or GPU needed).
 *   node scripts/runLagSpikes.mjs [frames] [presetId] [simSpeed]
 * The temporary bundle is written under dist/ (already git-ignored).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'lagSpikes.mjs');

const bundle = spawnSync(
  path.join(root, 'node_modules', '.bin', 'esbuild'),
  [
    path.join(root, 'scripts', 'lagSpikes.ts'),
    `--outfile=${outFile}`,
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--target=node20',
    '--log-level=warning',
  ],
  { stdio: 'inherit', cwd: root }
);
if (bundle.status !== 0) process.exit(bundle.status ?? 1);

const run = spawnSync(process.execPath, [outFile, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root,
});
process.exit(run.status ?? 1);

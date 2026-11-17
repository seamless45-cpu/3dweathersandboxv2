#!/usr/bin/env node
/**
 * Bundles and runs scripts/simBench.ts in Node with no browser or GPU present.
 *   node scripts/runSimBench.mjs [seconds] [presetId] [simSpeed]
 * The temporary bundle is written under dist/ (already git-ignored).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'simBench.mjs');

const esbuildBin = path.join(root, 'node_modules', '.bin', 'esbuild');
const bundle = spawnSync(
  esbuildBin,
  [
    path.join(root, 'scripts', 'simBench.ts'),
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

const run = spawnSync(process.execPath, [outFile, ...process.argv.slice(2)], { stdio: 'inherit', cwd: root });
process.exit(run.status ?? 1);

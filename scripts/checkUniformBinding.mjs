/**
 * Uniform-binding auditor.
 *
 * `checkShaderScope.mjs` proves every identifier a program *reads* is declared. This catches the
 * complementary defect, which is just as invisible and just as wrong: a uniform that the GLSL
 * declares and uses, but that the JavaScript material never provides a value for.
 *
 * Three.js does not error on a missing uniform key. `WebGLUniforms` simply has no location for a
 * name it never saw in the uniform list, the uniform keeps the value the driver initialised it
 * to -- zero -- and the shader runs happily with it. So a missing binding is *silently zero*, and
 * a term like `uDaylight` or `uOpacity` that was never bound makes its feature vanish with no
 * warning at all. That is a whole class of "the effect just doesn't show up" bug that neither the
 * GLSL parser nor the linker can report.
 *
 * The check also flags the mirror case -- a key supplied that no program in the material declares
 * -- because that is a typo that silently does nothing (e.g. `uTimeSec` against `uTime`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src/render', 'src/performance'];

/** Matches `const NAME = /* glsl *\/ `...`;` in either order of `export`. */
const shaderConstRe = /(?:export\s+)?const\s+([A-Za-z_]\w*)\s*=\s*\/\*\s*glsl\s*\*\/\s*`([\s\S]*?)`;/g;

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Uniform names declared in one GLSL source, including block-less `uniform T name;`. */
function uniformsOf(code) {
  const names = new Set();
  for (const m of stripComments(code).matchAll(/\buniform\s+[A-Za-z_]\w*\s+([^;]+);/g)) {
    for (const part of m[1].split(',')) {
      const id = part.trim().match(/^([A-Za-z_]\w*)/);
      if (id) names.add(id[1]);
    }
  }
  return names;
}

/**
 * Keys of the `uniforms: { ... }` object literal. Only the top level is scanned, so a nested
 * `value: new THREE.Vector3(...)` cannot be mistaken for a key.
 */
function uniformKeysOf(objectText) {
  const keys = new Set();
  let depth = 0;
  let i = 0;
  while (i < objectText.length) {
    const ch = objectText[i];
    if (ch === '{' || ch === '(' || ch === '[') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      i++;
      continue;
    }
    // A key sits directly at depth 0 and is followed by a colon. (The caller passes the block
    // *body*, with the outer braces already stripped, so one nesting level is zero here.)
    if (depth === 0 && /[A-Za-z_$]/.test(ch)) {
      const rest = objectText.slice(i);
      const km = rest.match(/^([A-Za-z_$][\w$]*)\s*:/);
      if (km) {
        keys.add(km[1]);
        i += km[0].length;
        continue;
      }
      // Skip the identifier so a value expression cannot be read as a key.
      const idm = rest.match(/^[A-Za-z_$][\w$]*/);
      i += idm ? idm[0].length : 1;
      continue;
    }
    i++;
  }
  return keys;
}

/** Extracts the balanced `{ ... }` starting at or after `from` in `text`. */
function balancedBlock(text, from) {
  const open = text.indexOf('{', from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return { body: text.slice(open + 1, i), start: open, end: i };
    }
  }
  return null;
}

let programs = 0;
let problems = 0;

const files = [];
for (const dir of SCAN_DIRS) {
  let entries;
  try {
    entries = readdirSync(path.join(root, dir));
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (/\.(ts|tsx)$/.test(entry)) files.push(path.join(dir, entry));
  }
}

/**
 * Global registry of GLSL sources, keyed by constant name.
 *
 * This has to span files: `sceneEngine` imports VOLUMETRIC_CLOUD_FRAG and COMPOSITE_POST_FRAG
 * from `volumetricSkyShader` and constructs the materials locally, so a per-file scan resolves
 * neither and silently audits nothing. The ray-march and the composite pass are the two programs
 * where an unbound uniform does the most damage, so they must be covered.
 */
const shaderSources = new Map();
for (const file of files) {
  const src = readFileSync(path.join(root, file), 'utf8');
  for (const m of src.matchAll(shaderConstRe)) shaderSources.set(m[1], m[2]);
}

for (const dir of SCAN_DIRS) {
  let entries;
  try {
    entries = readdirSync(path.join(root, dir));
  } catch {
    continue;
  }

  for (const entry of entries) {
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    const file = path.join(dir, entry);
    const src = readFileSync(path.join(root, file), 'utf8');

    // 1. Resolve against the global registry, not just this file: materials are routinely
    //    built in one module from shader sources declared in another.
    const sources = shaderSources;

    // 2. Every ShaderMaterial construction, resolved through its vertexShader/fragmentShader
    //    identifiers to the programs it actually uses.
    const matRe = /new\s+THREE\.(?:Raw)?ShaderMaterial\s*\(/g;
    for (const mm of src.matchAll(matRe)) {
      const block = balancedBlock(src, mm.index);
      if (!block) continue;
      const body = block.body;

      const vertName = body.match(/vertexShader\s*:\s*([A-Za-z_]\w*)/);
      const fragName = body.match(/fragmentShader\s*:\s*([A-Za-z_]\w*)/);
      const used = [];
      for (const nm of [vertName?.[1], fragName?.[1]]) {
        if (nm && sources.has(nm)) used.push(nm);
      }
      if (used.length === 0) continue;

      const declared = new Set();
      for (const nm of used) for (const u of uniformsOf(sources.get(nm))) declared.add(u);

      const uniformsIdx = body.search(/\buniforms\s*:\s*\{/);
      const line = src.slice(0, mm.index).split('\n').length;

      if (uniformsIdx === -1) {
        if (declared.size > 0) {
          problems++;
          console.error(`✗ ${file}:${line} ShaderMaterial provides no uniforms object`);
          console.error(`    unbound: ${[...declared].sort().join(', ')}`);
        }
        continue;
      }

      const keyBlock = balancedBlock(body, uniformsIdx);
      if (!keyBlock) continue;
      const supplied = uniformKeysOf(keyBlock.body);

      programs++;
      const unbound = [...declared].filter((u) => !supplied.has(u));
      const phantom = [...supplied].filter((u) => !declared.has(u));

      if (unbound.length) {
        problems++;
        console.error(`✗ ${file}:${line} (${used.join(' + ')})`);
        console.error(`    declared in GLSL but never supplied: ${unbound.sort().join(', ')}`);
      }
      if (phantom.length) {
        problems++;
        console.error(`✗ ${file}:${line} (${used.join(' + ')})`);
        console.error(`    supplied but declared by no program: ${phantom.sort().join(', ')}`);
      }
    }
  }
}

if (!programs) {
  console.error('no ShaderMaterials resolved - check the extraction regex');
  process.exit(1);
}
if (problems) {
  console.error(`\n${problems} uniform binding problem(s)`);
  process.exit(1);
}
console.log(`uniform binding OK - ${programs} ShaderMaterials, every uniform bound`);

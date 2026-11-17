#!/usr/bin/env node
/**
 * Static GLSL validation for the app's shader programs (dev tool).
 *
 * There is no browser or GPU in this environment, so this script is the safety net for
 * shader edits. It:
 *   1. extracts every `const NAME = /* glsl *\/ `...`` template from src/,
 *   2. parses each program with @shaderfrog/glsl-parser (GLSL ES 1.00 and 3.00),
 *   3. cross-checks the `uniform` declarations against the uniforms object of the
 *      THREE.ShaderMaterial that actually uses the program, so a shader can never silently
 *      render with a missing (zero-valued) uniform.
 *
 * Usage: node scripts/validateShaders.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Optional: `npm i --no-save @shaderfrog/glsl-parser` enables real GLSL parsing. Without it
// this script still performs the uniform cross-check, which needs no dependencies.
let parser = null;
try {
  parser = (await import('@shaderfrog/glsl-parser')).parser;
} catch {
  console.warn('note: @shaderfrog/glsl-parser not installed — skipping GLSL parse checks.\n');
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');

/** Uniforms three.js injects into every ShaderMaterial, so they need no JS-side entry. */
const THREE_BUILTIN_UNIFORMS = new Set([
  'modelMatrix', 'modelViewMatrix', 'projectionMatrix', 'viewMatrix', 'normalMatrix',
  'cameraPosition', 'isOrthographic', 'logDepthBufFC', 'opacity', 'diffuse', 'map',
]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Finds the matching closing brace of the block starting at `openIndex`. */
function matchBraces(text, openIndex) {
  let depth = 0;
  let inStr = null;
  let inTemplate = false;
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i];
    const prev = text[i - 1];
    if (inStr) {
      if (c === inStr && prev !== '\\') inStr = null;
      continue;
    }
    if (inTemplate) {
      if (c === '`' && prev !== '\\') inTemplate = false;
      continue;
    }
    if (c === '`') { inTemplate = true; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const files = walk(srcDir);
const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

// 1. Collect GLSL template literals.
const glsl = new Map(); // name -> { file, code }
for (const [file, text] of sources) {
  const re = /(?:export\s+)?const\s+([A-Z0-9_]+)\s*=\s*\/\*\s*glsl\s*\*\/\s*`([\s\S]*?)`;/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    glsl.set(m[1], { file, code: m[2] });
  }
}

// 2. Collect ShaderMaterial construction sites.
const materials = [];
for (const [file, text] of sources) {
  let idx = 0;
  for (;;) {
    idx = text.indexOf('new THREE.ShaderMaterial(', idx);
    if (idx < 0) break;
    const open = text.indexOf('{', idx);
    const close = matchBraces(text, open);
    if (close < 0) break;
    const block = text.slice(open, close + 1);
    const line = text.slice(0, idx).split('\n').length;
    const pick = (key) => {
      const mm = block.match(new RegExp(`${key}\\s*:\\s*([A-Za-z0-9_.]+)`));
      return mm ? mm[1].split('.').pop() : null;
    };
    const uniformKeys = [];
    const uStart = block.indexOf('uniforms:');
    if (uStart >= 0) {
      const uOpen = block.indexOf('{', uStart);
      const uClose = matchBraces(block, uOpen);
      if (uClose > uOpen) {
        const uBlock = block.slice(uOpen + 1, uClose);
        const re = /(?:^|[,{\s])([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{/g;
        let um;
        while ((um = re.exec(uBlock)) !== null) uniformKeys.push(um[1]);
      }
    }
    materials.push({
      file, line, glsl3: /glslVersion\s*:\s*THREE\.GLSL3/.test(block),
      vertex: pick('vertexShader'), fragment: pick('fragmentShader'), uniformKeys,
    });
    idx = close;
  }
}

const BUILTINS_V1 = `
uniform mat4 modelMatrix; uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix;
uniform mat4 viewMatrix; uniform mat3 normalMatrix; uniform vec3 cameraPosition; uniform bool isOrthographic;
`;
const BUILTINS_V1_VERT = `${BUILTINS_V1}
attribute vec3 position; attribute vec3 normal; attribute vec2 uv;
`;
const BUILTINS_V3 = `
uniform mat4 modelMatrix; uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix;
uniform mat4 viewMatrix; uniform mat3 normalMatrix; uniform vec3 cameraPosition; uniform bool isOrthographic;
`;
const BUILTINS_V3_VERT = `${BUILTINS_V3}
in vec3 position; in vec3 normal; in vec2 uv;
`;

let failures = 0;
let parsed = 0;
const seenPrograms = new Set();

function validateProgram(label, code, glsl3, isVertex) {
  if (!parser) return;
  const prefix = glsl3
    ? `#version 300 es\n${isVertex ? BUILTINS_V3_VERT : BUILTINS_V3}`
    : `${isVertex ? BUILTINS_V1_VERT : BUILTINS_V1}`;
  const source = prefix + code;
  try {
    parser.parse(source, { quiet: true });
    parsed++;
  } catch (err) {
    failures++;
    const msg = String(err?.message ?? err).split('\n')[0];
    console.error(`✗ PARSE FAIL  ${label}\n    ${msg}`);
    const at = err?.location?.start;
    if (at) {
      const lines = source.split('\n');
      console.error(`    at generated line ${at.line}: ${lines[at.line - 1]?.trim()}`);
    }
  }
}

for (const mat of materials) {
  const declared = [];
  for (const stage of ['vertex', 'fragment']) {
    const name = mat[stage];
    if (!name) continue;
    const prog = glsl.get(name);
    const label = `${path.relative(root, mat.file)}:${mat.line} ${stage}=${name}`;
    if (!prog) {
      // May be an inline template or a name resolved through an import; flag only unknown idents.
      if (/^[A-Z0-9_]+$/.test(name)) {
        console.warn(`? unresolved shader source for ${label}`);
      }
      continue;
    }
    validateProgram(label, prog.code, mat.glsl3, stage === 'vertex');
    seenPrograms.add(name);
    for (const m of prog.code.matchAll(/^\s*uniform\s+\w+\s+([A-Za-z0-9_]+)\s*(?:\[[^\]]*\])?\s*;/gm)) {
      declared.push(m[1]);
    }
  }

  // 3. Uniform cross-check across both stages of the program pair.
  const label = `${path.relative(root, mat.file)}:${mat.line}`;
  const provided = new Set(mat.uniformKeys);
  const missing = declared.filter((u) => !provided.has(u) && !THREE_BUILTIN_UNIFORMS.has(u));
  const unused = [...provided].filter((u) => !declared.includes(u));
  if (missing.length) {
    failures++;
    console.error(`✗ MISSING UNIFORM(S) in ${label}: ${missing.join(', ')}  (would silently default to 0)`);
  }
  if (unused.length) {
    console.warn(`  note: ${label} provides uniform(s) declared by neither stage: ${unused.join(', ')}`);
  }
}

for (const [name, prog] of glsl) {
  if (!seenPrograms.has(name)) {
    // Still parse orphan programs so nothing ships broken.
    const looksV3 = /\b(in|out)\s+vec|\btexture\(/.test(prog.code) && !/varying|texture2D/.test(prog.code);
    validateProgram(`${path.relative(root, prog.file)} ${name} (orphan)`, prog.code, looksV3, /_VERT$/.test(name));
  }
}

console.log(`\n${glsl.size} GLSL programs found, ${materials.length} ShaderMaterials, ${parsed} parses OK, ${failures} failure(s).`);
process.exit(failures > 0 ? 1 : 0);

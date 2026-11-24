/**
 * Scope checker for the GLSL programs.
 *
 * `validateShaders.mjs` parses each program, but a parser only validates *syntax*: an unknown
 * identifier like `fres` is perfectly well-formed. The failure only appears when the driver
 * links the program, and in a WebGL app that shows up as a silently skipped draw call rather
 * than an error anybody notices. That is exactly how the near-field rain curtain came to
 * reference `fres` and `caustic` -- two identifiers that exist nowhere in the codebase --
 * implying the shader had never once compiled and the rain never rendered.
 *
 * This walks each program, collects every identifier that is declared (uniforms, attributes,
 * varyings, locals, function parameters, function names, multi-declarator lists) and reports
 * any identifier that is read without being declared anywhere in scope.
 *
 * It also guards the template literals themselves: a backtick inside a GLSL template literal
 * silently ends the string early, and the resulting TypeScript syntax error surfaces hundreds
 * of lines away from the actual cause.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src/render', 'src/sim', 'src/ui'];

// GLSL keywords, built-in functions and built-in variables. Anything here needs no declaration.
const BUILTIN = new Set(
  `
  void bool int uint float double vec2 vec3 vec4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4
  bvec2 bvec3 bvec4 mat2 mat3 mat4 mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4
  sampler2D sampler3D samplerCube sampler2DArray samplerCubeArray sampler2DShadow isampler2D
  uniform varying attribute in out inout const struct precision highp mediump lowp
  if else for while do break continue return discard switch case default
  true false
  abs acos acosh all any asin asinh atan atanh bitCount bitfieldExtract bitfieldInsert
  bitfieldReverse ceil clamp cos cosh cross dFdx dFdy degrees determinant distance dot equal exp
  exp2 faceforward findLSB findMSB floatBitsToInt floatBitsToUint floor fma fract frexp fwidth
  greaterThan greaterThanEqual imulExtended intBitsToFloat inverse inversesqrt isinf isnan ldexp
  length lessThan lessThanEqual log log2 matrixCompMult max min mix mod modf normalize not
  notEqual outerProduct packHalf2x16 packSnorm2x16 packUnorm2x16 pow radians reflect refract round
  roundEven sign sin sinh smoothstep sqrt step tan tanh texelFetch texelFetchOffset texture
  texture2D texture3D textureCube textureGrad textureLod textureOffset textureProj textureSize
  transpose trunc uaddCarry uintBitsToFloat umulExtended unpackHalf2x16 unpackSnorm2x16
  unpackUnorm2x16 usubBorrow
  gl_FragColor gl_FragData gl_FragCoord gl_FragDepth gl_FrontFacing gl_PointCoord gl_PointSize
  gl_Position gl_VertexID gl_InstanceID
  modelMatrix modelViewMatrix projectionMatrix viewMatrix normalMatrix cameraPosition position
  normal uv layout location
`
    .trim()
    .split(/\s+/)
    .filter(Boolean)
);

const TYPES =
  'void|bool|int|uint|float|vec[234]|ivec[234]|uvec[234]|bvec[234]|mat[234](?:x[234])?|sampler2D|sampler3D|samplerCube|sampler2DArray|struct';

const SWIZZLE = /^(x|y|z|w|r|g|b|a|s|t|p|st|rgba|rgb|xyzw|xy|xyz)$/;

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Every identifier declared anywhere in the program: uniforms, locals, params, functions. */
function collectDeclared(code) {
  const declared = new Set();

  // "<type> name" followed by anything that can follow a declarator.
  const declRe = new RegExp(`\\b(?:${TYPES})\\s+([A-Za-z_]\\w*)\\s*(?=[;,=)\\[\\{]|$)`, 'g');
  for (const m of code.matchAll(declRe)) declared.add(m[1]);

  // Function definitions and prototypes: "<type> name("
  const fnRe = new RegExp(`\\b(?:${TYPES})\\s+([A-Za-z_]\\w*)\\s*\\(`, 'g');
  for (const m of code.matchAll(fnRe)) declared.add(m[1]);

  // Multi-declarator statements: "float a = 1.0, b = 2.0;" -- the type appears once, so every
  // later comma-separated name is a declaration too. Missing this reported `sn` in
  // "float cs = cos(vSpin), sn = sin(vSpin);" as undeclared when it is perfectly valid.
  const stmtRe = new RegExp(`\\b(?:${TYPES})\\s+([^;{}]+);`, 'g');
  for (const m of code.matchAll(stmtRe)) {
    const body = m[1];
    let depth = 0;
    let cur = '';
    const parts = [];
    for (const ch of body) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    parts.push(cur);
    for (const part of parts) {
      const id = part.trim().match(/^([A-Za-z_]\w*)/);
      if (id) declared.add(id[1]);
    }
  }

  // Struct members.
  for (const m of code.matchAll(/struct\s+\w+\s*\{([^}]*)\}/g)) {
    for (const d of m[1].matchAll(new RegExp(`\\b(?:${TYPES})\\s+([A-Za-z_]\\w*)`, 'g'))) {
      declared.add(d[1]);
    }
  }

  return declared;
}

function collectReferenced(code) {
  const refs = new Set();
  for (const m of code.matchAll(/(\.)?\b([A-Za-z_]\w*)\b/g)) {
    if (m[1]) continue; // member access / swizzle
    refs.add(m[2]);
  }
  return refs;
}

// ---------------------------------------------------------------------------------------------
// 1. Template-literal integrity: a backtick inside a GLSL template ends it early.
// ---------------------------------------------------------------------------------------------
let templateProblems = 0;
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
    const opener = /\/\*\s*glsl\s*\*\/\s*`/g;
    let m;
    while ((m = opener.exec(src))) {
      const bodyStart = m.index + m[0].length;
      let i = bodyStart;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '/' && src[i + 1] === '/') {
          // A backtick inside a line comment is still inside the template literal and *will*
          // terminate it in the TypeScript parser. Report it rather than skipping the line.
          const nl = src.indexOf('\n', i);
          const comment = src.slice(i, nl === -1 ? src.length : nl);
          if (comment.includes('`')) {
            const line = src.slice(0, i).split('\n').length;
            console.error(`✗ ${file}:${line} backtick inside a GLSL comment terminates the template`);
            templateProblems++;
            process.exitCode = 1;
          }
          if (nl === -1) {
            i = src.length;
            break;
          }
          i = nl + 1;
          continue;
        }
        if (ch === '/' && src[i + 1] === '*') {
          const close = src.indexOf('*/', i + 2);
          if (close === -1) break;
          const block = src.slice(i, close);
          if (block.includes('`')) {
            const line = src.slice(0, i).split('\n').length;
            console.error(`✗ ${file}:${line} backtick inside a GLSL block comment terminates the template`);
            templateProblems++;
            process.exitCode = 1;
          }
          i = close + 2;
          continue;
        }
        if (ch === '`') break; // legitimate terminator
        i++;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Scope: every referenced identifier must be declared somewhere in the program.
// ---------------------------------------------------------------------------------------------
const shaderRe = /(?:export\s+)?const\s+(\w+)\s*=\s*\/\*\s*glsl\s*\*\/\s*`([\s\S]*?)`;/g;
let programs = 0;
let problems = 0;

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
    let m;
    shaderRe.lastIndex = 0;
    while ((m = shaderRe.exec(src))) {
      const [, name, raw] = m;
      const code = stripComments(raw);
      const declared = collectDeclared(code);
      const refs = collectReferenced(code);
      const missing = [...refs].filter(
        (id) =>
          !declared.has(id) &&
          !BUILTIN.has(id) &&
          !SWIZZLE.test(id) &&
          !/^\d/.test(id)
      );
      programs++;
      if (missing.length) {
        problems++;
        console.error(`✗ ${file} :: ${name}`);
        console.error(`    undeclared identifier(s): ${missing.sort().join(', ')}`);
      }
    }
  }
}

if (!programs) {
  console.error('no GLSL programs found - check the extraction regex');
  process.exit(1);
}
if (problems) {
  console.error(`\n${problems} program(s) reference undeclared identifiers`);
  process.exit(1);
}
if (templateProblems) {
  console.error(`\n${templateProblems} GLSL template literal problem(s)`);
  process.exit(1);
}
console.log(`\nshader scope OK - ${programs} programs, no undeclared identifiers`);

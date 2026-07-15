#!/usr/bin/env node

// Generates argon2id-inline.js by inlining the WASM
// binaries from the argon2id npm package as base64.
//
// Usage: node scripts/inline-argon2id.mjs
//
// Run this after updating the argon2id dependency:
//   pnpm update argon2id && node scripts/inline-argon2id.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkgDir = dirname(
  require.resolve('argon2id/package.json'));
const simd = readFileSync(
  resolve(pkgDir, 'dist/simd.wasm'));
const noSimd = readFileSync(
  resolve(pkgDir, 'dist/no-simd.wasm'));

const out = `import setupWasm from 'argon2id/lib/setup.js';

const SIMD_B64 = '${simd.toString('base64')}';
const NOSIMD_B64 = '${noSimd.toString('base64')}';

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

const simdBytes = b64ToBytes(SIMD_B64);
const noSimdBytes = b64ToBytes(NOSIMD_B64);

const loadArgon2id = () => setupWasm(
  (importObject) =>
    WebAssembly.instantiate(simdBytes, importObject),
  (importObject) =>
    WebAssembly.instantiate(noSimdBytes, importObject),
);

export default loadArgon2id;
`;

const outPath = resolve(
  dirname(import.meta.url.replace('file://', '')),
  '..', 'argon2id-inline.js');
writeFileSync(outPath, out);
console.log(
  'Wrote argon2id-inline.js '
  + `(simd: ${simd.length} B, no-simd: ${noSimd.length} B)`);

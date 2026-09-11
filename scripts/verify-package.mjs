import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const output = execFileSync(
  npm,
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
);
const [tarball] = JSON.parse(output);

assert.ok(tarball, 'npm pack did not return tarball metadata');

const packagedPaths = new Set(tarball.files.map(({ path }) => path));
for (const path of [
  'README.md',
  'LICENSE',
  'dist/index.js',
  'dist/index.d.ts',
  'dist-cjs/index.js',
  'dist-cjs/package.json',
]) {
  assert.ok(packagedPaths.has(path), `published package is missing ${path}`);
}

assert.ok(
  ![...packagedPaths].some((path) => path.startsWith('src/') || path.startsWith('test/')),
  'published package must not contain source or test files',
);

const esm = await import('lazy-layers-cache');
const require = createRequire(import.meta.url);
const cjs = require('lazy-layers-cache');

for (const [format, exported] of [['ESM', esm], ['CommonJS', cjs]]) {
  assert.equal(typeof exported.createCache, 'function', `${format} createCache export is unavailable`);
  assert.equal(typeof exported.LazyLayersCache, 'function', `${format} LazyLayersCache export is unavailable`);
}

console.log(`Package verification passed for ${tarball.name}@${tarball.version}.`);

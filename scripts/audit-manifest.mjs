#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import os from 'node:os';

const target = resolve(process.argv[2] ?? '.');
const output = process.argv[3] ?? 'audit/raw/build-manifest.json';
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}
const sha = (value) => createHash('sha256').update(value).digest('hex');
const trees = {};
for (const name of ['src', 'dist']) {
  const rows = [];
  for (const file of await files(join(target, name))) rows.push({ path: relative(target, file), bytes: (await readFile(file)).byteLength, sha256: sha(await readFile(file)) });
  trees[name] = { digest: sha(rows.map((row) => `${row.path}\0${row.sha256}\n`).join('')), files: rows };
}
const result = { generatedAt: new Date().toISOString(), target, node: process.version, v8: process.versions.v8, platform: `${os.type()} ${os.release()}`, arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, packageSha256: sha(await readFile(join(target, 'package.json'))), lockfileSha256: sha(await readFile(join(target, 'package-lock.json'))), trees };
await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, sourceDigest: trees.src.digest, buildDigest: trees.dist.digest, sourceFiles: trees.src.files.length, buildFiles: trees.dist.files.length }));

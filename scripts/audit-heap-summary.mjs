#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';

// Structural snapshot analysis, not a dominator/retained-size estimator. Run
// under audit-runner (20 s / 512 MiB) and Node's 256 MiB heap cap.
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: audit-heap-summary.mjs snapshot.heapsnapshot summary.json');
if ((await stat(input)).size > 64 * 1024 * 1024) throw new RangeError('Snapshot exceeds this analyzer\'s 64 MiB input budget');
const snapshot = JSON.parse(await readFile(input, 'utf8'));
const { nodes, edges, strings } = snapshot;
const nf = snapshot.snapshot.meta.node_fields;
const ef = snapshot.snapshot.meta.edge_fields;
const nw = nf.length, ew = ef.length;
const nameIndex = nf.indexOf('name'), sizeIndex = nf.indexOf('self_size'), countIndex = nf.indexOf('edge_count');
const nodeTypes = snapshot.snapshot.meta.node_types[0];
const edgeTypes = snapshot.snapshot.meta.edge_types[0];
const starts = new Uint32Array(nodes.length / nw);
let position = 0;
for (let p = 0; p < nodes.length; p += nw) { starts[p / nw] = position; position += nodes[p + countIndex] * ew; }
function links(node) {
  const result = [];
  for (let p = starts[node / nw], end = p + nodes[node + countIndex] * ew; p < end; p += ew) {
    const type = edgeTypes[edges[p]];
    const target = edges[p + 2];
    result.push({ type, label: type === 'element' ? edges[p + 1] : strings[edges[p + 1]], target, name: strings[nodes[target + nameIndex]], nodeType: nodeTypes[nodes[target]] });
  }
  return result;
}
const stores = [];
for (let p = 0; p < nodes.length; p += nw) {
  if (nodeTypes[nodes[p]] !== 'object' || strings[nodes[p + nameIndex]] !== 'MemoryStore') continue;
  const storeLinks = links(p);
  const closed = storeLinks.find((edge) => edge.label === 'closed')?.name === 'true';
  const cache = storeLinks.find((edge) => edge.label === 'cache' && edge.nodeType === 'object');
  const arrays = new Set();
  const backing = new Set();
  if (cache) {
    for (const edge of links(cache.target)) {
      if (edge.nodeType !== 'object' || edge.label === '__proto__' || edge.type !== 'property') continue;
      if (/^(Array|(?:Uint|Int|Float|BigInt|BigUint)\d+(?:Clamped)?Array)$/.test(edge.name)) arrays.add(edge.target);
      else if (edge.name !== 'Map' && edge.name !== 'Performance' && edge.name !== 'system / Context') {
        // The LRU's free-index stack is a small wrapper around an owned array.
        for (const child of links(edge.target)) if (child.type === 'property' && /^(Array|(?:Uint|Int)\d+Array)$/.test(child.name)) arrays.add(child.target);
      }
    }
  }
  for (const array of arrays) {
    for (const edge of links(array)) {
      if (edge.type === 'internal' && edge.nodeType === 'array') backing.add(edge.target);
      if (edge.type === 'internal' && edge.name === 'ArrayBuffer') {
        backing.add(edge.target);
        for (const bufferEdge of links(edge.target)) if (bufferEdge.type === 'internal' && bufferEdge.nodeType === 'native') backing.add(bufferEdge.target);
      }
    }
  }
  const bytes = (set) => [...set].reduce((total, node) => total + nodes[node + sizeIndex], 0);
  stores.push({ closed, cachePresent: Boolean(cache), directArrayCount: arrays.size, directArraySelfBytes: bytes(arrays), backingNodeCount: backing.size, backingSelfBytes: bytes(backing) });
}
const open = stores.filter((store) => !store.closed);
const closed = stores.filter((store) => store.closed);
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const summary = {
  input, snapshotNodeCount: nodes.length / nw,
  open: { storeCount: open.length, directArrayCount: sum(open, 'directArrayCount'), directArraySelfBytes: sum(open, 'directArraySelfBytes'), backingSelfBytes: sum(open, 'backingSelfBytes') },
  closed: { storeCount: closed.length, cachePresentCount: closed.filter((store) => store.cachePresent).length, directArrayCount: sum(closed, 'directArrayCount'), directArraySelfBytes: sum(closed, 'directArraySelfBytes'), backingSelfBytes: sum(closed, 'backingSelfBytes') },
  stores,
  limits: { inputBytes: 64 * 1024 * 1024, recommendedHeapMiB: 256, recommendedWallSeconds: 20, recommendedRssMiB: 512 },
  notes: ['Counts and self sizes of directly owned LRU arrays/backing nodes only; excludes keys, entries, contexts and shared code.', 'This is not a retained-size/dominator analysis and does not establish actual total memory per cache entry.'],
};
await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ output, open: summary.open, closed: summary.closed }));

#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const [beforeFile, afterFile] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (!beforeFile || !afterFile) throw new Error('Usage: audit-compare.mjs before.json after.json [--gate]');
const before = JSON.parse(await readFile(beforeFile, 'utf8')); const after = JSON.parse(await readFile(afterFile, 'utf8'));
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(q * sorted.length)))]; };
let seed = 0x17ea31;
const draw = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 2 ** 32 * n); };
const rows = [];
for (const original of before.rows) {
  const current = after.rows.find((row) => row.name === original.name && row.n === original.n);
  if (!current) throw new Error(`Missing equivalent after case ${original.name}/${original.n}`);
  if (original.runs.some((run) => run.operations !== current.runs[0].operations)) throw new Error('Accepted operation counts differ');
  const baseline = original.runs.map((run) => run.elapsedMs); const revised = current.runs.map((run) => run.elapsedMs);
  const baselineMedian = median(baseline); const afterMedian = median(revised);
  const relativeMad = median(baseline.map((value) => Math.abs(value - baselineMedian))) / baselineMedian;
  const tolerance = Math.max(.10, relativeMad * 3);
  const ratios = [];
  for (let i = 0; i < 10000; i++) ratios.push(median(revised.map(() => revised[draw(revised.length)])) / median(baseline.map(() => baseline[draw(baseline.length)])));
  // Bonferroni family correction reduces false alarms across many scenarios.
  const alpha = .05 / before.rows.length;
  const interval = [quantile(ratios, alpha / 2), quantile(ratios, 1 - alpha / 2)];
  rows.push({ name: original.name, n: original.n, repetitions: { before: baseline.length, after: revised.length }, baselineMs: baselineMedian, afterMs: afterMedian, changePercent: (afterMedian / baselineMedian - 1) * 100, baselineRelativeMad: relativeMad, toleratedRelativeRegression: tolerance, medianRatioFamily95BootstrapInterval: interval, regression: baseline.length >= 5 && revised.length >= 5 && interval[0] > 1 + tolerance, insufficientRepetitionsForGate: baseline.length < 5 || revised.length < 5 });
}
const output = process.env.LAZY_AUDIT_COMPARISON_OUTPUT ?? 'audit/raw/performance-comparison.json';
await writeFile(output, JSON.stringify({ before: beforeFile, after: afterFile, methodology: '10000 deterministic bootstrap resamples of medians; 95% family interval; tolerance max(10%,3 baseline relative MAD); >=5 repetitions required; shared hardware/short runs limit inference', rows }, null, 2) + '\n');
for (const row of rows) console.log(`${row.name}/${row.n}: ${row.changePercent.toFixed(1)}%, interval ${row.medianRatioFamily95BootstrapInterval.map((value) => value.toFixed(3)).join('–')}${row.regression ? ' REGRESSION' : ''}`);
if (process.argv.includes('--gate') && rows.some((row) => row.regression || row.insufficientRepetitionsForGate)) process.exitCode = 1;

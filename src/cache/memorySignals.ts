import * as os from 'node:os';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { getHeapStatistics } from 'node:v8';

/** Missing platform signals remain unknown; zero available memory is a valid signal. */
export interface MemorySignalReader {
  readFile?: (path: string) => string | undefined;
  hostMemoryBytes?: number;
  rssBytes?: number;
  heapUsedBytes?: number;
  heapTotalBytes?: number;
  heapLimitBytes?: number;
  availableMemoryBytes?: number;
  psiSomeAvg10?: number;
  cgroupRoot?: string;
  cgroupPaths?: string[];
}
export interface MemorySignals {
  hostBytes?: number;
  effectiveBytes?: number;
  rssBytes?: number;
  heapUsedBytes?: number;
  heapTotalBytes?: number;
  heapLimitBytes?: number;
  availableBytes?: number;
  psiSomeAvg10?: number;
  cgroupBytes?: number;
  available: Record<string, boolean>;
}

const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const positive = (n: unknown): n is number => valid(n) && n > 0;
const unescapePath = (s: string): string => s.replace(/\\([0-7]{3})/g, (_, digits: string) => String.fromCharCode(parseInt(digits, 8)));
const readDefault = (path: string): string | undefined => {
  try { return readFileSync(path, 'utf8'); } catch { return undefined; }
};

function cgroupDirectories(read: (path: string) => string | undefined, reader: MemorySignalReader): Set<string> {
  const root = reader.cgroupRoot ?? '/sys/fs/cgroup';
  const directories = new Set([root, `${root}/memory`, ...(reader.cgroupPaths ?? [])]);
  const membership = (read('/proc/self/cgroup') ?? '').split('\n').flatMap((line) => {
    const match = /^\d+:([^:]*):(.*)$/.exec(line);
    return match && (!match[1] || match[1].split(',').includes('memory'))
      ? [{ unified: !match[1], path: posix.normalize(match[2]) }] : [];
  });
  for (const line of (read('/proc/self/mountinfo') ?? '').split('\n')) {
    const [before, after] = line.split(' - ');
    if (!after) continue;
    const fields = before.split(' ');
    const [type, , superOptions = ''] = after.split(' ');
    if (type !== 'cgroup2' && !(type === 'cgroup' && superOptions.split(',').includes('memory'))) continue;
    const mountRoot = unescapePath(fields[3] ?? '');
    const mountPoint = unescapePath(fields[4] ?? '');
    if (!mountPoint.startsWith('/')) continue;
    for (const member of membership) {
      if (member.unified !== (type === 'cgroup2')) continue;
      // Namespace-relative / membership is rooted at the visible mount.
      const relative = member.path === '/' ? '' : posix.relative(mountRoot, member.path);
      if (relative.startsWith('..') || posix.isAbsolute(relative)) continue;
      let directory = posix.join(mountPoint, relative);
      for (let depth = 0; depth < 64; depth++) {
        directories.add(directory);
        if (directory === mountPoint) break;
        const parent = posix.dirname(directory);
        if (parent === directory || !parent.startsWith(mountPoint === '/' ? '/' : mountPoint + '/')) {
          if (parent === mountPoint) directories.add(parent);
          break;
        }
        directory = parent;
      }
    }
  }
  return directories;
}

export function readMemorySignals(reader: MemorySignalReader = {}): MemorySignals {
  const read = (path: string): string | undefined => {
    try { return (reader.readFile ?? readDefault)(path); } catch { return undefined; }
  };
  const usage = process.memoryUsage();
  const hostBytes = reader.hostMemoryBytes ?? os.totalmem();
  const availableValues = [reader.availableMemoryBytes ?? process.availableMemory?.() ?? os.freemem()];
  let cgroupBytes: number | undefined;
  let psi = reader.psiSomeAvg10;
  const parsePsi = (text?: string): number | undefined => {
    const match = text?.match(/^some\s+avg10=(\d+(?:\.\d+)?)/m);
    return match ? Number(match[1]) : undefined;
  };
  for (const directory of cgroupDirectories(read, reader)) {
    for (const [limitFile, usageFile] of [['memory.max', 'memory.current'], ['memory.limit_in_bytes', 'memory.usage_in_bytes']]) {
      const text = read(`${directory}/${limitFile}`)?.trim();
      if (!text || text === 'max') continue;
      const limit = Number(text);
      if (!positive(limit) || !Number.isSafeInteger(limit)) continue; // v1 unlimited sentinel
      cgroupBytes = Math.min(cgroupBytes ?? Infinity, limit);
      const currentText = read(`${directory}/${usageFile}`)?.trim();
      const current = currentText ? Number(currentText) : undefined;
      if (valid(current)) availableValues.push(Math.max(0, limit - current));
    }
    if (reader.psiSomeAvg10 === undefined) {
      const sample = parsePsi(read(`${directory}/memory.pressure`));
      if (valid(sample)) psi = Math.max(psi ?? 0, sample);
    }
  }
  if (reader.psiSomeAvg10 === undefined) {
    const hostPsi = parsePsi(read('/proc/pressure/memory'));
    if (valid(hostPsi)) psi = Math.max(psi ?? 0, hostPsi);
  }
  const capacities = [hostBytes, cgroupBytes].filter(positive);
  const available = availableValues.filter(valid);
  const result: MemorySignals = {
    hostBytes: positive(hostBytes) ? hostBytes : undefined,
    effectiveBytes: capacities.length ? Math.min(...capacities) : undefined,
    availableBytes: available.length ? Math.min(...available) : undefined,
    rssBytes: reader.rssBytes ?? usage.rss,
    heapUsedBytes: reader.heapUsedBytes ?? usage.heapUsed,
    heapTotalBytes: reader.heapTotalBytes ?? usage.heapTotal,
    heapLimitBytes: reader.heapLimitBytes ?? getHeapStatistics().heap_size_limit,
    cgroupBytes, psiSomeAvg10: valid(psi) ? psi : undefined, available: {},
  };
  for (const [name, value] of Object.entries(result)) if (name !== 'available') result.available[name] = value !== undefined;
  return result;
}

export function resolveEffectiveMemory(reader: MemorySignalReader = {}): number | undefined {
  return readMemorySignals(reader).effectiveBytes;
}

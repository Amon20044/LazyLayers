import * as os from 'node:os';

/** Feature-detected memory and Linux cgroup signals. Missing values remain undefined. */
export interface MemorySignalReader {
  readFile?: (path: string) => string | undefined;
  hostMemoryBytes?: number;
  rssBytes?: number;
  heapUsedBytes?: number;
  heapTotalBytes?: number;
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
  availableBytes?: number;
  psiSomeAvg10?: number;
  cgroupBytes?: number;
  available: Record<string, boolean>;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

function cgroupLimit(reader: MemorySignalReader, root = '/sys/fs/cgroup'): number | undefined {
  const read = reader.readFile;
  if (!read) return undefined;
  const candidates = [
    `${root}/memory.max`, `${root}/memory/memory.limit_in_bytes`,
  ];
  let best: number | undefined;
  for (const path of candidates) {
    const text = read(path)?.trim();
    if (!text || text === 'max') continue;
    const value = Number(text);
    if (finite(value) && value < (best ?? Infinity)) best = value;
  }
  // Nested cgroups are represented by ancestors in a mounted hierarchy. Walk
  // explicit paths too, which also makes this deterministic in tests.
  const paths = (reader as MemorySignalReader & { cgroupPaths?: string[] }).cgroupPaths;
  for (const path of paths ?? []) {
    for (const file of ['memory.max', 'memory.limit_in_bytes']) {
      const text = read(`${path}/${file}`)?.trim();
      if (!text || text === 'max') continue;
      const value = Number(text);
      if (finite(value) && value < (best ?? Infinity)) best = value;
    }
  }
  return best;
}

export function readMemorySignals(reader: MemorySignalReader = {}): MemorySignals {
  const proc = typeof process !== 'undefined' ? process : undefined;
  const usage = proc?.memoryUsage?.();
  const hostBytes = finite(reader.hostMemoryBytes) ? reader.hostMemoryBytes : os.totalmem();
  const rss = finite(reader.rssBytes) ? reader.rssBytes : usage?.rss;
  const heapUsed = finite(reader.heapUsedBytes) ? reader.heapUsedBytes : usage?.heapUsed;
  const heapTotal = finite(reader.heapTotalBytes) ? reader.heapTotalBytes : usage?.heapTotal;
  const available = finite(reader.availableMemoryBytes) ? reader.availableMemoryBytes :
    (proc as any)?.availableMemory?.();
  const cgroup = cgroupLimit(reader, (reader as any).cgroupRoot);
  const psi = finite(reader.psiSomeAvg10) ? reader.psiSomeAvg10 : undefined;
  const result: MemorySignals = { hostBytes: hostBytes ?? undefined, effectiveBytes: undefined, rssBytes: rss, heapUsedBytes: heapUsed, heapTotalBytes: heapTotal, availableBytes: available, psiSomeAvg10: psi, cgroupBytes: cgroup, available: {} };
  for (const [key, value] of Object.entries({ host: result.hostBytes, rss, heapUsed, heapTotal, available, cgroup, psi })) result.available[key] = value !== undefined;
  result.effectiveBytes = [result.hostBytes, result.cgroupBytes].filter(finite).reduce((a, b) => Math.min(a, b), Infinity);
  if (!Number.isFinite(result.effectiveBytes)) result.effectiveBytes = undefined;
  return result;
}

export function resolveEffectiveMemory(reader: MemorySignalReader = {}): number | undefined {
  return readMemorySignals(reader).effectiveBytes;
}

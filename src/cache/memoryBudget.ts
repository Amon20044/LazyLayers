import { readMemorySignals, type MemorySignalReader, type MemorySignals } from './memorySignals.js';

export type MemoryCategory = 'fresh' | 'stale' | 'metadata' | 'queue' | 'transient' | (string & {});
export type MemoryLimit = number | `${number}%` | `${number}${'B'|'KB'|'MB'|'GB'|'KiB'|'MiB'|'GiB'}`;
export interface MemoryBudgetOptions {
  maxMemory: MemoryLimit;
  minMemory?: MemoryLimit;
  memory?: MemorySignalReader;
  sampleIntervalMs?: number;
  pressureWindowMs?: number;
  recoveryWindowMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => any;
  clearTimer?: (timer: any) => void;
}
export interface MemoryBudgetSnapshot {
  hardCap: number; target: number; accountedBytes: number; pressureState: 'normal'|'pressure'|'critical';
  categories: Record<string, number>; clients: number; signals: MemorySignals; evictions: number; admissions: number; failedAdmissions: number;
}
export interface MemoryBudgetClient { evictOne: () => boolean; }

const units: Record<string, number> = { B: 1, KB: 1000, MB: 1e6, GB: 1e9, KiB: 1024, MiB: 2 ** 20, GiB: 2 ** 30 };
function parseLimit(value: MemoryLimit, capacity: number): number {
  if (typeof value === 'number') return value;
  const percent = /^([\d.]+)%$/.exec(value);
  if (percent) return capacity * Number(percent[1]) / 100;
  const bytes = /^([\d.]+)(B|KB|MB|GB|KiB|MiB|GiB)$/.exec(value);
  if (bytes) return Number(bytes[1]) * units[bytes[2]];
  throw new RangeError(`Invalid memory limit: ${String(value)}`);
}

/** Shared, process-local byte ledger for all cache namespaces. */
export class MemoryBudget {
  readonly hardCap: number;
  readonly minMemory?: number;
  private target: number;
  private used = 0;
  private readonly categories = new Map<string, number>();
  private readonly clients: MemoryBudgetClient[] = [];
  private cursor = 0;
  private state: MemoryBudgetSnapshot['pressureState'] = 'normal';
  private pressureAt?: number;
  private recoveryAt?: number;
  private timer?: any;
  private evictions = 0;
  private admissions = 0;
  private failedAdmissions = 0;
  private readonly now: () => number;
  private readonly opts: MemoryBudgetOptions;
  private signals: MemorySignals;

  constructor(options: MemoryBudgetOptions) {
    this.opts = options;
    this.now = options.now ?? Date.now;
    this.signals = readMemorySignals(options.memory);
    const capacity = this.signals.effectiveBytes ?? (typeof options.maxMemory === 'number' ? options.maxMemory : 0);
    this.hardCap = Math.floor(parseLimit(options.maxMemory, capacity));
    if (!Number.isFinite(this.hardCap) || this.hardCap <= 0) throw new RangeError('maxMemory must resolve to a positive finite number');
    this.minMemory = options.minMemory === undefined ? undefined : Math.floor(parseLimit(options.minMemory, capacity));
    if (this.minMemory !== undefined && (this.minMemory <= 0 || this.minMemory > this.hardCap)) throw new RangeError('minMemory must be positive and no greater than maxMemory');
    this.target = this.hardCap;
  }

  register(client: MemoryBudgetClient | (() => boolean)): () => void {
    const value = typeof client === 'function' ? { evictOne: client } : client;
    this.clients.push(value);
    if (!this.timer && this.opts.sampleIntervalMs !== 0) this.startSampling(this.opts.sampleIntervalMs ?? 5000);
    let active = true;
    return () => { if (!active) return; active = false; const i = this.clients.indexOf(value); if (i >= 0) this.clients.splice(i, 1); if (!this.clients.length) this.stopSampling(); };
  }
  tryReserve(bytes: number, category: MemoryCategory = 'fresh'): boolean {
    if (!Number.isFinite(bytes) || bytes < 0) return false;
    if (this.used + bytes > this.target) { this.failedAdmissions++; return false; }
    this.used += bytes; this.categories.set(category, (this.categories.get(category) ?? 0) + bytes); this.admissions++; return true;
  }
  release(bytes: number, category: MemoryCategory = 'fresh'): void {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    const prior = this.categories.get(category) ?? 0;
    const amount = Math.min(bytes, prior, this.used);
    if (!amount) return;
    this.categories.set(category, prior - amount); this.used -= amount;
  }
  sample(signals?: MemorySignals | MemorySignalReader): MemoryBudgetSnapshot {
    this.signals = signals && 'available' in signals ? signals as MemorySignals : readMemorySignals(signals as MemorySignalReader | undefined);
    const now = this.now();
    const available = this.signals.availableBytes;
    const ratio = available !== undefined && this.hardCap > 0 ? available / this.hardCap : undefined;
    const critical = this.used > this.hardCap || (ratio !== undefined && ratio < 0.05);
    const pressured = !critical && (this.used > this.target || (ratio !== undefined && ratio < 0.15));
    if (critical) { this.state = 'critical'; this.target = Math.max(this.minMemory ?? 1, Math.floor(this.hardCap * 0.7)); this.pressureAt = now; }
    else if (pressured) { this.pressureAt ??= now; this.recoveryAt = undefined; if (now - this.pressureAt >= (this.opts.pressureWindowMs ?? 5000)) { this.state = 'pressure'; this.target = Math.max(this.minMemory ?? 1, Math.floor(this.hardCap * 0.7)); } }
    else { this.recoveryAt ??= now; this.pressureAt = undefined; if (now - this.recoveryAt >= (this.opts.recoveryWindowMs ?? 30000)) { this.state = 'normal'; this.target = Math.min(this.hardCap, this.target + Math.max(1, Math.floor(this.hardCap * 0.05))); } }
    if (this.state !== 'normal' || this.used > this.target) this.evictBounded(32);
    return this.snapshot();
  }
  /** Admission gate for gradual recovery; callers can use it before promotions. */
  permitsPromotion(bytes = 0): boolean { return Number.isFinite(bytes) && bytes >= 0 && this.used + bytes <= this.target; }
  snapshot(): MemoryBudgetSnapshot { return { hardCap: this.hardCap, target: this.target, accountedBytes: this.used, pressureState: this.state, categories: Object.fromEntries(this.categories), clients: this.clients.length, signals: this.signals, evictions: this.evictions, admissions: this.admissions, failedAdmissions: this.failedAdmissions }; }
  private evictBounded(max: number): void { for (let n = 0; n < max && this.clients.length; n++) { const c = this.clients[this.cursor++ % this.clients.length]; try { if (c.evictOne()) this.evictions++; } catch { /* an individual client must not extend maintenance work */ } } }
  private startSampling(ms: number): void { const timer = this.opts.setTimer ?? ((fn, delay) => setInterval(fn, delay)); this.timer = timer(() => this.sample(), ms); this.timer?.unref?.(); }
  private stopSampling(): void { if (this.timer) (this.opts.clearTimer ?? clearInterval)(this.timer); this.timer = undefined; }
}

let defaultBudget: MemoryBudget | undefined;
export function getDefaultMemoryBudget(options?: MemoryBudgetOptions): MemoryBudget {
  if (!defaultBudget) defaultBudget = new MemoryBudget(options ?? { maxMemory: '20%', sampleIntervalMs: 5000 });
  else if (options) {
    const capacity = readMemorySignals(options.memory).effectiveBytes ?? (typeof options.maxMemory === 'number' ? options.maxMemory : 0);
    if (parseLimit(options.maxMemory, capacity) !== defaultBudget.hardCap) throw new Error('Conflicting shared memory budget configuration');
  }
  return defaultBudget;
}
export function resetDefaultMemoryBudget(): void { defaultBudget = undefined; }

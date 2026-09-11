import { DEFAULT_BREAKER_COOLDOWN_MS, DEFAULT_BREAKER_FAILURE_THRESHOLD } from './defaults.js';

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  enabled?: boolean;
  failureThreshold?: number;
  cooldownMs?: number;
}

export class CircuitBreaker {
  private state: CircuitBreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private epoch = 0;
  private probeInFlight = false;

  constructor(private readonly options: CircuitBreakerOptions = {}) {}

  get currentState(): CircuitBreakerState {
    return this.state;
  }

  get currentEpoch(): number { return this.epoch; }

  canCall(): boolean {
    if (this.options.enabled === false) {
      return true;
    }

    if (this.state === 'closed') {
      return true;
    }

    if (this.state === 'open' && Date.now() - this.openedAt >= this.getCooldownMs()) {
      this.state = 'half-open';
      this.epoch += 1;
      this.probeInFlight = false;
    }
    if (this.state === 'half-open') {
      if (this.probeInFlight) return false;
      this.probeInFlight = true;
      return true;
    }
    return false;
  }

  recordSuccess(epoch?: number): void {
    if (this.options.enabled === false) {
      return;
    }

    if (epoch !== undefined && epoch !== this.epoch) return;
    this.state = 'closed';
    this.probeInFlight = false;
    this.failures = 0;
    this.openedAt = 0;
  }

  recordFailure(epoch?: number): CircuitBreakerState {
    if (this.options.enabled === false) {
      return this.state;
    }

    if (epoch !== undefined && epoch !== this.epoch) return this.state;
    if (this.state === 'half-open') {
      this.open();
      return this.state;
    }

    this.failures += 1;

    if (this.failures >= this.getFailureThreshold()) {
      this.open();
    }

    return this.state;
  }

  private open(): void {
    this.state = 'open';
    this.openedAt = Date.now();
    this.epoch += 1;
    this.probeInFlight = false;
  }

  private getFailureThreshold(): number {
    return this.options.failureThreshold ?? DEFAULT_BREAKER_FAILURE_THRESHOLD;
  }

  private getCooldownMs(): number {
    return this.options.cooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
  }
}

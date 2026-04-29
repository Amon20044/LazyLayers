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

  constructor(private readonly options: CircuitBreakerOptions = {}) {}

  get currentState(): CircuitBreakerState {
    return this.state;
  }

  canCall(): boolean {
    if (this.options.enabled === false) {
      return true;
    }

    if (this.state === 'closed') {
      return true;
    }

    if (this.state === 'open' && Date.now() - this.openedAt >= this.getCooldownMs()) {
      this.state = 'half-open';
      return true;
    }

    return this.state === 'half-open';
  }

  recordSuccess(): void {
    if (this.options.enabled === false) {
      return;
    }

    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
  }

  recordFailure(): CircuitBreakerState {
    if (this.options.enabled === false) {
      return this.state;
    }

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
  }

  private getFailureThreshold(): number {
    return this.options.failureThreshold ?? 3;
  }

  private getCooldownMs(): number {
    return this.options.cooldownMs ?? 30_000;
  }
}

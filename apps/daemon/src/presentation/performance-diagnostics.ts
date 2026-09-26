/**
 * Scoped local diagnostics for qualification runs. The sink is optional so
 * production requests do not retain timing samples or emit per-operation logs.
 */
export interface PerformanceDiagnosticsPort {
  recordDuration(name: string, milliseconds: number): void;
  increment(name: string, amount?: number): void;
  snapshot(): PerformanceDiagnosticsSnapshot;
}

export interface PerformanceDiagnosticsSnapshot {
  durationsMs: Record<string, number>;
  counts: Record<string, number>;
}

export class PerformanceDiagnostics implements PerformanceDiagnosticsPort {
  private readonly durations = new Map<string, number>();
  private readonly counts = new Map<string, number>();

  recordDuration(name: string, milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.durations.set(name, (this.durations.get(name) ?? 0) + milliseconds);
  }

  increment(name: string, amount = 1): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.counts.set(name, (this.counts.get(name) ?? 0) + amount);
  }

  snapshot(): PerformanceDiagnosticsSnapshot {
    return {
      durationsMs: Object.fromEntries([...this.durations].map(([name, value]) => [name, Math.round(value * 100) / 100])),
      counts: Object.fromEntries(this.counts),
    };
  }
}

export function recordElapsed(diagnostics: PerformanceDiagnosticsPort | undefined, name: string, startedAt: number): void {
  diagnostics?.recordDuration(name, performance.now() - startedAt);
}

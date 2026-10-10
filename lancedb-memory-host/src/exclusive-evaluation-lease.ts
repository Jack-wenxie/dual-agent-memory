export const EXCLUSIVE_EVALUATION_HEADER = "x-memory-exclusive-evaluation";
export const EXCLUSIVE_EVALUATION_ID_PATTERN = /^[a-f0-9]{64}$/u;

export type ExclusiveEvaluationOwner = Readonly<{
  id: string;
  generation: symbol;
}>;

type ActiveLease = {
  owner: ExclusiveEvaluationOwner;
  expiresAtMs: number;
  ownerCallsInFlight: number;
  releaseRequested: boolean;
};

export type ExclusiveEvaluationSnapshot = {
  active: boolean;
  ownerMatch: boolean;
  draining: boolean;
};

export type ExclusiveEvaluationInitializationReservation = Readonly<{
  id: string;
  generation: symbol;
}>;

/**
 * A synchronous, process-wide admission reservation. The HTTP initialize path
 * takes this reservation before its first await so two initialize requests can
 * never both observe an idle lease and continue into asynchronous readiness
 * checks.
 */
export class ExclusiveEvaluationInitializationGate {
  private pending: ExclusiveEvaluationInitializationReservation | null = null;

  reserve(id: string): ExclusiveEvaluationInitializationReservation | null {
    if (!ExclusiveEvaluationLease.validId(id) || this.pending) return null;
    const reservation = Object.freeze({ id, generation: Symbol("evaluation-initialize") });
    this.pending = reservation;
    return reservation;
  }

  release(reservation: ExclusiveEvaluationInitializationReservation): boolean {
    if (this.pending !== reservation) return false;
    this.pending = null;
    return true;
  }

  get active(): boolean {
    return this.pending !== null;
  }
}

/**
 * Process-local exclusive-evaluation lease.
 *
 * Release and TTL expiry are two-phase. They first mark the lease draining,
 * which rejects every new owner and foreign access while preserving exclusion
 * for owner work already in flight. The active lease is cleared only after the
 * final owner operation returns its release callback.
 */
export class ExclusiveEvaluationLease {
  private activeLease: ActiveLease | null = null;

  constructor(
    private readonly ttlMs = 15 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs < 1) {
      throw new Error("exclusive_evaluation_ttl_invalid");
    }
  }

  static validId(value: unknown): value is string {
    return typeof value === "string" && EXCLUSIVE_EVALUATION_ID_PATTERN.test(value);
  }

  private observeExpiry(): ActiveLease | null {
    const active = this.activeLease;
    if (!active) return null;
    if (!active.releaseRequested && active.expiresAtMs <= this.now()) {
      active.releaseRequested = true;
    }
    if (active.releaseRequested && active.ownerCallsInFlight === 0) {
      this.activeLease = null;
      return null;
    }
    return active;
  }

  private renew(active: ActiveLease): void {
    active.expiresAtMs = this.now() + this.ttlMs;
  }

  private acquireActive(active: ActiveLease): () => void {
    active.ownerCallsInFlight += 1;
    this.renew(active);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      if (this.activeLease !== active) return;
      active.ownerCallsInFlight = Math.max(0, active.ownerCallsInFlight - 1);
      this.observeExpiry();
    };
  }

  claim(id: string, ready: boolean): ExclusiveEvaluationOwner | null {
    if (!ExclusiveEvaluationLease.validId(id) || !ready) return null;
    if (this.observeExpiry()) return null;
    const owner = Object.freeze({ id, generation: Symbol("evaluation-owner") });
    this.activeLease = {
      owner,
      expiresAtMs: this.now() + this.ttlMs,
      ownerCallsInFlight: 0,
      releaseRequested: false,
    };
    return owner;
  }

  /** Header-only access used by health probes; never establishes ownership. */
  canAccess(id: string | null): boolean {
    const active = this.observeExpiry();
    if (!active) return true;
    if (active.releaseRequested || id !== active.owner.id) return false;
    this.renew(active);
    return true;
  }

  /** Exact-session access; stale sessions with a reused textual id stay denied. */
  sessionCanAccess(owner: ExclusiveEvaluationOwner | null): boolean {
    const active = this.observeExpiry();
    if (!active) return owner === null;
    if (active.releaseRequested || owner !== active.owner) return false;
    this.renew(active);
    return true;
  }

  /**
   * Atomically admits one memory-tool call. A null owner is admitted only while
   * no exclusive lease exists. The returned callback is idempotent.
   */
  acquire(owner: ExclusiveEvaluationOwner | null): (() => void) | null {
    const active = this.observeExpiry();
    if (!active) return owner === null ? () => {} : null;
    if (active.releaseRequested || owner !== active.owner) return null;
    return this.acquireActive(active);
  }

  /** Atomically accounts an owner health prewarm by its unexported lease id. */
  acquireById(id: string | null): (() => void) | null {
    const active = this.observeExpiry();
    if (!active || active.releaseRequested || id !== active.owner.id) return null;
    return this.acquireActive(active);
  }

  /**
   * Requests release for the exact owner generation. If work is in flight the
   * lease remains active and draining until its last callback completes.
   */
  release(owner: ExclusiveEvaluationOwner | null): boolean {
    const active = this.observeExpiry();
    if (!active || owner !== active.owner) return false;
    active.releaseRequested = true;
    this.observeExpiry();
    return true;
  }

  snapshot(id: string | null): ExclusiveEvaluationSnapshot {
    const active = this.observeExpiry();
    return {
      active: active !== null,
      ownerMatch: active !== null && id === active.owner.id,
      draining: active?.releaseRequested === true,
    };
  }
}
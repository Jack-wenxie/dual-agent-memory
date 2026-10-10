export class SingleflightTask {
  private inFlight: Promise<void> | null = null;
  private readonly onError: (error: unknown) => void;

  constructor(onError: (error: unknown) => void = () => {}) {
    this.onError = onError;
  }

  get active(): boolean {
    return this.inFlight !== null;
  }

  run(work: () => Promise<void>): boolean {
    if (this.inFlight !== null) return false;

    const workPromise = Promise.resolve().then(work);
    let tracked: Promise<void>;
    tracked = workPromise
      .catch((error: unknown) => {
        try { this.onError(error); } catch {}
      })
      .finally(() => {
        if (this.inFlight === tracked) this.inFlight = null;
      });
    this.inFlight = tracked;
    return true;
  }

  async waitForIdle(): Promise<void> {
    await this.inFlight;
  }
}

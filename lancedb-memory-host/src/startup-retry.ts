export type StartupRetryPhase = "attempting" | "retry_wait" | "succeeded" | "failed";

export type StartupRetryState = Readonly<{
  phase: StartupRetryPhase;
  attempt: number;
  maxAttempts: number;
  lastErrorCode: string | null;
  retryDelayMs: number | null;
}>;

type StartupRetryOptions<T> = {
  maxAttempts: number;
  retryDelaysMs: readonly number[];
  failureCode: string;
  unsafeRetryCode: string;
  attempt: (attempt: number) => Promise<T>;
  canRetry?: (failedAttempt: number) => boolean | Promise<boolean>;
  wait?: (delayMs: number) => Promise<void>;
  onState?: (state: StartupRetryState) => void;
};

const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{2,95}$/u;

export class BoundedStartupRetryError extends Error {
  readonly code: string;

  constructor(code: string, cause: unknown) {
    super(code, { cause });
    this.name = "BoundedStartupRetryError";
    this.code = code;
  }
}

function validateOptions<T>(options: StartupRetryOptions<T>): void {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 10) {
    throw new TypeError("startup_retry_max_attempts_invalid");
  }
  if (options.retryDelaysMs.length < options.maxAttempts - 1) {
    throw new TypeError("startup_retry_delays_incomplete");
  }
  for (const delayMs of options.retryDelaysMs.slice(0, options.maxAttempts - 1)) {
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 300_000) {
      throw new TypeError("startup_retry_delay_invalid");
    }
  }
  if (!SAFE_ERROR_CODE.test(options.failureCode) || !SAFE_ERROR_CODE.test(options.unsafeRetryCode)) {
    throw new TypeError("startup_retry_error_code_invalid");
  }
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function runBoundedStartupRetry<T>(
  options: StartupRetryOptions<T>,
): Promise<T> {
  validateOptions(options);
  const wait = options.wait ?? defaultWait;
  const publish = (
    phase: StartupRetryPhase,
    attempt: number,
    lastErrorCode: string | null,
    retryDelayMs: number | null,
  ): void => {
    options.onState?.(Object.freeze({
      phase,
      attempt,
      maxAttempts: options.maxAttempts,
      lastErrorCode,
      retryDelayMs,
    }));
  };

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    publish("attempting", attempt, null, null);
    try {
      const value = await options.attempt(attempt);
      publish("succeeded", attempt, null, null);
      return value;
    } catch (error) {
      if (attempt >= options.maxAttempts) {
        publish("failed", attempt, options.failureCode, null);
        throw new BoundedStartupRetryError(options.failureCode, error);
      }

      const retryDelayMs = options.retryDelaysMs[attempt - 1];
      publish("retry_wait", attempt, options.failureCode, retryDelayMs);
      try {
        await wait(retryDelayMs);
        if (options.canRetry && !(await options.canRetry(attempt))) {
          publish("failed", attempt, options.unsafeRetryCode, null);
          throw new BoundedStartupRetryError(options.unsafeRetryCode, error);
        }
      } catch (retryError) {
        if (retryError instanceof BoundedStartupRetryError) throw retryError;
        publish("failed", attempt, options.unsafeRetryCode, null);
        throw new BoundedStartupRetryError(options.unsafeRetryCode, retryError);
      }
    }
  }

  throw new BoundedStartupRetryError(options.failureCode, null);
}

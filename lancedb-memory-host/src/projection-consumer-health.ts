export interface ProjectionConsumerHealthSummary {
  status: string;
  fresh: boolean;
  queue?: Record<string, number>;
}

export function projectionConsumerHealthFromValue(
  value: unknown,
  options: { nowMs: number; notBeforeMs: number },
): ProjectionConsumerHealthSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'invalid', fresh: false };
  }
  const parsed = value as Record<string, unknown>;
  const status = typeof parsed.status === 'string' ? parsed.status : 'invalid';
  const updatedAt = typeof parsed.updated_at === 'string' ? Date.parse(parsed.updated_at) : Number.NaN;
  const freshnessMs = status === 'refreshing' || status === 'activating' ? 30_000 : 15_000;
  const fresh = Number.isFinite(updatedAt)
    && updatedAt >= options.notBeforeMs
    && options.nowMs - updatedAt <= freshnessMs;
  const queue = parsed.queue && typeof parsed.queue === 'object' && !Array.isArray(parsed.queue)
    ? Object.fromEntries(Object.entries(parsed.queue as Record<string, unknown>)
        .filter(([, item]) => Number.isSafeInteger(item) && Number(item) >= 0)
        .map(([key, item]) => [key, Number(item)]))
    : undefined;
  if (parsed.schema !== 'projection-mutation-consumer-health/v1'
      || !['idle', 'refreshing', 'activating', 'healthy', 'degraded'].includes(status)) {
    return { status: 'invalid', fresh: false };
  }
  return { status, fresh, ...(queue ? { queue } : {}) };
}

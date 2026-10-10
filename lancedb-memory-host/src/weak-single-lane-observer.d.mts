export function createWeakSingleLaneObserver(
  coordinator: unknown, options?: { enabled?: boolean },
): Readonly<{
  observe(outcome: unknown, lifecycle: unknown, options?: { action?: string }): Readonly<Record<string, unknown>>;
  privateShadowIndices(observation: unknown): readonly number[] | null;
}>;
export function classifyWeakSingleLane(result: unknown, row: unknown): string;

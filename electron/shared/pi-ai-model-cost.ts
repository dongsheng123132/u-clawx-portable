/**
 * Per-million-token rates expected by `@mariozechner/pi-ai` `calculateCost`.
 * Custom / synced catalog rows often omit pricing; zeros keep accounting stable
 * and avoid `Cannot read properties of undefined (reading 'input')` when usage
 * chunks arrive during openai-completions streaming.
 */
export const PI_AI_MODEL_ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

export type PiAiModelCostRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export function normalizePiAiModelCost(existing: unknown): PiAiModelCostRates {
  if (!existing || typeof existing !== 'object') {
    return { ...PI_AI_MODEL_ZERO_COST };
  }
  const record = existing as Record<string, unknown>;
  const num = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;

  return {
    input: num(record.input),
    output: num(record.output),
    cacheRead: num(record.cacheRead),
    cacheWrite: num(record.cacheWrite),
  };
}

/** Entry shape suitable for OpenClaw agent `models.json` provider.models[]. */
export function piAiModelsJsonModelEntry(
  id: string,
  name: string = id,
): { id: string; name: string; cost: PiAiModelCostRates } {
  return { id, name, cost: normalizePiAiModelCost(undefined) };
}

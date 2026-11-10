// Claude opens on Sonnet 5.5 when the owner has not chosen a model. The
// pinned OMP catalog names Opus 5.5 as Anthropic's default and lists its
// models alphabetically, so Kordi sets its own default and lists the current
// models first.

export const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5-5';

/** Current Claude models in the order the picker lists them, the default first. */
export const CLAUDE_MODEL_ORDER = [
  CLAUDE_DEFAULT_MODEL,
  'claude-opus-5-5',
  'claude-fable-5-2',
  'claude-haiku-5-5',
] as const;

/** Ranked models first in picker order; the rest keep their order after them. */
export function orderClaudeModels(models: readonly string[]): string[] {
  const rank = (model: string) => {
    const index = (CLAUDE_MODEL_ORDER as readonly string[]).indexOf(model);
    return index < 0 ? CLAUDE_MODEL_ORDER.length : index;
  };
  return [...new Set(models)]
    .map((model, position) => ({ model, position }))
    .sort((left, right) => rank(left.model) - rank(right.model) || left.position - right.position)
    .map(({ model }) => model);
}

/** A Claude catalog entry with the current models first and Sonnet 5.5 as its default; other entries, or a catalog without it, stay as they are. */
export function withClaudeModelCatalog<T extends { id: string; models: string[]; defaultModel?: string | null }>(entry: T): T {
  if (entry.id !== 'anthropic' || !entry.models.includes(CLAUDE_DEFAULT_MODEL)) return entry;
  return { ...entry, models: orderClaudeModels(entry.models), defaultModel: CLAUDE_DEFAULT_MODEL };
}

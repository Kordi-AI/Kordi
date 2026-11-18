// Kordi offers the four current Claude models for the Anthropic provider,
// Sonnet 5.5 first as the default. The pinned OMP catalog lists older, dated
// and preview models alphabetically and names Opus 5.5 as Anthropic's
// default, so only these ids are offered. Claude through other providers
// (Bedrock, Vertex, OpenRouter and so on) keeps those providers' lists.

export const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5-5';

/** The Claude models Kordi offers, in the order the picker lists them, the default first. */
export const CLAUDE_MODEL_ORDER = [
  CLAUDE_DEFAULT_MODEL,
  'claude-opus-5-5',
  'claude-fable-5-2',
  'claude-haiku-5-5',
] as const;

/** True for a model id Kordi offers for the Anthropic provider. */
export function isOfferedClaudeModel(modelId: string) {
  return (CLAUDE_MODEL_ORDER as readonly string[]).includes(modelId.trim().toLowerCase());
}

/** The offered Claude models among `models`, in picker order; any other model is dropped. */
export function orderClaudeModels(models: readonly string[]): string[] {
  const offered = new Set(models.map((model) => model.trim().toLowerCase()));
  return CLAUDE_MODEL_ORDER.filter((model) => offered.has(model));
}

/** The Anthropic catalog entry lists exactly the offered models, Sonnet 5.5 as its default; other entries stay as they are. */
export function withClaudeModelCatalog<T extends { id: string; models: string[]; defaultModel?: string | null }>(entry: T): T {
  if (entry.id !== 'anthropic' || entry.models.length === 0) return entry;
  return { ...entry, models: [...CLAUDE_MODEL_ORDER], defaultModel: CLAUDE_DEFAULT_MODEL };
}

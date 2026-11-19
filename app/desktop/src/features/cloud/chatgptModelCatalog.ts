// The ChatGPT models Kordi offers, in the order the picker lists them, newest
// first; the first is the default. The pinned OMP catalog lists more models
// alphabetically, may not know the newest ones yet, and includes internal
// "daybreak" ids, so only these ids are offered for ChatGPT and OpenAI.

export const CHATGPT_MODEL_ORDER = [
  'gpt-6.2-sol',
  'gpt-6.2-astra',
  'gpt-6.1-terra',
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
] as const;

export const CHATGPT_DEFAULT_MODEL = CHATGPT_MODEL_ORDER[0];

const chatGptProviderIds = new Set(['openai', 'openai-codex']);

export function isChatGptCatalogProvider(providerId: string) {
  return chatGptProviderIds.has(providerId.trim().toLowerCase());
}

function chatGptModelRank(modelId: string) {
  return (CHATGPT_MODEL_ORDER as readonly string[]).indexOf(modelId.trim().toLowerCase());
}

/** True for a model id Kordi offers for ChatGPT and OpenAI. */
export function isOfferedChatGptModel(modelId: string) {
  return chatGptModelRank(modelId) >= 0;
}

/** The offered ChatGPT models among `models`, in picker order; any other model is dropped. */
export function orderChatGptModels(models: readonly string[]): string[] {
  const offered = new Set(models.map((model) => model.trim().toLowerCase()));
  return CHATGPT_MODEL_ORDER.filter((model) => offered.has(model));
}

/** A ChatGPT catalog entry lists exactly the offered models, the first as its default. */
export function withChatGptModelCatalog<T extends { id: string; models: string[]; defaultModel?: string | null }>(entry: T): T {
  if (!isChatGptCatalogProvider(entry.id) || entry.models.length === 0) return entry;
  return { ...entry, models: [...CHATGPT_MODEL_ORDER], defaultModel: CHATGPT_DEFAULT_MODEL };
}

import { CHATGPT_MODEL_ORDER } from '@/features/cloud/chatgptModelCatalog';
import type { OmpCatalogEntry } from '@/kordi-app/auth/ompCatalog';
import { normalizeComposerProviderId } from '@/kordi-app/components/composerModelSelection';

// The thinking efforts OMP supports for a model, from the pinned catalog's
// `modelThinking`. ChatGPT routes share one family under `openai` and
// `openai-codex` (and the local `codex` alias).

function providerFamily(providerId: string) {
  const normalized = normalizeComposerProviderId(providerId);
  return normalized === 'codex' ? 'openai' : normalized;
}

/** A newer point release the catalog does not know yet uses its family's efforts: gpt-6.2-sol uses gpt-6-sol. */
function familyModelId(modelId: string) {
  return modelId.replace(/^(.*?\d+)\.\d+(?=-|$)/, '$1');
}

/** Offered ChatGPT models of the same tier, newest first: gpt-6.1-terra can use gpt-5.6-terra. */
function chatGptTierModelIds(family: string, modelId: string) {
  const tier = family === 'openai' ? /-(sol|astra|terra|luna)$/.exec(modelId)?.[1] : null;
  return tier ? CHATGPT_MODEL_ORDER.filter((id) => id.endsWith(`-${tier}`)) : [];
}

/** The catalog's efforts for a provider's model, or null when the catalog does not know it. */
export function catalogModelThinkingLevels(
  catalog: readonly OmpCatalogEntry[] | null | undefined,
  providerId: string,
  modelId: string,
): string[] | null {
  if (!catalog?.length) return null;
  const id = providerId.trim().toLowerCase();
  const family = providerFamily(id);
  const entries = [
    ...catalog.filter((entry) => entry.id === id),
    ...catalog.filter((entry) => entry.id !== id && providerFamily(entry.id) === family),
  ];
  const model = modelId.trim().toLowerCase();
  for (const candidate of [...new Set([model, familyModelId(model), ...chatGptTierModelIds(family, model)])]) {
    for (const entry of entries) {
      const efforts = entry.modelThinking?.[candidate]?.efforts;
      if (efforts?.length) return [...efforts];
    }
  }
  return null;
}

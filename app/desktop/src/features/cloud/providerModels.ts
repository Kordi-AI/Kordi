import { CHATGPT_MODEL_ORDER, isChatGptCatalogProvider } from '@/features/cloud/chatgptModelCatalog';
import { CLAUDE_MODEL_ORDER } from '@/features/cloud/claudeModelCatalog';

// Which models Kordi offers for a provider and which one it opens on.
// ChatGPT and OpenAI offer only Kordi's ChatGPT set, and the Anthropic
// provider only Kordi's Claude set; every other provider offers its whole
// list. One rule picks the model a provider opens on when nothing chose one.

type CatalogDefaults = readonly { id: string; defaultModel?: string | null }[];
type ModelOption = { value: string; provider?: string | null };

/** The models Kordi offers for a provider, in picker order and its default first; null when every listed model is offered. */
export function offeredModelOrder(providerId: string): readonly string[] | null {
  const id = providerId.trim().toLowerCase();
  if (isChatGptCatalogProvider(id) || id === 'codex') return CHATGPT_MODEL_ORDER;
  return id === 'anthropic' ? CLAUDE_MODEL_ORDER : null;
}

/** True when Kordi offers the model for the provider. */
export function isOfferedProviderModel(providerId: string, modelId: string) {
  const order = offeredModelOrder(providerId);
  return !order || order.includes(modelId.trim().toLowerCase());
}

/** A provider's models as Kordi offers them: its set in picker order, or the list unchanged. */
export function orderOfferedModels(providerId: string, models: readonly string[]): string[] {
  const order = offeredModelOrder(providerId);
  if (!order) return [...models];
  const listed = new Set(models.map((model) => model.trim().toLowerCase()));
  return order.filter((model) => listed.has(model));
}

function modelIdOf(value: string) {
  const separator = value.indexOf('/');
  return separator > 0 ? value.slice(separator + 1) : value;
}

function modelNamespace(option: ModelOption) {
  const separator = option.value.indexOf('/');
  return (separator > 0 ? option.value.slice(0, separator) : option.provider ?? '').trim().toLowerCase();
}

/**
 * A model list with only the offered models of ChatGPT, OpenAI and the
 * Anthropic provider, each provider's in picker order; other providers'
 * models keep their place.
 */
export function withOfferedModelOptions<T extends ModelOption>(options: readonly T[]): T[] {
  const limited = (option: T) => offeredModelOrder(option.provider ?? '');
  const queues = new Map<string, T[]>();
  for (const option of options) {
    const order = limited(option);
    if (!order || !order.includes(modelIdOf(option.value).toLowerCase())) continue;
    const provider = option.provider!.trim().toLowerCase();
    queues.set(provider, [...(queues.get(provider) ?? []), option]);
  }
  for (const [provider, queue] of queues) {
    const order = offeredModelOrder(provider)!;
    queue.sort((left, right) => order.indexOf(modelIdOf(left.value).toLowerCase()) - order.indexOf(modelIdOf(right.value).toLowerCase()));
  }
  return options.flatMap((option) => {
    const order = limited(option);
    if (!order) return [option];
    if (!order.includes(modelIdOf(option.value).toLowerCase())) return [];
    return [queues.get(option.provider!.trim().toLowerCase())!.shift()!];
  });
}

/**
 * The model a provider opens on when nothing chose one: Kordi's default for
 * ChatGPT, OpenAI and the Anthropic provider (else the first of Kordi's set
 * the provider lists), else the catalog's default, else the provider's first
 * model. Only a model the provider lists is returned, spelled as listed; null
 * when it lists none.
 */
export function providerDefaultModel(providerId: string, models: readonly string[], catalogDefault?: string | null): string | null {
  const listed = (model: string | null | undefined) => {
    const wanted = model?.trim().toLowerCase();
    return wanted ? models.find((item) => item.trim().toLowerCase() === wanted) ?? null : null;
  };
  const kordiDefault = offeredModelOrder(providerId)?.map(listed).find(Boolean);
  return kordiDefault ?? listed(catalogDefault) ?? models[0] ?? null;
}

/** The catalog's default for a provider, or null when the catalog has no entry or default for it. */
export function catalogDefaultModel(catalog: CatalogDefaults | null | undefined, providerId: string) {
  const id = providerId.trim().toLowerCase();
  return catalog?.find((entry) => entry.id === id)?.defaultModel ?? null;
}

/** A model list with each provider's default model marked `providerDefault`, by `providerDefaultModel`. */
export function withProviderDefaultModels<T extends ModelOption & { providerDefault?: boolean }>(
  options: readonly T[],
  catalog?: CatalogDefaults | null,
): T[] {
  const modelsByNamespace = new Map<string, string[]>();
  for (const option of options) {
    const namespace = modelNamespace(option);
    if (namespace) modelsByNamespace.set(namespace, [...(modelsByNamespace.get(namespace) ?? []), modelIdOf(option.value)]);
  }
  const defaults = new Map([...modelsByNamespace].map(([namespace, models]) => (
    [namespace, providerDefaultModel(namespace, models, catalogDefaultModel(catalog, namespace))]
  )));
  return options.map((option) => {
    const namespace = modelNamespace(option);
    const providerDefault = Boolean(namespace) && defaults.get(namespace) === modelIdOf(option.value);
    return Boolean(option.providerDefault) === providerDefault ? option : { ...option, providerDefault };
  });
}

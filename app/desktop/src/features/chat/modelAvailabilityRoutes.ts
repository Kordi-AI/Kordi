import { CHATGPT_MODEL_ORDER, isChatGptCatalogProvider } from '@/features/cloud/chatgptModelCatalog';
import {
  authChoiceFromProviderOption, composerModelsForProvider, composerProviderOptionUsable, matchingComposerAccountOption,
  modelInAccountNamespace, normalizeComposerProviderId, resolveComposerRoutePick,
  type ComposerModelOption, type ComposerModelSelection, type ComposerProviderOption, type ComposerRoute,
} from '@/kordi-app/components/composerModelSelection';
import { fallbackComposerThinkingValue } from '@/kordi-app/components/composerThinking';
import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { modelDisplayName } from '@/lib/modelDisplayName';
import {
  isAccountModelRefusal, isModelUnavailableForSignIn, modelAvailabilityForSignIn, modelAvailabilityModelId,
  recordModelAvailable, recordModelUnavailable, type SignInModel,
} from './modelAvailability';

const MAX_TRACKED_TURNS = 200;
/** The sign-in and model of each started turn, until it ends. */
const runningTurnRoutes = new Map<string, SignInModel>();
/** The sign-in and model of turns the provider refused, for the recovery action. */
const refusedTurnRoutes = new Map<string, SignInModel>();
/** The latest model list the picker showed, in catalog order. */
let knownModelOptions: readonly ComposerModelOption[] = [];

function remember(map: Map<string, SignInModel>, turnId: string, route: SignInModel) {
  map.delete(turnId);
  map.set(turnId, route);
  while (map.size > MAX_TRACKED_TURNS) map.delete(map.keys().next().value as string);
}

function routeProvider(route: { model?: string | null; authProvider?: string | null }) {
  const model = route.model?.trim() ?? '';
  return route.authProvider?.trim() || (model.indexOf('/') > 0 ? model.slice(0, model.indexOf('/')) : '');
}

/** The sign-in and model a route names, or null when it names no saved sign-in. */
export function signInModelForRoute(route: DesktopChatMessageRoute | ComposerModelSelection | null | undefined): SignInModel | null {
  const model = route?.model?.trim() ?? '';
  const authChoice = route?.authChoice?.trim() ?? '';
  const provider = route ? routeProvider(route) : '';
  if (!model || model === 'default' || !authChoice || !provider) return null;
  return { provider, authChoice, model };
}

/** Keeps the model list the picker shows, so a run can fall back in the same order. */
export function rememberModelCatalog(options: readonly ComposerModelOption[]) {
  if (options.length > 0) knownModelOptions = options;
}

/**
 * The models a sign-in may fall back to, in catalog order: the picker's list
 * for the provider, else the ChatGPT order for an OpenAI sign-in.
 */
function fallbackCandidates(provider: string, options: readonly ComposerModelOption[]): ComposerModelOption[] {
  const listed = composerModelsForProvider(provider, options).filter((option) => option.provider);
  if (listed.length > 0) return listed;
  if (!isChatGptCatalogProvider(provider)) return [];
  return CHATGPT_MODEL_ORDER.map((id) => ({ value: `${provider}/${id}`, label: id, provider: normalizeComposerProviderId(provider) }));
}

/** The first model in catalog order the sign-in has not been refused, other than `exclude`. */
export function bestAvailableModel({ provider, authChoice, exclude, options = knownModelOptions, now = Date.now() }: {
  provider: string;
  authChoice: string;
  exclude?: string | null;
  options?: readonly ComposerModelOption[];
  now?: number;
}): ComposerModelOption | null {
  const excluded = exclude ? modelAvailabilityModelId(exclude) : null;
  for (const option of fallbackCandidates(provider, options)) {
    const value = modelInAccountNamespace(option.value, provider);
    if (excluded && modelAvailabilityModelId(value) === excluded) continue;
    if (isModelUnavailableForSignIn({ provider, authChoice, model: value }, now)) continue;
    return value === option.value ? option : { ...option, value };
  }
  return null;
}

/**
 * The route a run uses: unchanged, or with the best available model when the
 * provider refused the route's model for its sign-in. A run then answers on
 * the next model instead of failing again.
 */
export function routeWithAvailableModel<T extends DesktopChatMessageRoute | null | undefined>(route: T, now = Date.now()): T {
  const signIn = signInModelForRoute(route);
  if (!route || !signIn || !isModelUnavailableForSignIn(signIn, now)) return route;
  const replacement = bestAvailableModel({ provider: signIn.provider, authChoice: signIn.authChoice, exclude: signIn.model, now });
  if (!replacement) return route;
  const thinking = route.thinking && replacement.thinkingLevels?.length
    ? fallbackComposerThinkingValue(replacement.thinkingLevels, route.thinking) : route.thinking;
  return { ...route, model: replacement.value, thinking };
}

/** Records what a finished turn says about its sign-in and model. */
export function observeTurnModelAvailability<T extends DesktopChatTurnSnapshot>(turn: T, now = Date.now()): T {
  const route = runningTurnRoutes.get(turn.id);
  if (!route || !turn.completed) return turn;
  runningTurnRoutes.delete(turn.id);
  if (turn.succeeded) recordModelAvailable(route, now);
  else if (isAccountModelRefusal(turn.error ?? turn.message)) {
    recordModelUnavailable(route, now);
    remember(refusedTurnRoutes, turn.id, route);
  }
  return turn;
}

/** Remembers the sign-in and model of a turn that just started. */
export function observeStartedTurn<T extends DesktopChatTurnSnapshot>(route: DesktopChatMessageRoute | null | undefined, turn: T, now = Date.now()): T {
  const signIn = signInModelForRoute(route);
  if (signIn && turn?.id) remember(runningTurnRoutes, turn.id, signIn);
  return turn?.id ? observeTurnModelAvailability(turn, now) : turn;
}

/** The sign-in and model of a refused turn this window ran, if any. */
export function refusedTurnRoute(turnId: string | null | undefined) {
  return turnId ? refusedTurnRoutes.get(turnId) ?? null : null;
}

export type ModelRecoveryPlan = { kind: 'sign-in' | 'model'; label: string; route: ComposerRoute };

/**
 * The one-click way out of a refused model: another sign-in of the provider
 * known to run that model keeps it, else the sign-in's best available model.
 * Null when the route has moved on since the refusal or nothing else is known.
 */
export function modelRecoveryPlan({ selection, providerOptions, modelOptions, refused, now = Date.now() }: {
  selection: ComposerModelSelection & { thinking: string };
  providerOptions: ComposerProviderOption[];
  modelOptions: ComposerModelOption[];
  refused?: SignInModel | null;
  now?: number;
}): ModelRecoveryPlan | null {
  const current = signInModelForRoute(selection);
  if (!current) return null;
  const failed = refused ?? current;
  if (failed.authChoice !== current.authChoice || modelAvailabilityModelId(failed.model) !== modelAvailabilityModelId(current.model)) return null;
  const family = normalizeComposerProviderId(failed.provider);
  const otherSignIn = providerOptions.find((option) => {
    const authChoice = authChoiceFromProviderOption(option);
    return composerProviderOptionUsable(option) && authChoice && authChoice !== failed.authChoice
      && normalizeComposerProviderId(option.providerId) === family
      && modelAvailabilityForSignIn({ provider: option.providerId, authChoice, model: failed.model }, now) === 'available';
  });
  if (otherSignIn) {
    const route = resolveComposerRoutePick({ selection, providerOptions, modelOptions, pick: { type: 'provider', option: otherSignIn } });
    if (route && modelAvailabilityModelId(route.model) === modelAvailabilityModelId(failed.model)) {
      return { kind: 'sign-in', label: `Use ${otherSignIn.label}`, route };
    }
  }
  const account = matchingComposerAccountOption(selection.authProvider, selection.authChoice, providerOptions);
  if (!composerProviderOptionUsable(account)) return null;
  const replacement = bestAvailableModel({ provider: account!.providerId, authChoice: failed.authChoice, exclude: failed.model, options: modelOptions, now });
  if (!replacement) return null;
  const route = resolveComposerRoutePick({ selection, providerOptions, modelOptions, pick: { type: 'model', value: replacement.value } });
  if (!route || route.providerOption?.value !== account!.value || modelAvailabilityModelId(route.model) === modelAvailabilityModelId(failed.model)) return null;
  return { kind: 'model', label: `Use ${modelDisplayName(route.model, modelOptions.find((option) => option.value === route.model)?.label)}`, route };
}

export function resetModelAvailabilityRoutesForTests() {
  runningTurnRoutes.clear();
  refusedTurnRoutes.clear();
  knownModelOptions = [];
}

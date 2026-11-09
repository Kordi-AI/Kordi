import { useSyncExternalStore } from 'react';

// Which models a saved sign-in can use, as this Mac has seen. A provider can
// refuse a model for one account and plan and serve it for another (a ChatGPT
// plan and a work account, for example), and no catalog says so ahead of time.
// The record is local, holds identifiers only, and expires so a plan change
// shows up again.

/** One model on one saved sign-in. Identifiers only, never a credential. */
export type SignInModel = { provider: string; authChoice: string; model: string };

export type ModelAvailabilityState = 'available' | 'unavailable' | 'unknown';

type Entry = SignInModel & { state: Exclude<ModelAvailabilityState, 'unknown'>; atMs: number };

export const MODEL_AVAILABILITY_STORAGE_KEY = 'kordi.modelAvailability.v1';
export const MODEL_AVAILABILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;

let entries: Map<string, Entry> | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** `openai-codex` and `openai` are one provider family. */
export function modelAvailabilityProviderFamily(provider: string) {
  const normalized = provider.trim().toLowerCase();
  return normalized === 'openai-codex' ? 'openai' : normalized;
}

/** The model id without its provider namespace: `openai-codex/x` and `openai/x` are one model. */
export function modelAvailabilityModelId(model: string) {
  const value = model.trim();
  const separator = value.indexOf('/');
  return (separator > 0 ? value.slice(separator + 1) : value).toLowerCase();
}

function keyOf(route: SignInModel) {
  return [modelAvailabilityProviderFamily(route.provider), route.authChoice.trim(), modelAvailabilityModelId(route.model)].join('\u0000');
}

function validRoute(route: SignInModel | null | undefined): route is SignInModel {
  return Boolean(route?.provider.trim() && route.authChoice.trim() && modelAvailabilityModelId(route.model));
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function load(): Map<string, Entry> {
  if (entries) return entries;
  entries = new Map();
  try {
    const parsed = JSON.parse(storage()?.getItem(MODEL_AVAILABILITY_STORAGE_KEY) ?? 'null') as { entries?: unknown } | null;
    for (const value of Array.isArray(parsed?.entries) ? parsed.entries : []) {
      const entry = value as Partial<Entry>;
      if (typeof entry.provider !== 'string' || typeof entry.authChoice !== 'string' || typeof entry.model !== 'string') continue;
      if ((entry.state !== 'available' && entry.state !== 'unavailable') || typeof entry.atMs !== 'number') continue;
      entries.set(keyOf(entry as Entry), entry as Entry);
    }
  } catch {
    // An unreadable record starts empty; the next write replaces it.
  }
  return entries;
}

function save(now: number) {
  const current = load();
  for (const [key, entry] of current) {
    if (now - entry.atMs > MODEL_AVAILABILITY_TTL_MS) current.delete(key);
  }
  const kept = [...current.values()].sort((left, right) => right.atMs - left.atMs).slice(0, MAX_ENTRIES);
  entries = new Map(kept.map((entry) => [keyOf(entry), entry]));
  try {
    storage()?.setItem(MODEL_AVAILABILITY_STORAGE_KEY, JSON.stringify({ entries: kept }));
  } catch {
    // Without storage the record lasts for this window only.
  }
  version += 1;
  for (const listener of listeners) listener();
}

function record(route: SignInModel | null | undefined, state: Entry['state'], now: number) {
  if (!validRoute(route)) return;
  const current = load().get(keyOf(route));
  if (current?.state === state && now - current.atMs < 60_000) return;
  load().set(keyOf(route), {
    provider: route.provider.trim(), authChoice: route.authChoice.trim(), model: route.model.trim(), state, atMs: now,
  });
  save(now);
}

/** The provider refused this model for this sign-in. */
export function recordModelUnavailable(route: SignInModel | null | undefined, now = Date.now()) {
  record(route, 'unavailable', now);
}

/** A turn on this sign-in and model succeeded, which also clears a refusal. */
export function recordModelAvailable(route: SignInModel | null | undefined, now = Date.now()) {
  record(route, 'available', now);
}

/** A new sign-in can bring another plan, so it forgets what the provider's sign-ins could use. */
export function clearProviderModelAvailability(provider: string | null | undefined, now = Date.now()) {
  const family = provider ? modelAvailabilityProviderFamily(provider) : '';
  if (!family) return;
  const current = load();
  let changed = false;
  for (const [key, entry] of current) {
    if (modelAvailabilityProviderFamily(entry.provider) !== family) continue;
    current.delete(key);
    changed = true;
  }
  if (changed) save(now);
}

export function modelAvailabilityForSignIn(route: SignInModel | null | undefined, now = Date.now()): ModelAvailabilityState {
  if (!validRoute(route)) return 'unknown';
  const entry = load().get(keyOf(route));
  return entry && now - entry.atMs <= MODEL_AVAILABILITY_TTL_MS ? entry.state : 'unknown';
}

export function isModelUnavailableForSignIn(route: SignInModel | null | undefined, now = Date.now()) {
  return modelAvailabilityForSignIn(route, now) === 'unavailable';
}

/**
 * The provider's own refusal of the model for this account: the runtime's
 * fixed wording or the provider's code. An unknown model id is a catalog
 * problem rather than the account's, so it is not one.
 */
export function isAccountModelRefusal(error: unknown) {
  const text = (error instanceof Error ? error.message : typeof error === 'string' ? error : '').toLowerCase();
  return text.includes('the selected model is unavailable for this account')
    || text.includes('model_not_found')
    || /model is not supported when using .{1,60} account/.test(text);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

if (typeof window !== 'undefined') {
  // Another window of the app recorded or cleared an entry.
  window.addEventListener('storage', (event) => {
    if (event.key !== MODEL_AVAILABILITY_STORAGE_KEY) return;
    entries = null;
    version += 1;
    for (const listener of listeners) listener();
  });
}

/** Re-renders when the record changes; read availability with the functions above. */
export function useModelAvailabilityVersion() {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

export function resetModelAvailabilityForTests() {
  entries = new Map();
  version += 1;
}

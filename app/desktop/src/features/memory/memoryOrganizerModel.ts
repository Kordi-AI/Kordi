// Settings › Memory organizer: the labels of each memory row (categories, cards, origin) and the
// filters built from them. Within a layer any chosen label matches; across layers all must match.

import { CloudAuthError } from '@/features/cloud/cloudAuthError';

import { MAX_MEMORY_CATEGORIES, MEMORY_CATEGORIES, memoryCategoriesOf, type MemoryCategory } from './memoryCategory';
import { isOwnMemory, type MemoryLesson } from './memoryModel';

/** One of the owner's Grounding profiles, shown as a card label. */
export type MemoryCard = { profileId: string; kind: string; name: string };

/** The filter key of the "Every card" label. */
export const EVERY_CARD = 'every';

const FIXED_KINDS = new Set(['work', 'health', 'daily']);
const EVERY_CARD_CATEGORY: MemoryCategory = 'coordination_context';
/** Categories a group memory may not use (the server answers `memory_category_not_shared`). */
const PRIVATE_CATEGORIES = new Set<MemoryCategory>(['health_context', 'location_context', 'purchase_history_preferences', 'values_and_ethics']);

export type MemoryRowCards = {
  /** A schedule memory every fixed card lists through its category. */
  every: boolean;
  /** The other cards on the row, each removable. */
  cards: MemoryCard[];
};

export function cardLabel(card: Pick<MemoryCard, 'name'>): string {
  const name = card.name.trim() || 'Untitled';
  return /\bcard$/i.test(name) ? name : `${name} card`;
}

/** The card labels of a row. Group memories and rows without cards have none. */
export function memoryRowCards(lesson: MemoryLesson, cards: readonly MemoryCard[]): MemoryRowCards {
  if (lesson.scope === 'group' || !lesson.profileIds?.length) return { every: false, cards: [] };
  const on = new Set(lesson.profileIds);
  const listed = cards.filter((card) => on.has(card.profileId));
  const fixed = cards.filter((card) => FIXED_KINDS.has(card.kind));
  const every = memoryCategoriesOf(lesson).includes(EVERY_CARD_CATEGORY) && fixed.length > 0 && fixed.every((card) => on.has(card.profileId));
  return { every, cards: every ? listed.filter((card) => !FIXED_KINDS.has(card.kind)) : listed };
}

/** The cards "+ Card" offers: the owner's cards the memory is not on. None for group or every-card rows. */
export function addableCards(lesson: MemoryLesson, cards: readonly MemoryCard[]): MemoryCard[] {
  if (lesson.scope === 'group') return [];
  if (memoryRowCards(lesson, cards).every) return [];
  const on = new Set(lesson.profileIds ?? []);
  return cards.filter((card) => !on.has(card.profileId));
}

/** Group memories change category only for the member who saved them. */
export function canChangeCategory(lesson: MemoryLesson, viewerAccountId: string | null | undefined): boolean {
  return lesson.scope !== 'group' || isOwnMemory(lesson, viewerAccountId);
}

/** The categories the category menu offers; group memories cannot use the private ones. */
export function categoryChoices(lesson: Pick<MemoryLesson, 'scope'>): MemoryCategory[] {
  return lesson.scope === 'group' ? MEMORY_CATEGORIES.filter((category) => !PRIVATE_CATEGORIES.has(category)) : [...MEMORY_CATEGORIES];
}

export type MemoryCategoryChoice = { category: MemoryCategory; checked: boolean; disabled: boolean };

/**
 * The category checklist (`memoryVersion` 4): every choice with its check. The only chosen category
 * cannot be unticked, and with three chosen the others cannot be ticked.
 */
export function categoryChecklist(lesson: Pick<MemoryLesson, 'scope' | 'category' | 'categories'>): MemoryCategoryChoice[] {
  const chosen = memoryCategoriesOf(lesson);
  return categoryChoices(lesson).map((category) => {
    const checked = chosen.includes(category);
    const disabled = checked ? chosen.length <= 1 : chosen.length >= MAX_MEMORY_CATEGORIES;
    return { category, checked, disabled };
  });
}

/** The categories after ticking or unticking one, in order (a new one goes last); null when the rules forbid it. */
export function toggleMemoryCategory(current: readonly MemoryCategory[], category: MemoryCategory): MemoryCategory[] | null {
  if (current.includes(category)) return current.length <= 1 ? null : current.filter((entry) => entry !== category);
  return current.length >= MAX_MEMORY_CATEGORIES ? null : [...current, category];
}

export type MemoryFilterLayer = 'card' | 'category' | 'from';
export type MemoryFilters = Record<MemoryFilterLayer, ReadonlySet<string>>;

export const NO_FILTERS: MemoryFilters = { card: new Set(), category: new Set(), from: new Set() };

export function toggleFilter(filters: MemoryFilters, layer: MemoryFilterLayer, value: string): MemoryFilters {
  const next = new Set(filters[layer]);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return { ...filters, [layer]: next };
}

export function hasFilter(filters: MemoryFilters): boolean {
  return filters.card.size + filters.category.size + filters.from.size > 0;
}

/** The filter keys a row carries in each layer: the labels it shows. */
export type MemoryRowKeys = { card: string[]; category: string[]; from: string[] };

export function rowKeys(lesson: MemoryLesson, cards: readonly MemoryCard[], originKey: string, withCards: boolean): MemoryRowKeys {
  const row = withCards ? memoryRowCards(lesson, cards) : { every: false, cards: [] };
  return {
    card: [...(row.every ? [EVERY_CARD] : []), ...row.cards.map((card) => card.profileId)],
    category: memoryCategoriesOf(lesson),
    from: [originKey],
  };
}

export function matchesFilters(keys: MemoryRowKeys, filters: MemoryFilters): boolean {
  return (['card', 'category', 'from'] as const).every((layer) => (
    filters[layer].size === 0 || keys[layer].some((key) => filters[layer].has(key))
  ));
}

export function matchesQuery(lesson: Pick<MemoryLesson, 'text'>, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  return !wanted || lesson.text.toLowerCase().includes(wanted);
}

export type MemoryFilterCounts = Record<MemoryFilterLayer, Map<string, number>>;

/** How many memories carry each label, over every memory of the account. */
export function filterCounts(rows: readonly MemoryRowKeys[]): MemoryFilterCounts {
  const counts: MemoryFilterCounts = { card: new Map(), category: new Map(), from: new Map() };
  for (const keys of rows) {
    for (const layer of ['card', 'category', 'from'] as const) {
      for (const key of keys[layer]) counts[layer].set(key, (counts[layer].get(key) ?? 0) + 1);
    }
  }
  return counts;
}

const CARD_ERRORS: Record<string, string> = {
  profile_not_found: 'That card no longer exists.',
  memory_profile_not_found: 'This memory is not on that card.',
  memory_profile_not_allowed: 'Group memories stay off cards.',
  memory_category_not_shared: 'Group memories cannot use this category.',
  invalid_update: 'Could not change this memory.',
};

/** One line for a failed category or card change; server codes read plainly. */
export function memoryChangeErrorMessage(caught: unknown): string {
  if (caught instanceof CloudAuthError && caught.code && CARD_ERRORS[caught.code]) return CARD_ERRORS[caught.code];
  return caught instanceof Error && caught.message ? caught.message : 'Could not change this memory. Try again.';
}

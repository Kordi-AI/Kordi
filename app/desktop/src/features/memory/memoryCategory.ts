/** The HCP category of a memory; it decides which Grounding profile the memory is filed to. */
export const MEMORY_CATEGORIES = [
  'general_preferences',
  'goals_and_constraints',
  'health_context',
  'education_learner_profile',
  'work_context',
  'purchase_history_preferences',
  'values_and_ethics',
  'location_context',
  'coordination_context',
  'hcp-custom:task_lessons',
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemoryDeclarationType = 'user-declared' | 'model-inferred';
export type MemoryConfidence = 'low' | 'medium' | 'high';
export type MemoryProfileKind = 'work' | 'health' | 'daily' | 'all' | 'custom';

// Shared with the iPhone app; keep both tables the same.
const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  work_context: 'Work',
  education_learner_profile: 'Learning',
  health_context: 'Health',
  coordination_context: 'Schedule',
  location_context: 'Location',
  purchase_history_preferences: 'Shopping',
  general_preferences: 'Preference',
  goals_and_constraints: 'Goal',
  values_and_ethics: 'Values',
  'hcp-custom:task_lessons': 'Task note',
};

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, value);
}

/** A memory has one to three categories (`memoryVersion` 4); the first is its main one. */
export const MAX_MEMORY_CATEGORIES = 3;

/**
 * A memory's known categories in order, without repeats and at most three. Older servers send only
 * `category`, which then stands alone; unknown categories are dropped so they show no chip.
 */
export function normalizeMemoryCategories(categories: unknown, category?: unknown): MemoryCategory[] {
  const listed = Array.isArray(categories) && categories.length > 0 ? categories : [category];
  const known: MemoryCategory[] = [];
  for (const value of listed) {
    if (isMemoryCategory(value) && !known.includes(value)) known.push(value);
  }
  return known.slice(0, MAX_MEMORY_CATEGORIES);
}

/** The categories of a memory as `normalizeMemoryCategories` reads them. */
export function memoryCategoriesOf(memory: { categories?: readonly unknown[] | null; category?: unknown }): MemoryCategory[] {
  return normalizeMemoryCategories(memory.categories, memory.category);
}

/** "Values, Work": the chip labels of several categories, in order. */
export function memoryCategoryListLabel(categories: readonly MemoryCategory[]): string {
  return categories.map((category) => CATEGORY_LABELS[category]).join(', ');
}

/** The chip label for a category; null for a missing or unknown one, which shows no chip. */
export function memoryCategoryLabel(category: string | null | undefined): string | null {
  return isMemoryCategory(category) ? CATEGORY_LABELS[category] : null;
}

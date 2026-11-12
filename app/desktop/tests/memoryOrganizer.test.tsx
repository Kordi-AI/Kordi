import assert from 'node:assert/strict';
import test from 'node:test';

import { act, createElement } from 'react';

import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import { createAccountMemoryClient, type AccountMemoryAuthClient, type AccountMemoryRoutes } from '../src/features/memory/accountMemoryClient';
import { MemorySettingsPanel } from '../src/features/memory/MemorySettingsPanel';
import { createPreviewMemoryClient, type MemoryClient } from '../src/features/memory/memoryClient';
import type { MemoryLesson } from '../src/features/memory/memoryModel';
import { lastPathSegment, memoryOrigin, type MemoryOriginSources } from '../src/features/memory/memoryOrigin';
import {
  NO_FILTERS,
  addableCards,
  cardLabel,
  categoryChecklist,
  filterCounts,
  matchesFilters,
  memoryChangeErrorMessage,
  memoryRowCards,
  rowKeys,
  toggleFilter,
  toggleMemoryCategory,
  type MemoryCard,
} from '../src/features/memory/memoryOrganizerModel';
import { memoryCategoriesOf, normalizeMemoryCategories, type MemoryCategory } from '../src/features/memory/memoryCategory';
import { PREVIEW_VIEWER_ACCOUNT_ID } from '../src/features/memory/memoryClient';

import { withJsdomRoot } from './helpers/mountWithJsdom';

const at = '2026-10-01T00:00:00.000Z';
const lesson = (lessonId: string, patch: Partial<MemoryLesson> = {}): MemoryLesson => ({
  lessonId, scope: 'global', scopeId: 'account', scopeLabel: 'Global', source: 'manual', text: `Memory ${lessonId}`, createdAt: at, updatedAt: at, ...patch,
});
const cards: MemoryCard[] = [
  { profileId: 'w', kind: 'work', name: 'Work' },
  { profileId: 'h', kind: 'health', name: 'Health' },
  { profileId: 'd', kind: 'daily', name: 'Daily' },
  { profileId: 'lab', kind: 'custom', name: 'Lab' },
];

test('organizer model: a schedule memory on every fixed card reads Every card; group rows have no cards', () => {
  assert.deepEqual(memoryRowCards(lesson('a', { category: 'coordination_context', profileIds: ['w', 'h', 'd'] }), cards), { every: true, cards: [] });
  assert.deepEqual(memoryRowCards(lesson('a', { category: 'coordination_context', profileIds: ['w', 'h', 'd', 'lab'] }), cards).cards.map(cardLabel), ['Lab card']);
  // Removed from one card, the schedule memory lists its cards one by one, each removable.
  assert.deepEqual(memoryRowCards(lesson('a', { category: 'coordination_context', profileIds: ['w', 'd'] }), cards), { every: false, cards: [cards[0], cards[2]] });
  assert.deepEqual(memoryRowCards(lesson('a', { category: 'work_context', profileIds: [] }), cards), { every: false, cards: [] });
  assert.deepEqual(memoryRowCards(lesson('a', { scope: 'group', category: 'work_context', profileIds: ['w'] }), cards), { every: false, cards: [] });
  assert.deepEqual(addableCards(lesson('a', { category: 'work_context', profileIds: ['w'] }), cards).map((card) => card.profileId), ['h', 'd', 'lab']);
  assert.deepEqual(addableCards(lesson('a', { scope: 'group' }), cards), []);
  assert.deepEqual(addableCards(lesson('a', { category: 'coordination_context', profileIds: ['w', 'h', 'd'] }), cards), []);
  assert.equal(cardLabel({ name: 'Conference card' }), 'Conference card');
});

test('organizer model: any label within a layer matches, every layer must match', () => {
  const work = rowKeys(lesson('a', { category: 'work_context', profileIds: ['w', 'lab'] }), cards, 'global', true);
  const schedule = rowKeys(lesson('b', { category: 'coordination_context', profileIds: ['w', 'h', 'd'], scope: 'conversation', scopeId: 'c1' }), cards, 'conversation:c1', true);
  let filters = toggleFilter(NO_FILTERS, 'card', 'lab');
  assert.equal(matchesFilters(work, filters), true);
  assert.equal(matchesFilters(schedule, filters), false);
  filters = toggleFilter(filters, 'card', 'every');
  assert.equal(matchesFilters(schedule, filters), true);
  filters = toggleFilter(filters, 'from', 'global');
  assert.equal(matchesFilters(work, filters), true);
  assert.equal(matchesFilters(schedule, filters), false);
  filters = toggleFilter(filters, 'category', 'health_context');
  assert.equal(matchesFilters(work, filters), false);
  assert.deepEqual(rowKeys(lesson('c', { profileIds: ['w'] }), cards, 'global', false).card, []);
});

test('memory origins: chat titles, project names, group titles and Global, with the saved label as fallback', () => {
  const sources: MemoryOriginSources = {
    sessions: [
      { id: 'sess-1', title: 'Launch copy' },
      { id: 'sess-p', title: 'Fix build', projectId: '/projects/site', projectName: 'Site' },
      { id: 'session:group:local-g', title: 'Reading club' },
    ],
    conversations: [
      { id: 'cloud-ai', kind: 'ai', legacy_session_id: 'sess-old', shared_title: 'Trip planning' },
      { id: 'cloud-g', kind: 'group', legacy_session_id: 'session:group:local-g', shared_title: null, group_title: 'Design review' },
      { id: 'cloud-g2', kind: 'group', legacy_session_id: 'session:group:local-g', shared_title: null },
    ],
  };
  const origin = (patch: Partial<MemoryLesson>) => memoryOrigin(lesson('x', patch), sources);
  assert.deepEqual(origin({}), { key: 'global', label: 'Global' });
  assert.deepEqual(origin({ scope: 'conversation', scopeId: 'sess-1', scopeLabel: 'Old name' }), { key: 'conversation:sess-1', label: 'Launch copy' });
  assert.equal(origin({ scope: 'conversation', scopeId: 'sess-old', scopeLabel: 'Conversation' }).label, 'Trip planning');
  assert.equal(origin({ scope: 'conversation', scopeId: 'gone', scopeLabel: 'Saved title' }).label, 'Saved title');
  assert.equal(origin({ scope: 'conversation', scopeId: 'gone', scopeLabel: 'Conversation' }).label, 'Chat');
  assert.equal(origin({ scope: 'project', scopeId: '/projects/site', scopeLabel: '/projects/site' }).label, 'Site');
  assert.equal(origin({ scope: 'project', scopeId: '/projects/other/', scopeLabel: 'Project' }).label, 'other');
  assert.equal(origin({ scope: 'project', scopeId: 'p1', scopeLabel: '~/Projects/launch-site' }).label, 'launch-site');
  assert.equal(origin({ scope: 'group', scopeId: 'cloud-g', scopeLabel: 'Group' }).label, 'Design review');
  assert.equal(origin({ scope: 'group', scopeId: 'cloud-g2', scopeLabel: 'Group' }).label, 'Reading club');
  assert.equal(origin({ scope: 'group', scopeId: 'local-g', scopeLabel: 'Group' }).label, 'Reading club');
  assert.equal(origin({ scope: 'group', scopeId: 'unknown', scopeLabel: 'Group' }).label, 'Group');
  assert.equal(lastPathSegment('C:\\code\\kordi'), 'kordi');
});

async function flush() {
  for (let index = 0; index < 3; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function click(element: Element | null | undefined) {
  assert.ok(element, 'expected an element to click');
  await act(async () => { (element as HTMLElement).click(); });
  await flush();
}

const rowIds = (host: ParentNode) => [...host.querySelectorAll('[data-memory-lesson]')].map((row) => row.getAttribute('data-memory-lesson'));
const row = (host: ParentNode, id: string) => host.querySelector(`[data-memory-lesson="${id}"]`);
const labels = (host: ParentNode, id: string, kind: string) => [...(row(host, id)?.querySelectorAll(`[data-memory-label="${kind}"]`) ?? [])]
  .map((label) => label.querySelector('.mo-part')?.textContent ?? label.textContent);
const filterChip = (host: ParentNode, layer: string, text: string) => [...host.querySelectorAll(`[data-memory-filter-layer="${layer}"] button`)]
  .find((button) => button.firstChild?.textContent === text);

type Calls = Array<[string, string, string]>;

function spyingClient(): { client: MemoryClient; calls: Calls } {
  const client = createPreviewMemoryClient({ latencyMs: 0 });
  const calls: Calls = [];
  const spy = <K extends 'updateMemoryCategory' | 'addMemoryToCard' | 'removeMemoryFromCard'>(name: K) => {
    const original = client[name]!.bind(client);
    client[name] = async (lessonId: string, value: never) => {
      calls.push([name, lessonId, value]);
      return original(lessonId, value);
    };
  };
  spy('updateMemoryCategory');
  spy('addMemoryToCard');
  spy('removeMemoryFromCard');
  return { client, calls };
}

async function withOrganizer(client: MemoryClient, memoryVersion: number, run: (host: HTMLElement) => Promise<void>) {
  await withJsdomRoot(async (mount) => {
    const host = await mount(createElement(MemorySettingsPanel, { accountId: PREVIEW_VIEWER_ACCOUNT_ID, client, isNativeShell: false, memoryVersion }));
    await flush();
    await run(host);
  });
}

test('settings organizer: rows carry the category, cards and origin; group rows never show cards', async () => {
  await withOrganizer(createPreviewMemoryClient({ latencyMs: 0 }), 3, async (host) => {
    assert.match(host.textContent ?? '', /All memories · 10/);
    assert.deepEqual(labels(host, 'lesson-2', 'category'), ['Work']);
    assert.deepEqual(labels(host, 'lesson-2', 'card'), ['Work card', 'Lab card']);
    assert.deepEqual(labels(host, 'lesson-2', 'from'), ['Launch copy with Priya']);
    assert.match(row(host, 'lesson-2')?.textContent ?? '', /Saved by your agent · high confidence · /);
    assert.deepEqual(labels(host, 'lesson-3', 'every'), ['Every card']);
    assert.equal(row(host, 'lesson-3')?.querySelector('[data-memory-label="add-card"]'), null);
    assert.equal(row(host, 'lesson-3')?.querySelector('[data-memory-label="every"] .mo-icon'), null);
    // No card, no card chip.
    assert.deepEqual(labels(host, 'lesson-8', 'card'), []);
    assert.ok(row(host, 'lesson-8')?.querySelector('[data-memory-label="add-card"]'));
    assert.deepEqual(labels(host, 'lesson-5', 'from'), ['Launch site']);
    assert.deepEqual(labels(host, 'lesson-6', 'from'), ['kordi-plugins']);
    for (const id of ['lesson-7', 'lesson-10']) {
      assert.deepEqual(labels(host, id, 'from'), ['Design review']);
      assert.equal(row(host, id)?.querySelector('[data-memory-label="card"], [data-memory-label="every"], [data-memory-label="add-card"]'), null);
    }
    // The category menu is only on group memories the viewer saved, without the private categories.
    assert.equal(row(host, 'lesson-10')?.querySelector('[aria-label="Change category"]'), null);
    await click(row(host, 'lesson-7')?.querySelector('[aria-label="Change category"]'));
    const choices = [...host.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent);
    assert.ok(choices.includes('Schedule'));
    assert.equal(choices.includes('Health'), false);
    assert.doesNotMatch(host.textContent ?? '', /\b(pin|pinned|unpin|no profile|move to|no card)\b/i);
  });
});

test('settings organizer: filters combine across layers, labels toggle them, and Clear resets', async () => {
  await withOrganizer(createPreviewMemoryClient({ latencyMs: 0 }), 3, async (host) => {
    assert.deepEqual([...host.querySelectorAll('.mo-layer-name')].map((name) => name.textContent), ['Cards', 'Categories', 'From']);
    assert.equal(filterChip(host, 'card', 'Lab card')?.querySelector('.mo-count')?.textContent, '2');
    await click(filterChip(host, 'card', 'Lab card'));
    assert.deepEqual(rowIds(host), ['lesson-2', 'lesson-6']);
    await click(filterChip(host, 'card', 'Every card'));
    assert.deepEqual(rowIds(host), ['lesson-3', 'lesson-2', 'lesson-9', 'lesson-6']);
    // Clicking a row's origin label adds the From filter: Global and any of the chosen cards.
    await click(row(host, 'lesson-9')?.querySelector('[data-memory-label="from"]'));
    assert.deepEqual(rowIds(host), ['lesson-9']);
    await click(host.querySelector('.mo-clear'));
    assert.equal(rowIds(host).length, 10);
    assert.equal(host.querySelector('.mo-clear'), null);
    await click(row(host, 'lesson-5')?.querySelector('[data-memory-label="category"] .mo-part'));
    assert.deepEqual(rowIds(host), ['lesson-5', 'lesson-6']);
    assert.equal(filterChip(host, 'category', 'Task note')?.getAttribute('aria-pressed'), 'true');
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search memories"]');
    assert.ok(search);
    // react-dom loaded before this DOM existed, so it watches value changes through the legacy polyfill.
    Object.defineProperties(window.HTMLElement.prototype, {
      attachEvent: { configurable: true, value: () => undefined },
      detachEvent: { configurable: true, value: () => undefined },
    });
    await act(async () => {
      search.focus();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(search, 'nothing like this');
      search.dispatchEvent(new window.Event('input', { bubbles: true }));
      search.dispatchEvent(new window.KeyboardEvent('keyup', { bubbles: true }));
    });
    assert.deepEqual(rowIds(host), []);
    assert.match(host.textContent ?? '', /No memories match\./);
  });
});

test('settings organizer: the label menus call the matching PATCH', async () => {
  const { client, calls } = spyingClient();
  await withOrganizer(client, 3, async (host) => {
    await click(row(host, 'lesson-1')?.querySelector('[aria-label="Change category"]'));
    await click([...host.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent === 'Work'));
    assert.deepEqual(labels(host, 'lesson-1', 'category'), ['Work']);
    assert.deepEqual(labels(host, 'lesson-1', 'card'), ['Work card']);

    await click(row(host, 'lesson-8')?.querySelector('[data-memory-label="add-card"]'));
    const items = [...host.querySelectorAll('[role="menuitemcheckbox"]')];
    assert.deepEqual(items.map((item) => item.textContent), ['Work card', 'Health card', 'Daily card', 'Lab card']);
    await click(items[3]);
    assert.deepEqual(labels(host, 'lesson-8', 'card'), ['Lab card']);

    await click(row(host, 'lesson-2')?.querySelector('[aria-label="Remove from Work card"]'));
    assert.deepEqual(labels(host, 'lesson-2', 'card'), ['Lab card']);

    assert.deepEqual(calls, [
      ['updateMemoryCategory', 'lesson-1', 'work_context'],
      ['addMemoryToCard', 'lesson-8', 'cgp-preview-lab'],
      ['removeMemoryFromCard', 'lesson-2', 'cgp-preview-work'],
    ]);
  });
});

test('settings organizer: below memoryVersion 3 the card controls hide, and below 2 the category menu too', async () => {
  await withOrganizer(createPreviewMemoryClient({ latencyMs: 0 }), 2, async (host) => {
    assert.equal(rowIds(host).length, 10);
    assert.equal(host.querySelector('[data-memory-label="card"], [data-memory-label="every"], [data-memory-label="add-card"]'), null);
    assert.equal(host.querySelector('[data-memory-filter-layer="card"]'), null);
    assert.ok(host.querySelector('[aria-label="Change category"]'));
  });
  await withOrganizer(createPreviewMemoryClient({ latencyMs: 0 }), 1, async (host) => {
    assert.equal(rowIds(host).length, 10);
    assert.equal(host.querySelector('[aria-label="Change category"]'), null);
    assert.deepEqual(labels(host, 'lesson-2', 'category'), ['Work']);
    assert.deepEqual(labels(host, 'lesson-2', 'from'), ['Launch copy with Priya']);
  });
});

test('account memory client: cards and origin names load only for a signed-in account; card errors read plainly', async () => {
  const seen: Array<string | null> = [];
  const options = (signedIn: boolean) => ({
    authClient: {} as AccountMemoryAuthClient,
    memoryRoutes: {} as AccountMemoryRoutes,
    loadSession: async () => (signedIn ? { token: 'tok', accountId: 'acct', expiresAt: '2099-01-01T00:00:00Z' } : null),
    desktop: { isNativeShell: () => false } as never,
    loadCards: async () => cards,
    loadOriginSources: async (accountId: string | null) => {
      seen.push(accountId);
      return { sessions: [], conversations: [] };
    },
  });
  assert.deepEqual(await createAccountMemoryClient(options(true)).listCards!(), cards);
  assert.deepEqual(await createAccountMemoryClient(options(false)).listCards!(), []);
  await createAccountMemoryClient(options(true)).originSources!();
  await createAccountMemoryClient(options(false)).originSources!();
  assert.deepEqual(seen, ['acct', null]);
  // Without the PATCH route the change fails instead of pretending.
  await assert.rejects(createAccountMemoryClient(options(true)).addMemoryToCard!('m', 'w'), /Could not change this memory\./);
  const failure = (code: string, status: number) => new CloudAuthError(code as never, 'server text', status);
  assert.equal(memoryChangeErrorMessage(failure('memory_profile_not_allowed', 403)), 'Group memories stay off cards.');
  assert.equal(memoryChangeErrorMessage(failure('profile_not_found', 404)), 'That card no longer exists.');
  assert.equal(memoryChangeErrorMessage(failure('memory_profile_not_found', 404)), 'This memory is not on that card.');
  assert.equal(memoryChangeErrorMessage(failure('something_else', 500)), 'server text');
});

test('memory categories: categories fall back to the single category, drop unknown ones and repeats, and stop at three', () => {
  assert.deepEqual(normalizeMemoryCategories(undefined, 'work_context'), ['work_context']);
  assert.deepEqual(normalizeMemoryCategories([], 'work_context'), ['work_context']);
  assert.deepEqual(normalizeMemoryCategories(['values_and_ethics', 'work_context'], 'values_and_ethics'), ['values_and_ethics', 'work_context']);
  assert.deepEqual(normalizeMemoryCategories(['something_new', 'work_context', 'work_context']), ['work_context']);
  assert.deepEqual(normalizeMemoryCategories(['work_context', 'health_context', 'goals_and_constraints', 'values_and_ethics']), ['work_context', 'health_context', 'goals_and_constraints']);
  assert.deepEqual(normalizeMemoryCategories(undefined, 'something_new'), []);
  assert.deepEqual(memoryCategoriesOf(lesson('a')), []);
  assert.deepEqual(memoryCategoriesOf(lesson('a', { category: 'health_context' })), ['health_context']);
});

test('organizer model: the checklist keeps one to three categories and new ones go last', () => {
  const state = (categories: MemoryCategory[], scope: MemoryLesson['scope'] = 'global') => Object.fromEntries(
    categoryChecklist(lesson('a', { scope, category: categories[0], categories })).map((choice) => [choice.category, [choice.checked, choice.disabled]]),
  );
  // The only category cannot be unticked; the others can be ticked.
  let one = state(['work_context']);
  assert.deepEqual(one.work_context, [true, true]);
  assert.deepEqual(one.values_and_ethics, [false, false]);
  // With three, the unticked ones are disabled and the ticked ones can be unticked.
  one = state(['work_context', 'values_and_ethics', 'health_context']);
  assert.deepEqual(one.work_context, [true, false]);
  assert.deepEqual(one.goals_and_constraints, [false, true]);
  // Group memories offer only the shared categories.
  assert.deepEqual(Object.keys(state(['work_context'], 'group')), [
    'general_preferences', 'goals_and_constraints', 'education_learner_profile', 'work_context', 'coordination_context', 'hcp-custom:task_lessons',
  ]);
  assert.deepEqual(toggleMemoryCategory(['work_context'], 'values_and_ethics'), ['work_context', 'values_and_ethics']);
  assert.deepEqual(toggleMemoryCategory(['work_context', 'values_and_ethics'], 'work_context'), ['values_and_ethics']);
  assert.equal(toggleMemoryCategory(['work_context'], 'work_context'), null);
  assert.equal(toggleMemoryCategory(['work_context', 'values_and_ethics', 'health_context'], 'goals_and_constraints'), null);
});

test('organizer model: a memory counts toward and matches every one of its categories', () => {
  const both = rowKeys(lesson('a', { category: 'values_and_ethics', categories: ['values_and_ethics', 'work_context'] }), cards, 'global', true);
  const work = rowKeys(lesson('b', { category: 'work_context' }), cards, 'global', true);
  assert.deepEqual(both.category, ['values_and_ethics', 'work_context']);
  const counts = filterCounts([both, work]);
  assert.equal(counts.category.get('work_context'), 2);
  assert.equal(counts.category.get('values_and_ethics'), 1);
  assert.equal(matchesFilters(both, toggleFilter(NO_FILTERS, 'category', 'work_context')), true);
  assert.equal(matchesFilters(both, toggleFilter(NO_FILTERS, 'category', 'values_and_ethics')), true);
  assert.equal(matchesFilters(work, toggleFilter(NO_FILTERS, 'category', 'values_and_ethics')), false);
  // Schedule as a second category still reaches every card.
  assert.equal(memoryRowCards(lesson('c', { category: 'work_context', categories: ['work_context', 'coordination_context'], profileIds: ['w', 'h', 'd'] }), cards).every, true);
});

type CategoryCalls = Array<[string, string, MemoryCategory | readonly MemoryCategory[]]>;

function categorySpyingClient(): { client: MemoryClient; calls: CategoryCalls } {
  const client = createPreviewMemoryClient({ latencyMs: 0 });
  const calls: CategoryCalls = [];
  const single = client.updateMemoryCategory!.bind(client);
  const multiple = client.updateMemoryCategories!.bind(client);
  client.updateMemoryCategory = async (lessonId, category) => {
    calls.push(['updateMemoryCategory', lessonId, category]);
    return single(lessonId, category);
  };
  client.updateMemoryCategories = async (lessonId, categories) => {
    calls.push(['updateMemoryCategories', lessonId, [...categories]]);
    return multiple(lessonId, categories);
  };
  return { client, calls };
}

const menuItems = (host: ParentNode, id: string) => [...(row(host, id)?.querySelectorAll('[role="menu"] button') ?? [])] as HTMLButtonElement[];
const menuItem = (host: ParentNode, id: string, label: string) => menuItems(host, id).find((item) => item.textContent === label);
const status = (host: ParentNode) => host.querySelector('[data-memory-organizer] > [aria-live="polite"]')?.textContent;

test('settings organizer: with memoryVersion 4 a row shows every category and the checklist saves each tick, staying open', async () => {
  const { client, calls } = categorySpyingClient();
  await withOrganizer(client, 4, async (host) => {
    const chevrons = () => [...(row(host, 'lesson-1')?.querySelectorAll('[data-memory-label="category"] .mo-icon') ?? [])];
    assert.equal(host.querySelector('[aria-label="Change category"]'), null);
    assert.equal(chevrons()[0]?.getAttribute('aria-label'), 'Change categories');
    await click(chevrons()[0]);
    assert.ok(menuItems(host, 'lesson-1').every((item) => item.getAttribute('role') === 'menuitemcheckbox'));
    // The only category cannot be unticked.
    assert.equal(menuItem(host, 'lesson-1', 'Preference')?.getAttribute('aria-checked'), 'true');
    assert.equal(menuItem(host, 'lesson-1', 'Preference')?.disabled, true);
    assert.equal(menuItem(host, 'lesson-1', 'Work')?.disabled, false);
    assert.doesNotMatch(host.textContent ?? '', /primary/i);

    await click(menuItem(host, 'lesson-1', 'Work'));
    assert.deepEqual(labels(host, 'lesson-1', 'category'), ['Preference', 'Work']);
    assert.deepEqual(labels(host, 'lesson-1', 'card'), ['Work card']);
    assert.equal(status(host), 'Categories set to Preference, Work.');
    // One chevron, on the last category chip; the menu stays open.
    assert.equal(chevrons().length, 1);
    assert.equal(chevrons()[0].closest('[data-memory-label="category"]')?.getAttribute('data-memory-category'), 'work_context');
    assert.ok(row(host, 'lesson-1')?.querySelector('[role="menu"]'));
    assert.equal(menuItem(host, 'lesson-1', 'Preference')?.disabled, false);

    await click(menuItem(host, 'lesson-1', 'Goal'));
    assert.deepEqual(labels(host, 'lesson-1', 'category'), ['Preference', 'Work', 'Goal']);
    assert.equal(status(host), 'Categories set to Preference, Work, Goal.');
    // With three chosen the others are disabled.
    assert.equal(menuItem(host, 'lesson-1', 'Health')?.disabled, true);
    assert.equal(menuItem(host, 'lesson-1', 'Goal')?.disabled, false);
    // The row counts toward every category filter.
    assert.equal(filterChip(host, 'category', 'Goal')?.querySelector('.mo-count')?.textContent, '2');

    await click(menuItem(host, 'lesson-1', 'Preference'));
    await click(menuItem(host, 'lesson-1', 'Goal'));
    assert.deepEqual(labels(host, 'lesson-1', 'category'), ['Work']);
    assert.equal(status(host), 'Category set to Work.');
    assert.equal(menuItem(host, 'lesson-1', 'Work')?.disabled, true);
    await click(menuItem(host, 'lesson-1', 'Work'));

    assert.deepEqual(calls, [
      ['updateMemoryCategories', 'lesson-1', ['general_preferences', 'work_context']],
      ['updateMemoryCategories', 'lesson-1', ['general_preferences', 'work_context', 'goals_and_constraints']],
      ['updateMemoryCategories', 'lesson-1', ['work_context', 'goals_and_constraints']],
      ['updateMemoryCategories', 'lesson-1', ['work_context']],
    ]);

    // Group memories the viewer saved offer only the shared categories.
    await click(row(host, 'lesson-7')?.querySelector('[aria-label="Change categories"]'));
    const groupChoices = menuItems(host, 'lesson-7').map((item) => item.textContent);
    assert.ok(groupChoices.includes('Schedule'));
    assert.equal(groupChoices.includes('Health'), false);
    assert.equal(groupChoices.includes('Values'), false);
  });
});

test('settings organizer: before memoryVersion 4 the category menu keeps a single choice', async () => {
  const { client, calls } = categorySpyingClient();
  await withOrganizer(client, 3, async (host) => {
    assert.equal(host.querySelector('[aria-label="Change categories"]'), null);
    await click(row(host, 'lesson-1')?.querySelector('[aria-label="Change category"]'));
    assert.ok(menuItems(host, 'lesson-1').every((item) => item.getAttribute('role') === 'menuitemradio'));
    await click(menuItem(host, 'lesson-1', 'Work'));
    assert.equal(row(host, 'lesson-1')?.querySelector('[role="menu"]'), null);
    assert.deepEqual(labels(host, 'lesson-1', 'category'), ['Work']);
    assert.deepEqual(calls, [['updateMemoryCategory', 'lesson-1', 'work_context']]);
  });
});

test('account memory client: reads every category and replaces them with one PATCH', async () => {
  const calls: unknown[][] = [];
  const wire = (patch: Record<string, unknown>) => ({
    memoryId: 'mem-1', scope: 'global', scopeId: 'account', scopeLabel: null, source: 'outcome', text: 'No tobacco projects.', createdAt: at, updatedAt: at, ...patch,
  });
  const routes = {
    list: async () => ({
      memories: [
        wire({ category: 'values_and_ethics', categories: ['values_and_ethics', 'work_context'], sensitivity: 'personal' }),
        wire({ memoryId: 'mem-2', category: 'health_context' }),
      ],
      settings: { memoryEnabled: true, excludeSensitive: true },
    }),
    patch: async (token: string, memoryId: string, patch: unknown) => {
      calls.push([token, memoryId, patch]);
      return wire({ memoryId, category: 'work_context', categories: ['work_context', 'goals_and_constraints'] });
    },
  } as unknown as AccountMemoryRoutes;
  const client = createAccountMemoryClient({
    authClient: {} as AccountMemoryAuthClient,
    memoryRoutes: routes,
    loadSession: async () => ({ token: 'tok', accountId: 'acct', expiresAt: '2099-01-01T00:00:00Z' }),
    desktop: { isNativeShell: () => false } as never,
  });
  const [first, second] = await client.listLessons();
  assert.equal(first.category, 'values_and_ethics');
  assert.deepEqual(memoryCategoriesOf(first), ['values_and_ethics', 'work_context']);
  assert.equal('sensitivity' in first, false);
  assert.deepEqual(memoryCategoriesOf(second), ['health_context']);
  const changed = await client.updateMemoryCategories!('mem-1', ['work_context', 'goals_and_constraints']);
  assert.deepEqual(calls, [['tok', 'mem-1', { categories: ['work_context', 'goals_and_constraints'] }]]);
  assert.deepEqual(memoryCategoriesOf(changed), ['work_context', 'goals_and_constraints']);
});

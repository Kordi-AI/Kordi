import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GALLERY_HINT_TYPE, galleryHintOf, notifyCommonGroundGalleryEvents, subscribeGalleryHints, type CgGalleryHint } from '../src/features/commonGround/galleryHints';
import type { CgScreen } from '../src/features/commonGround/store';
import { GALLERY_ITEM_HINT_MAX, galleryItemKey, loadGallery, receiveGalleryHints } from '../src/features/commonGround/storeGallery';
import { CODE, comment, galleryReply, galleryStore, ITEMS } from './helpers/commonGroundGallery';
import type { Call, Reply } from './helpers/commonGroundServer';

const [runner, , flow] = ITEMS;
const listCalls = (calls: Call[]) => calls.filter((call) => call.method === 'GET' && call.url.endsWith('/gallery')).length;
const itemCalls = (calls: Call[], itemId: string) => calls.filter((call) => call.method === 'GET' && call.url.endsWith(`/gallery/${itemId}`)).length;
const itemHint = (...itemIds: string[]): CgGalleryHint => ({ code: CODE, itemId: itemIds[0] ?? null, itemIds, change: 'item' });
const listHint = (...itemIds: string[]): CgGalleryHint => ({ code: CODE, itemId: itemIds[0] ?? null, itemIds, change: 'list' });
const screenFor = (itemId: string): CgScreen => ({ name: 'galleryItem', code: CODE, itemId });
const entries = (store: Awaited<ReturnType<typeof galleryStore>>['store']) => store.getSnapshot().gallery.lists[CODE].items.map((entry) => [entry.itemId, entry.title, entry.commentCount]);

/** A store with the room's Gallery loaded, and an item screen open over it when `open` names one. */
async function loaded(routes: Record<string, Reply | Reply[]> = {}, open?: string) {
  const screen = open ? screenFor(open) : undefined;
  const server = await galleryStore({ [`GET rooms/${CODE}/gallery`]: galleryReply(), ...routes }, { screen });
  await loadGallery(server.store, CODE);
  if (screen) await server.store.loadScreen(screen);
  return server;
}

test('the hint parser reads the old and new payloads', () => {
  assert.deepEqual(galleryHintOf({ code: ` ${CODE} `, itemId: 'gi_runner' }), listHint('gi_runner'));
  assert.deepEqual(galleryHintOf({ code: CODE }), listHint());
  assert.deepEqual(galleryHintOf({ code: CODE, itemId: 'gi_runner', itemIds: ['gi_runner', ' gi_flow ', 7, ''], change: 'item' }), itemHint('gi_runner', 'gi_flow'));
  // An unknown change reads as list, and itemIds alone name the first item.
  assert.deepEqual(galleryHintOf({ code: CODE, itemIds: ['gi_flow'], change: 'renamed' }), listHint('gi_flow'));
  assert.deepEqual(galleryHintOf({ code: CODE, itemId: 'gi_runner', itemIds: 'gi_flow', change: 'item' }), itemHint('gi_runner'));
  assert.equal(galleryHintOf({ itemId: 'gi_runner' }), null);
  assert.equal(galleryHintOf(null), null);

  const heard: CgGalleryHint[][] = [];
  const stop = subscribeGalleryHints((hints) => heard.push(hints));
  notifyCommonGroundGalleryEvents([
    { eventType: GALLERY_HINT_TYPE, payload: { code: CODE, itemId: 'gi_runner', itemIds: ['gi_runner'], change: 'item' } },
    { eventType: GALLERY_HINT_TYPE, payload: { code: CODE, itemId: 'gi_runner', itemIds: ['gi_runner'], change: 'item' } },
    { eventType: GALLERY_HINT_TYPE, payload: { code: CODE, itemId: 'gi_runner' } },
  ]);
  stop();
  assert.deepEqual(heard, [[itemHint('gi_runner'), listHint('gi_runner')]]);
});

test('an item hint refetches only that listed item, never the list, and creates no item view', async () => {
  const renamed = { ...flow, title: 'Onboarding flow v2', commentCount: 2 };
  const { store, calls } = await loaded({ [`GET rooms/${CODE}/gallery/gi_flow`]: { status: 200, body: { item: renamed, comments: [comment('c1'), comment('c2')] } } });
  const before = store.getSnapshot().gallery.lists[CODE].items;
  await receiveGalleryHints(store, [itemHint('gi_flow')]);
  assert.equal(listCalls(calls), 1);
  assert.equal(itemCalls(calls, 'gi_flow'), 1);
  assert.deepEqual(entries(store), [['gi_runner', 'Runner cache notes', 3], ['gi_minutes', 'CI minutes by job', 0], ['gi_flow', 'Onboarding flow v2', 2]]);
  const after = store.getSnapshot().gallery.lists[CODE].items;
  assert.equal(after[0], before[0]);
  assert.equal(after[1], before[1]);
  assert.equal(store.getSnapshot().gallery.items[galleryItemKey(CODE, 'gi_flow')], undefined);
  // An item outside the loaded list, or a room whose list is not loaded, asks for nothing.
  await receiveGalleryHints(store, [itemHint('gi_other'), { ...itemHint('gi_flow'), code: '9999' }]);
  assert.equal(calls.filter((call) => call.method === 'GET' && call.url.includes('/gallery')).length, 2);
});

test('an item hint replaces a cached item view it does not have open', async () => {
  const fresh = { ...runner, commentCount: 1 };
  const { store, calls } = await loaded({ [`GET rooms/${CODE}/gallery/gi_runner`]: [{ status: 200, body: { item: runner, comments: [comment('c1'), comment('c2'), comment('c3')] } }, { status: 200, body: { item: fresh, comments: [comment('c3')] } }] }, 'gi_runner');
  store.back();
  assert.equal(store.top().name, 'results');
  await receiveGalleryHints(store, [itemHint('gi_runner')]);
  assert.equal(listCalls(calls), 1);
  assert.equal(itemCalls(calls, 'gi_runner'), 2);
  assert.deepEqual(store.getSnapshot().gallery.items[galleryItemKey(CODE, 'gi_runner')].comments.map((entry) => entry.commentId), ['c3']);
  assert.deepEqual(entries(store)[0], ['gi_runner', 'Runner cache notes', 1]);
});

test('an item hint for the open item refreshes its comments and its list entry', async () => {
  const added = { ...runner, commentCount: 4 };
  const { store, calls } = await loaded({ [`GET rooms/${CODE}/gallery/gi_runner`]: [{ status: 200, body: { item: runner, comments: [comment('c1')] } }, { status: 200, body: { item: added, comments: [comment('c1'), comment('c4')] } }] }, 'gi_runner');
  await receiveGalleryHints(store, [itemHint('gi_runner')]);
  assert.equal(listCalls(calls), 1);
  assert.equal(itemCalls(calls, 'gi_runner'), 2);
  assert.deepEqual(store.getSnapshot().gallery.items[galleryItemKey(CODE, 'gi_runner')].comments.map((entry) => entry.commentId), ['c1', 'c4']);
  assert.deepEqual(entries(store)[0], ['gi_runner', 'Runner cache notes', 4]);
  assert.equal(store.top().name, 'galleryItem');
});

test('a list hint, a hint without change, and an old payload refetch the list as before', async () => {
  const { store, calls } = await loaded();
  await receiveGalleryHints(store, [listHint('gi_flow')]);
  assert.equal(listCalls(calls), 2);
  await receiveGalleryHints(store, [{ code: CODE, itemId: 'gi_flow' }]);
  assert.equal(listCalls(calls), 3);
  await receiveGalleryHints(store, [galleryHintOf({ code: CODE, itemId: 'gi_flow' })!]);
  assert.equal(listCalls(calls), 4);
  // Any list hint for the room wins over item hints received with it.
  await receiveGalleryHints(store, [itemHint('gi_flow'), listHint()]);
  assert.equal(listCalls(calls), 5);
  assert.equal(itemCalls(calls, 'gi_flow'), 0);
});

test('item ids beyond the first reach the open item', async () => {
  const listed = { status: 200, body: { item: runner, comments: [] } };
  const { store, calls } = await loaded({
    [`GET rooms/${CODE}/gallery/gi_flow`]: { status: 200, body: { item: flow, comments: [comment('c1')] } },
    [`GET rooms/${CODE}/gallery/gi_runner`]: listed,
  }, 'gi_flow');
  assert.equal(itemCalls(calls, 'gi_flow'), 1);
  await receiveGalleryHints(store, [listHint('gi_runner', 'gi_flow')]);
  assert.equal(listCalls(calls), 2);
  assert.equal(itemCalls(calls, 'gi_flow'), 2);
  assert.equal(itemCalls(calls, 'gi_runner'), 0);
  await receiveGalleryHints(store, [itemHint('gi_runner', 'gi_flow')]);
  assert.equal(listCalls(calls), 2);
  assert.equal(itemCalls(calls, 'gi_flow'), 3);
  assert.equal(itemCalls(calls, 'gi_runner'), 1);
});

test('an item hint drops an item that is gone, turns the Gallery off without the route, and stays quiet otherwise', async () => {
  const { store, calls } = await loaded({
    [`GET rooms/${CODE}/gallery/gi_flow`]: { status: 404, body: { errorCode: 'common_ground_gallery_not_found', message: 'Gone.' } },
    [`GET rooms/${CODE}/gallery/gi_minutes`]: { status: 500, body: { errorCode: 'internal', message: 'Broken.' } },
  });
  await receiveGalleryHints(store, [itemHint('gi_flow')]);
  assert.equal(listCalls(calls), 1);
  assert.deepEqual(entries(store).map(([itemId]) => itemId), ['gi_runner', 'gi_minutes']);
  await receiveGalleryHints(store, [itemHint('gi_minutes')]);
  assert.deepEqual(entries(store).map(([itemId]) => itemId), ['gi_runner', 'gi_minutes']);
  assert.equal(store.getSnapshot().notice, null);
  assert.equal(store.getSnapshot().support.gallery, true);
  // The mock server has no route for gi_runner: an older server.
  await receiveGalleryHints(store, [itemHint('gi_runner')]);
  assert.equal(store.getSnapshot().support.gallery, false);
});

test('more than eight item ids for a room refetch the list instead', async () => {
  const { store, calls } = await loaded({ [`GET rooms/${CODE}/gallery/gi_runner`]: { status: 200, body: { item: runner, comments: [] } } });
  const many = ['gi_runner', ...Array.from({ length: GALLERY_ITEM_HINT_MAX }, (_, index) => `gi_extra${index}`)];
  assert.equal(many.length, GALLERY_ITEM_HINT_MAX + 1);
  await receiveGalleryHints(store, [itemHint(...many)]);
  assert.equal(listCalls(calls), 2);
  assert.equal(itemCalls(calls, 'gi_runner'), 0);
  // Eight is still within the limit, across hints received together.
  await receiveGalleryHints(store, [itemHint(...many.slice(0, 4)), itemHint(...many.slice(4, GALLERY_ITEM_HINT_MAX))]);
  assert.equal(listCalls(calls), 2);
  assert.equal(itemCalls(calls, 'gi_runner'), 1);
});

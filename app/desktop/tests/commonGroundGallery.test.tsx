import assert from 'node:assert/strict';
import { test } from 'node:test';

import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ACCOUNT_HINT_EVENT_TYPES } from '../src/features/cloud/accountHintEvents';
import { GALLERY_HINT_TYPE, notifyCommonGroundGalleryEvents, subscribeGalleryHints, type CgGalleryHint } from '../src/features/commonGround/galleryHints';
import { galleryKind, galleryTypeLabel } from '../src/features/commonGround/galleryFormat';
import { ResultsScreen } from '../src/features/commonGround/ResultsScreen';
import { loadGallery, receiveGalleryHints, removeFromGallery, setRoomTab, shareToGallery } from '../src/features/commonGround/storeGallery';
import { CODE, galleryHost, galleryReply, galleryStore, item, ITEMS, Room } from './helpers/commonGroundGallery';
import { buttonNamed, click, mount } from './helpers/nearbyScreen';

const host = galleryHost();
const markup = (store: Awaited<ReturnType<typeof galleryStore>>['store']) => (
  renderToStaticMarkup(createElement(ResultsScreen, { code: CODE, state: store.getSnapshot(), store, host }))
);
const galleryCalls = (calls: Array<{ url: string; method: string }>, suffix = '/gallery') => calls.filter((call) => call.method === 'GET' && call.url.endsWith(suffix));

const CANDIDATES = { status: 200, body: { artifacts: [
  { attachmentId: 'att_deploy', title: 'Preview deploy runbook', fileName: 'deploy.md', contentType: 'text/markdown', sizeBytes: 900, updatedAt: '2026-11-12T09:00:00Z', shared: false },
  { attachmentId: 'att_schema', title: 'Tool call types', fileName: 'schema.ts', contentType: 'text/plain', sizeBytes: 300, updatedAt: '2026-11-11T09:00:00Z', shared: false },
  { attachmentId: 'att_minutes', title: 'CI minutes by job', fileName: 'ci-minutes.csv', contentType: 'text/csv', sizeBytes: 300, updatedAt: '2026-11-10T09:00:00Z', shared: true },
] } };

test('a server without the Gallery routes leaves the room page exactly as before', async () => {
  const { store, calls } = await galleryStore({});
  const before = markup(store);
  await loadGallery(store, CODE, { quiet: true });
  assert.equal(store.getSnapshot().support.gallery, false);
  assert.equal(store.getSnapshot().notice, null);
  assert.equal(markup(store), before);
  assert.doesNotMatch(before, />Gallery</);
  // Once off, the route is not asked again.
  await loadGallery(store, CODE);
  assert.equal(galleryCalls(calls).length, 1);
});

test('a loaded Gallery adds the segment, cards with type, author and comments, and topic chips', async () => {
  const { store } = await galleryStore({ [`GET rooms/${CODE}/gallery`]: galleryReply() });
  await loadGallery(store, CODE);
  assert.match(markup(store), /role="tab"[^>]*>Gallery</);
  setRoomTab(store, CODE, 'gallery');
  const html = markup(store);
  assert.match(html, /Runner cache notes/);
  assert.match(html, /cg-type is-markdown is-chip[^>]*>MD</);
  assert.match(html, /cg-type is-pdf is-large[^>]*>PDF</);
  assert.match(html, /cg-gallery-card-who">Bea</);
  assert.match(html, /cg-gallery-card-who">You</);
  assert.match(html, /aria-label="3 comments"/);
  // Only my own card has More.
  assert.equal(html.match(/aria-label="More"/g)?.length, 1);
  // All, then the room topics that have items, in the room's order; Eval design has none.
  assert.deepEqual([...html.matchAll(/class="cg-gallery-chip"[^>]*>(?:<i[^>]*><\/i>)?([^<]+)</g)].map((match) => match[1]), ['All', 'Agent memory', 'Retrieval']);
  assert.match(html, /data-cg-gallery-share="">Share</);
  // People's list is not shown under the Gallery.
  assert.doesNotMatch(html, />Build caching</);
});

test('no chips without topics, an empty Gallery says so, and a closed room has no Share', async () => {
  const untopical = await galleryStore({ [`GET rooms/${CODE}/gallery`]: galleryReply([item('gi_a')]) });
  await loadGallery(untopical.store, CODE);
  setRoomTab(untopical.store, CODE, 'gallery');
  const plain = markup(untopical.store);
  assert.doesNotMatch(plain, /cg-gallery-chip"/);
  assert.match(plain, />Share</);

  const empty = await galleryStore({ [`GET rooms/${CODE}/gallery`]: galleryReply([]) });
  await loadGallery(empty.store, CODE);
  setRoomTab(empty.store, CODE, 'gallery');
  assert.match(markup(empty.store), /Nothing shared yet<\/span><button[^>]*>Share</);

  const closed = await galleryStore({ [`GET rooms/${CODE}/gallery`]: galleryReply(ITEMS, false) }, { open: false });
  await loadGallery(closed.store, CODE);
  setRoomTab(closed.store, CODE, 'gallery');
  const html = markup(closed.store);
  assert.match(html, /Runner cache notes/);
  assert.doesNotMatch(html, /data-cg-gallery-share/);
});

test('a topic chip filters the cards, and All shows them again', async () => {
  const { store } = await galleryStore({ [`GET rooms/${CODE}/gallery`]: galleryReply() });
  await loadGallery(store, CODE);
  setRoomTab(store, CODE, 'gallery');
  await mount(createElement(Room, { store, host }), async (root) => {
    const titles = () => [...root.querySelectorAll('.cg-gallery-card-title')].map((node) => node.textContent);
    assert.deepEqual(titles(), ['Runner cache notes', 'CI minutes by job', 'Onboarding flow']);
    await click(buttonNamed(root, 'Retrieval'));
    assert.deepEqual(titles(), ['CI minutes by job']);
    await click(buttonNamed(root, 'All'));
    assert.equal(titles().length, 3);
  });
});

test('Share picks my artifacts with a topic, says Share 2, and puts the new items first', async () => {
  const added = [item('gi_new1', { title: 'Preview deploy runbook', attachmentId: 'att_deploy', mine: true, topic: 'Retrieval' }), item('gi_new2', { title: 'Tool call types', attachmentId: 'att_schema', mine: true, topic: 'Retrieval' })];
  const { store, calls } = await galleryStore({
    [`GET rooms/${CODE}/gallery`]: galleryReply(),
    [`GET rooms/${CODE}/gallery/candidates`]: CANDIDATES,
    [`POST rooms/${CODE}/gallery`]: { status: 201, body: { items: added } },
  });
  await loadGallery(store, CODE);
  setRoomTab(store, CODE, 'gallery');
  await mount(createElement(Room, { store, host }), async (root) => {
    await click(root.querySelector('[data-cg-gallery-share]'));
    const dialog = document.body.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? '', /Share to Build night/);
    const rows = [...dialog.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
    assert.deepEqual(rows.map((row) => row.querySelector('.cg-row-title')?.textContent), ['Preview deploy runbook', 'Tool call types', 'CI minutes by job']);
    assert.equal(rows[2].disabled, true);
    assert.match(rows[2].textContent ?? '', /Shared/);
    const submit = () => [...dialog.querySelectorAll<HTMLButtonElement>('button[type="submit"]')][0];
    assert.equal(submit().textContent, 'Share');
    assert.equal(submit().disabled, true);
    await click(rows[0]);
    assert.equal(submit().textContent, 'Share');
    await click(rows[1]);
    assert.equal(submit().textContent, 'Share 2');
    const select = dialog.querySelector('select');
    assert.ok(select);
    assert.deepEqual([...select.options].map((option) => option.textContent), ['None', 'Agent memory', 'Retrieval', 'Eval design']);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select, 'Retrieval');
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await click(submit());
    const posted = calls.find((call) => call.method === 'POST' && call.url.endsWith('/gallery'));
    assert.deepEqual(posted?.body, { attachmentIds: ['att_deploy', 'att_schema'], topic: 'Retrieval' });
    assert.equal(document.body.querySelector('[role="dialog"]'), null);
    assert.deepEqual([...root.querySelectorAll('.cg-gallery-card-title')].slice(0, 2).map((node) => node.textContent), ['Preview deploy runbook', 'Tool call types']);
  });
});

test('the Share search says No matches, and a refused share keeps the dialog with the reason', async () => {
  const { store } = await galleryStore({
    [`GET rooms/${CODE}/gallery`]: galleryReply(),
    [`GET rooms/${CODE}/gallery/candidates`]: CANDIDATES,
    [`POST rooms/${CODE}/gallery`]: { status: 409, body: { errorCode: 'common_ground_gallery_limit', message: 'Limit reached.' } },
  });
  await loadGallery(store, CODE);
  setRoomTab(store, CODE, 'gallery');
  await mount(createElement(Room, { store, host }), async (root) => {
    await click(root.querySelector('[data-cg-gallery-share]'));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const search = dialog.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(search, 'zzz');
      search.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.match(dialog.textContent ?? '', /No matches/);
  });
  assert.equal(await shareToGallery(store, CODE, ['att_deploy'], null), false);
  assert.equal(store.getSnapshot().notice, 'You can share up to 20 items in a room.');
  assert.equal(store.getSnapshot().gallery.lists[CODE].items.length, ITEMS.length);
});

test('Remove from gallery deletes my item and drops its card', async () => {
  const { store, calls } = await galleryStore({
    [`GET rooms/${CODE}/gallery`]: galleryReply(),
    [`DELETE rooms/${CODE}/gallery/gi_minutes`]: { status: 204 },
  });
  await loadGallery(store, CODE);
  assert.equal(await removeFromGallery(store, CODE, 'gi_minutes'), true);
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/gallery/gi_minutes')));
  assert.deepEqual(store.getSnapshot().gallery.lists[CODE].items.map((entry) => entry.itemId), ['gi_runner', 'gi_flow']);
});

test('gallery hints reach the page once per batch and refetch the loaded Gallery and the open item', async () => {
  assert.ok(ACCOUNT_HINT_EVENT_TYPES.has(GALLERY_HINT_TYPE));
  const heard: CgGalleryHint[][] = [];
  const stop = subscribeGalleryHints((hints) => heard.push(hints));
  notifyCommonGroundGalleryEvents([
    { eventType: GALLERY_HINT_TYPE, payload: { code: CODE, itemId: 'gi_runner' } },
    { eventType: GALLERY_HINT_TYPE, payload: { code: CODE, itemId: 'gi_runner' } },
    { eventType: GALLERY_HINT_TYPE, payload: {} },
    { eventType: 'common_ground.room.updated', payload: { code: CODE } },
  ]);
  notifyCommonGroundGalleryEvents([{ eventType: 'common_ground.room.updated', payload: { code: CODE } }]);
  stop();
  assert.deepEqual(heard, [[{ code: CODE, itemId: 'gi_runner' }]]);

  const screen = { name: 'galleryItem' as const, code: CODE, itemId: 'gi_runner' };
  const { store, calls } = await galleryStore({
    [`GET rooms/${CODE}/gallery`]: galleryReply(),
    [`GET rooms/${CODE}/gallery/gi_runner`]: { status: 200, body: { item: ITEMS[0], comments: [] } },
  }, { screen });
  // Not loaded yet: a hint for another item asks for nothing.
  await receiveGalleryHints(store, [{ code: CODE, itemId: 'gi_flow' }]);
  assert.equal(galleryCalls(calls).length + galleryCalls(calls, '/gi_runner').length, 0);
  await loadGallery(store, CODE);
  await receiveGalleryHints(store, [{ code: CODE, itemId: 'gi_runner' }]);
  assert.equal(galleryCalls(calls).length, 2);
  assert.equal(galleryCalls(calls, '/gi_runner').length, 1);
});

test('kinds and type labels follow the file name, then the content type', () => {
  assert.equal(galleryKind('notes.md', null), 'markdown');
  assert.equal(galleryKind('page.html', 'text/html'), 'html');
  assert.equal(galleryKind('runner.ts', 'text/plain'), 'code');
  assert.equal(galleryKind('rows.csv', 'text/csv'), 'table');
  assert.equal(galleryKind('board.png', 'image/png'), 'image');
  assert.equal(galleryKind('flow.pdf', 'application/pdf'), 'pdf');
  assert.equal(galleryKind('deck.pptx', null), 'file');
  assert.equal(galleryKind('blob', 'image/jpeg'), 'image');
  assert.equal(galleryKind('blob.bin', 'application/octet-stream'), 'file');
  assert.equal(galleryTypeLabel('notes.markdown', 'markdown'), 'MD');
  assert.equal(galleryTypeLabel('runner.ts', 'code'), 'TS');
  assert.equal(galleryTypeLabel('README', 'code'), 'CODE');
});

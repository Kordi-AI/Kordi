import assert from 'node:assert/strict';
import { test } from 'node:test';

import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { GalleryItemScreen } from '../src/features/commonGround/GalleryItemScreen';
import { openGalleryItemExternally } from '../src/features/commonGround/galleryOpen';
import type { CgScreen } from '../src/features/commonGround/store';
import { addGalleryComment, deleteGalleryComment, galleryItemKey, loadGallery, removeFromGallery } from '../src/features/commonGround/storeGallery';
import type { CgGalleryItem, CgPerson, CgRelationship } from '../src/features/commonGround/types';
import { bea, CODE, comment, galleryHost, galleryReply, galleryStore, item, ITEMS, ItemPage, self, type Chat } from './helpers/commonGroundGallery';
import { rel } from './helpers/commonGroundServer';
import { buttonNamed, click, mount, settle } from './helpers/nearbyScreen';

const runner = ITEMS[0];
const screenFor = (itemId: string): CgScreen => ({ name: 'galleryItem', code: CODE, itemId });
// Dan is not in the room's results, so his item's relationship is the only one the store knows.
const dan = (relationship: CgRelationship): CgPerson => ({ accountId: 'acct_dan', name: 'Dan Moss', avatarUrl: null, relationship });
const COMMENTS = [comment('c1'), comment('c2', { person: self, mine: true, body: 'Yes, lockfile plus Node version.', createdAt: '2026-11-14T11:30:00Z' })];

/** A store on an item's screen with the item and its comments loaded. */
async function itemStore(entry: CgGalleryItem, routes: Parameters<typeof galleryStore>[0] = {}, open = true) {
  const screen = screenFor(entry.itemId);
  const server = await galleryStore({
    [`GET rooms/${CODE}/gallery`]: galleryReply([entry, ...ITEMS.filter((other) => other.itemId !== entry.itemId)]),
    [`GET rooms/${CODE}/gallery/${entry.itemId}`]: { status: 200, body: { item: entry, comments: COMMENTS } },
    ...routes,
  }, { open, screen });
  await loadGallery(server.store, CODE);
  await server.store.loadScreen(screen);
  return server;
}

const markup = (store: Awaited<ReturnType<typeof itemStore>>['store'], itemId = runner.itemId, chats: Chat[] = []) => (
  renderToStaticMarkup(createElement(GalleryItemScreen, { code: CODE, itemId, state: store.getSnapshot(), store, host: galleryHost(chats) }))
);

test('the item screen shows the sharer, the topic, comments and the comment field', async () => {
  const { store } = await itemStore(runner);
  const html = markup(store);
  assert.match(html, /class="cg-back"[^>]*>.*Build night<\/button>/);
  assert.match(html, /<h1 class="cg-gallery-item-title">Runner cache notes<\/h1>/);
  // The title stands alone, and the sharer is a plain line, not a boxed row.
  assert.doesNotMatch(html, /cg-gallery-item-head|cg-gallery-author|cg-type/);
  assert.match(html, /cg-gallery-byline-name">Bea Okafor</);
  assert.match(html, /cg-gallery-byline-topic">Agent memory</);
  assert.match(html, />Comments</);
  assert.match(html, /cg-gallery-comment-name">Chen Li</);
  assert.match(html, /cg-gallery-comment-name">You</);
  assert.match(html, /aria-label="Add a comment"/);
  assert.match(html, /Loading/);
  // My comment can be deleted on Bea's item; Chen's cannot.
  assert.equal(html.match(/aria-label="More"/g)?.length, 1);
});

test('a closed room keeps the item and comments readable without the comment field', async () => {
  const { store } = await itemStore(runner, {}, false);
  const html = markup(store);
  assert.match(html, /Same misses on the arm runners here/);
  assert.doesNotMatch(html, /Add a comment/);
});

test('the contact control follows the relationship: Message, Add, Requested, Accept, and More on my own item', async () => {
  const cases: Array<[CgGalleryItem, RegExp]> = [
    [item('gi_x', { person: bea() }), />Message</],
    [item('gi_x', { person: dan(rel()) }), />Add</],
    [item('gi_x', { person: dan(rel({ request: 'outgoing', requestId: 'req_1' })) }), /disabled="">Requested</],
    [item('gi_x', { person: dan(rel({ request: 'incoming', requestId: 'req_2' })) }), />Accept</],
  ];
  for (const [entry, expected] of cases) {
    const { store } = await itemStore(entry);
    assert.match(markup(store, 'gi_x'), expected);
  }
  const { store } = await itemStore(item('gi_mine', { person: self, mine: true }));
  const mine = markup(store, 'gi_mine');
  assert.doesNotMatch(mine, />Message<|>Add</);
  assert.match(mine, /cg-gallery-byline-name">You</);
  // More on the header, and on every comment of my item.
  assert.equal(mine.match(/aria-label="More"/g)?.length, 3);
});

test('Message opens the chat with an About line, Add turns into Requested, Accept accepts', async () => {
  const chats: Chat[] = [];
  const accepted: string[] = [];
  const contact = await itemStore(runner, { 'POST people/acct_bea/chat': { status: 200, body: { conversationId: 'dm_bea', sessionId: 's1', relationship: rel({ contact: true }) } } });
  await mount(createElement(ItemPage, { store: contact.store, host: galleryHost(chats, accepted), itemId: runner.itemId }), async (root) => {
    await click(buttonNamed(root, 'Message'));
    assert.equal(chats.length, 1);
    assert.equal(chats[0].person.accountId, 'acct_bea');
    assert.equal(chats[0].draft, 'About "Runner cache notes": ');
  });

  const stranger = item('gi_s', { person: dan(rel()) });
  const adding = await itemStore(stranger, { 'POST people/acct_dan/contact': { status: 200, body: { relationship: rel({ request: 'outgoing', requestId: 'req_9' }) } } });
  await mount(createElement(ItemPage, { store: adding.store, host: galleryHost(chats, accepted), itemId: 'gi_s' }), async (root) => {
    await click(buttonNamed(root, 'Add'));
    assert.equal(buttonNamed(root, 'Requested')?.disabled, true);
  });

  const incoming = item('gi_i', { person: dan(rel({ request: 'incoming', requestId: 'req_2' })) });
  const accepting = await itemStore(incoming);
  await mount(createElement(ItemPage, { store: accepting.store, host: galleryHost(chats, accepted), itemId: 'gi_i' }), async (root) => {
    await click(buttonNamed(root, 'Accept'));
    assert.deepEqual(accepted, ['req_2']);
    assert.ok(buttonNamed(root, 'Message'));
  });
});

test('a comment shows at once, takes the server copy, and is taken back when refused', async () => {
  const saved = comment('c3', { person: self, mine: true, body: 'Thanks!', createdAt: '2026-11-14T12:00:00Z' });
  const { store, calls } = await itemStore(runner, { [`POST rooms/${CODE}/gallery/gi_runner/comments`]: [{ status: 201, body: { comment: saved } }, { status: 409, body: { errorCode: 'common_ground_room_closed', message: 'This room has closed.' } }] });
  const view = () => store.getSnapshot().gallery.items[galleryItemKey(CODE, 'gi_runner')];
  const count = () => store.getSnapshot().gallery.lists[CODE].items.find((entry) => entry.itemId === 'gi_runner')?.commentCount;
  const sending = addGalleryComment(store, CODE, 'gi_runner', '  Thanks!  ', self);
  assert.deepEqual(view().comments.map((entry) => entry.body), [COMMENTS[0].body, COMMENTS[1].body, 'Thanks!']);
  assert.match(view().comments[2].commentId, /^pending:/);
  assert.equal(count(), 4);
  assert.equal(await sending, true);
  assert.deepEqual(calls.at(-1)?.body, { body: 'Thanks!' });
  assert.equal(view().comments[2].commentId, 'c3');
  assert.equal(view().item.commentCount, 4);

  assert.equal(await addGalleryComment(store, CODE, 'gi_runner', 'Again', self), false);
  assert.equal(view().comments.length, 3);
  assert.equal(count(), 4);
  assert.equal(store.getSnapshot().notice, 'This room has closed.');
  assert.equal(await addGalleryComment(store, CODE, 'gi_runner', 'x'.repeat(2001), self), false);
});

test('deleting a comment removes it at once and puts it back when the server refuses', async () => {
  const { store, calls } = await itemStore(runner, { [`DELETE rooms/${CODE}/gallery/gi_runner/comments/c2`]: [{ status: 204 }, { status: 403, body: { errorCode: 'forbidden', message: 'Not allowed.' } }] });
  const ids = () => store.getSnapshot().gallery.items[galleryItemKey(CODE, 'gi_runner')].comments.map((entry) => entry.commentId);
  const deleting = deleteGalleryComment(store, CODE, 'gi_runner', 'c2');
  assert.deepEqual(ids(), ['c1']);
  assert.equal(await deleting, true);
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/comments/c2')));

  const again = await itemStore(runner, { [`DELETE rooms/${CODE}/gallery/gi_runner/comments/c2`]: { status: 403, body: { errorCode: 'forbidden', message: 'Not allowed.' } } });
  assert.equal(await deleteGalleryComment(again.store, CODE, 'gi_runner', 'c2'), false);
  assert.deepEqual(again.store.getSnapshot().gallery.items[galleryItemKey(CODE, 'gi_runner')].comments.map((entry) => entry.commentId), ['c1', 'c2']);
  assert.equal(again.store.getSnapshot().notice, 'Not allowed.');
});

test('Enter sends a comment, Shift+Enter does not, and the file renders from the content route', async () => {
  const saved = comment('c3', { person: self, mine: true, body: 'Looks good', createdAt: '2026-11-14T12:00:00Z' });
  const { store, calls } = await itemStore(runner, {
    [`POST rooms/${CODE}/gallery/gi_runner/comments`]: { status: 201, body: { comment: saved } },
    [`GET rooms/${CODE}/gallery/gi_runner/content`]: { status: 200, text: '# Runner cache notes\n\nWarm caches **halve** install time.', headers: { 'content-type': 'text/markdown' } },
  });
  await mount(createElement(ItemPage, { store, host: galleryHost(), itemId: runner.itemId }), async (root) => {
    assert.match(root.querySelector('.cg-gallery-markdown')?.textContent ?? '', /Warm caches halve install time/);
    const field = root.querySelector('textarea')!;
    const type = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value);
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const press = async (shiftKey: boolean) => act(async () => {
      field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true }));
    });
    const posts = () => calls.filter((call) => call.method === 'POST' && call.url.endsWith('/comments')).length;
    await type('Looks good');
    await press(true);
    assert.equal(posts(), 0);
    await press(false);
    await settle();
    assert.equal(posts(), 1);
    assert.equal(field.value, '');
    assert.match(root.textContent ?? '', /Looks good/);
  });
});

test('a file that cannot be read says so, and a removed item goes back to the room', async () => {
  const { store } = await itemStore(runner, { [`DELETE rooms/${CODE}/gallery/gi_minutes`]: { status: 204 } });
  await mount(createElement(ItemPage, { store, host: galleryHost(), itemId: runner.itemId }), async (root) => {
    assert.match(root.textContent ?? '', /Can’t open this file/);
  });
  const mine = await itemStore(ITEMS[1], { [`DELETE rooms/${CODE}/gallery/gi_minutes`]: { status: 204 } });
  assert.equal(mine.store.top().name, 'galleryItem');
  assert.equal(await removeFromGallery(mine.store, CODE, 'gi_minutes'), true);
  assert.equal(mine.store.top().name, 'results');

  const gone = await itemStore(runner, { [`GET rooms/${CODE}/gallery/gi_runner`]: { status: 404, body: { errorCode: 'common_ground_gallery_not_found', message: 'Gone.' } } });
  assert.equal(gone.store.top().name, 'results');
  assert.equal(gone.store.getSnapshot().gallery.lists[CODE].items.some((entry) => entry.itemId === 'gi_runner'), false);
});

test('open in default app writes a copy of the text through the Artifacts open action', async () => {
  const opened: Array<[string, string]> = [];
  await openGalleryItemExternally(runner, '# Notes', async (name, contents) => { opened.push([name, contents]); return name; });
  assert.deepEqual(opened, [['gi_runner.md', '# Notes']]);
});

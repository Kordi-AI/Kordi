import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { act, createElement } from 'react';

import { GalleryCard } from '../src/features/commonGround/GalleryCard';
import type { CommonGroundClient } from '../src/features/commonGround/client';
import { item } from './helpers/commonGroundGallery';
import { settle } from './helpers/nearbyScreen';
import { installDom } from './helpers/transcriptAttachmentDom';

// The thumbnail cache lives for the whole module, so each test uses its own room code and checks
// only its own URLs. Mounting more than 60 cards evicts whatever earlier tests left unused.

type ContentClient = Pick<CommonGroundClient, 'galleryContent'>;
const ids = (prefix: string, count: number, from = 0) => Array.from({ length: count }, (_, index) => `${prefix}${from + index}`);
const noop = () => undefined;

/** A content client that counts reads per item, with object URLs named `blob:<code>:<itemId>`. */
function thumbnailServer(t: TestContext, code: string, failing = new Set<string>()) {
  const reads = new Map<string, number>();
  const revoked: string[] = [];
  const names = new WeakMap<Blob, string>();
  const client: ContentClient = {
    galleryContent: async (room, itemId) => {
      reads.set(itemId, (reads.get(itemId) ?? 0) + 1);
      if (failing.delete(itemId)) throw new Error('Unreadable.');
      const blob = new Blob(['png'], { type: 'image/png' });
      names.set(blob, `blob:${room}:${itemId}`);
      return blob;
    },
  };
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => names.get(blob) ?? 'blob:unknown');
  t.mock.method(URL, 'revokeObjectURL', (url: string) => { revoked.push(url); });
  const url = (itemId: string) => `blob:${code}:${itemId}`;
  return { client, reads: (itemId: string) => reads.get(itemId) ?? 0, revoked: () => revoked.filter((entry) => entry.startsWith(`blob:${code}:`)), url };
}

function Cards({ client, code, cards }: { client: ContentClient; code: string; cards: string[] }) {
  return createElement('div', null, cards.map((itemId) => createElement(GalleryCard, {
    key: itemId, code, client, removing: false, onOpen: noop, onRemove: noop,
    item: item(itemId, { fileName: `${itemId}.png`, contentType: 'image/png', preview: null }),
  })));
}

/** Mounts a list of image cards and hands back a renderer for the next list and the shown URLs. */
async function withCards(client: ContentClient, code: string, run: (show: (cards: string[]) => Promise<void>, shown: () => string[]) => Promise<void>) {
  const installed = installDom();
  const { createRoot } = await import('react-dom/client');
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  const show = async (cards: string[]) => {
    await act(async () => root.render(createElement(Cards, { client, code, cards })));
    await settle();
  };
  try {
    await run(show, () => [...node.querySelectorAll('.cg-gallery-thumb img.app-artifact-card-image')].map((image) => image.getAttribute('src') ?? ''));
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
}

test('more than 60 mounted cards keep every URL, and unmounting trims only unused ones', async (t) => {
  const server = thumbnailServer(t, 'T1');
  const cards = ids('c', 70);
  await withCards(server.client, 'T1', async (show, shown) => {
    await show(cards);
    assert.deepEqual(shown(), cards.map(server.url));
    assert.deepEqual(server.revoked(), []);
    await show(cards.slice(20));
    await settle();
    const revoked = server.revoked();
    assert.equal(revoked.length, 10);
    const unmounted = new Set(cards.slice(0, 20).map(server.url));
    assert.ok(revoked.every((url) => unmounted.has(url)), 'only unmounted cards lose their URL');
    assert.deepEqual(shown(), cards.slice(20).map(server.url));
  });
});

test('unused thumbnails go least recently used first, and a remount after eviction reads again', async (t) => {
  const server = thumbnailServer(t, 'T2');
  const first = ids('a', 60);
  await withCards(server.client, 'T2', async (show, shown) => {
    await show(first);
    await show([]);
    await settle();
    // Sixty unused entries fit.
    assert.deepEqual(server.revoked(), []);
    // A remount reuses the cached URL and marks a0 most recently used.
    await show(['a0']);
    assert.equal(server.reads('a0'), 1);
    assert.deepEqual(shown(), [server.url('a0')]);
    await show([]);
    await show(ids('b', 10));
    await settle();
    assert.deepEqual(server.revoked().sort(), ids('a', 10, 1).map(server.url).sort());
    await show(['a0', 'a1']);
    assert.equal(server.reads('a0'), 1);
    assert.equal(server.reads('a1'), 2);
    assert.deepEqual(shown(), [server.url('a0'), server.url('a1')]);
  });
});

test('a mounted card keeps its URL while other cards mount and unmount', async (t) => {
  const server = thumbnailServer(t, 'T3');
  await withCards(server.client, 'T3', async (show, shown) => {
    await show(['keep']);
    for (let round = 0; round < 3; round += 1) {
      await show(['keep', ...ids(`r${round}x`, 70)]);
      await show(['keep']);
    }
    await settle();
    assert.equal(server.reads('keep'), 1);
    assert.ok(server.revoked().length >= 140);
    assert.equal(server.revoked().includes(server.url('keep')), false);
    assert.deepEqual(shown(), [server.url('keep')]);
  });
});

test('a failed read shows the type tile and a later mount reads again', async (t) => {
  const server = thumbnailServer(t, 'T4', new Set(['bad']));
  await withCards(server.client, 'T4', async (show, shown) => {
    await show(['bad']);
    assert.deepEqual(shown(), []);
    await show([]);
    await show(['bad']);
    assert.equal(server.reads('bad'), 2);
    assert.deepEqual(shown(), [server.url('bad')]);
  });
});

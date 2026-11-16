// Shared fixtures for the Grounding Gallery tests: items, comments, a host that records chats, and a
// store on a room (or an item screen) answered by the mock server.

import { createElement, useSyncExternalStore } from 'react';

import { GalleryItemScreen } from '../../src/features/commonGround/GalleryItemScreen';
import type { CgHost } from '../../src/features/commonGround/host';
import { ResultsScreen } from '../../src/features/commonGround/ResultsScreen';
import { CommonGroundStore, type CgScreen } from '../../src/features/commonGround/store';
import type { CgGalleryComment, CgGalleryItem, CgPerson, CgRelationship, CgResults } from '../../src/features/commonGround/types';
import { mockServer, owner, rel, room, type Reply } from './commonGroundServer';

export const CODE = '4821';
export const ROOM_TOPICS = ['Agent memory', 'Retrieval', 'Eval design'];

export const self = { accountId: 'acct_you', name: 'Sam Taylor', avatarUrl: null };
export const bea = (relationship: CgRelationship = rel({ contact: true, conversationId: 'dm_bea' })): CgPerson => (
  { accountId: 'acct_bea', name: 'Bea Okafor', avatarUrl: null, relationship }
);

export const item = (itemId: string, patch: Partial<CgGalleryItem> = {}): CgGalleryItem => ({
  itemId,
  attachmentId: `att_${itemId}`,
  title: `Item ${itemId}`,
  fileName: `${itemId}.md`,
  contentType: 'text/markdown',
  sizeBytes: 1200,
  topic: null,
  preview: '# Notes\n\nA warm cache cut most jobs by half.',
  person: bea(),
  mine: false,
  commentCount: 0,
  createdAt: '2026-11-14T10:00:00Z',
  ...patch,
});

export const comment = (commentId: string, patch: Partial<CgGalleryComment> = {}): CgGalleryComment => ({
  commentId, person: { accountId: 'acct_chen', name: 'Chen Li', avatarUrl: null }, body: 'Same misses on the arm runners here.', mine: false, createdAt: '2026-11-14T11:00:00Z', ...patch,
});

/** Runner cache notes (Bea, Agent memory, 3 comments), a CSV of mine (Retrieval), and an untitled-topic PDF. */
export const ITEMS = [
  item('gi_runner', { title: 'Runner cache notes', topic: 'Agent memory', commentCount: 3 }),
  item('gi_minutes', { title: 'CI minutes by job', fileName: 'ci-minutes.csv', contentType: 'text/csv', preview: 'Job,Runs\nLint,640', topic: 'Retrieval', person: { ...self, relationship: undefined }, mine: true }),
  item('gi_flow', { title: 'Onboarding flow', fileName: 'flow.pdf', contentType: 'application/pdf', preview: null }),
];

export const results: CgResults = {
  status: 'ready',
  people: [{ person: bea(), score: 82, headline: 'Build caching' }],
  topics: ROOM_TOPICS.map((label) => ({ label, people: [self, bea()] })),
  suggestion: null,
};

export type Chat = { person: CgPerson; draft?: string };

export function galleryHost(chats: Chat[] = [], accepted: string[] = []): CgHost {
  return {
    self, profiles: true, memoryAvailable: false, connectors: null, agentFiles: null, device: null,
    openChat: (person, draft) => { chats.push({ person, draft }); },
    acceptRequest: async (requestId) => { accepted.push(requestId); },
    contactsChanged: () => undefined, openGroup: () => undefined, openUrl: () => undefined,
  };
}

/** A store on the room's page (or `screen` over it), with the room's results loaded. */
export async function galleryStore(routes: Record<string, Reply | Reply[]>, { open = true, screen }: { open?: boolean; screen?: CgScreen } = {}) {
  const server = mockServer({ [`POST rooms/${CODE}/results`]: { status: 200, body: results }, ...routes });
  const store = new CommonGroundStore(server.client, { profiles: true });
  const roomScreen: CgScreen = { name: 'results', code: CODE };
  store.set({ loaded: true, owner: owner(), rooms: { [CODE]: room(CODE, { name: 'Build night', open }) }, stack: [{ name: 'home' }, roomScreen, ...(screen ? [screen] : [])] });
  await store.loadScreen(roomScreen);
  return { ...server, store };
}

export const galleryReply = (items: CgGalleryItem[] = ITEMS, canShare = true): Reply => ({ status: 200, body: { items, canShare } });

export function Room({ store, host }: { store: CommonGroundStore; host: CgHost }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return createElement(ResultsScreen, { code: CODE, state, store, host });
}

export function ItemPage({ store, host, itemId }: { store: CommonGroundStore; host: CgHost; itemId: string }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return createElement(GalleryItemScreen, { code: CODE, itemId, state, store, host });
}

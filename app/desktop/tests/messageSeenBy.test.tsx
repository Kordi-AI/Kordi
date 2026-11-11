import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageSeenByProvider } from '../src/features/chat/MessageSeenByProvider';
import {
  decodeMessageReadersPage,
  messageSeenByTarget,
  requestMessageReaders,
  seenByPeopleLookup,
  seenRowState,
  type MessageReadersPage,
  type MessageSeenBySource,
  type MessageSeenByTarget,
} from '../src/features/chat/messageSeenBy';
import { fetchMessageReaders } from '../src/features/cloud/messageReadersClient';
import { MessageContextMenuContent } from '../src/kordi-app/components/messageContextMenuContent';
import { MessageSeenByRow } from '../src/kordi-app/components/messageSeenByRow';
import type { ConversationParticipant, Message } from '../src/kordi-app/types';
import { formatDesktopTranscriptTimeLabel } from '../src/lib/time';

// Synthetic people and a synthetic group only.
const PEOPLE = ['Maya Patel', 'Omar Haddad', 'Hana Sato', 'Alex Kim', 'Priya Nair', 'Lena Fischer', 'Diego Alvarez', 'Sofia Rossi'];
const accountId = (name: string) => `acct_${name.split(' ')[0]!.toLowerCase()}`;
const participants: ConversationParticipant[] = [
  { id: 'human:acct_me', name: 'Me', kind: 'human', role: 'self' },
  ...PEOPLE.map((name) => ({ id: `human:${accountId(name)}`, name, kind: 'human', role: 'person', avatarKey: `seed-${accountId(name)}` })),
  { id: 'agent:helper', name: 'Helper', kind: 'agent', role: 'owned-agent' },
];
const readAt = (minute: number) => `2026-11-10T10:${String(minute).padStart(2, '0')}:00Z`;
const allReaders: MessageReadersPage = {
  total: 8,
  readers: PEOPLE.map((name, index) => ({ accountId: accountId(name), readAt: index === 7 ? null : readAt(41 + index) })),
};
const ownMessage: Message = {
  id: 'msg:own', role: 'user', sender: 'Me', senderType: 'human', isOwnMessage: true,
  text: 'I moved the demo to Thursday at 3.', time: '10:40', statusChips: ['read'],
  reactionConversationId: 'conversation:launch', reactionTargetMessageId: 'server-message-1', cloudMessageVersion: 1,
};

function source(overrides: Partial<MessageSeenBySource> = {}): MessageSeenBySource {
  return {
    activeMemberCount: 9,
    person: seenByPeopleLookup(participants),
    fetchReaders: () => new Promise(() => undefined),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  });
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root: Root = createRoot(host);
  return {
    host,
    render: (node: ReactNode) => act(async () => { root.render(node); }),
    async restore() {
      await act(async () => { root.unmount(); });
      previous.forEach((descriptor, key) => {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
      });
      dom.window.close();
    },
  };
}

function groupMenu(msg: Message, fetchReaders: MessageSeenBySource['fetchReaders'], people = participants) {
  return createElement(MessageSeenByProvider, {
    isGroup: true,
    participants: people,
    fetchReaders,
    children: createElement(MessageContextMenuContent, { msg, onReplyMessage: () => undefined }),
  });
}

const seenRow = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-message-context-menu-seen-row]');

test('readers decode in server order with missing or invalid times left empty', () => {
  const page = decodeMessageReadersPage({
    total: 5,
    readers: [
      { accountId: 'acct_maya', readAt: null },
      { accountId: 'acct_omar', readAt: '2026-11-10T10:41:00Z' },
      { account_id: 'acct_hana', read_at: 'not a time' },
      { accountId: 'acct_omar', readAt: '2026-11-10T10:59:00Z' },
      { readAt: '2026-11-10T10:41:00Z' },
    ],
  });

  assert.deepEqual(page, {
    total: 5,
    readers: [
      { accountId: 'acct_maya', readAt: null },
      { accountId: 'acct_omar', readAt: '2026-11-10T10:41:00Z' },
      { accountId: 'acct_hana', readAt: null },
    ],
  });
  assert.equal(decodeMessageReadersPage({ readers: [{ accountId: 'acct_maya' }] }).total, 1);
  assert.throws(() => decodeMessageReadersPage({ total: 1 }));
});

test('the Seen row appears only on own sent group messages in groups up to 100 members', () => {
  const group = source();
  assert.deepEqual(messageSeenByTarget(ownMessage, group), { conversationId: 'conversation:launch', messageId: 'server-message-1' });
  assert.equal(messageSeenByTarget(ownMessage, null), null, 'outside groups');
  assert.ok(messageSeenByTarget(ownMessage, source({ activeMemberCount: 100 })));
  assert.equal(messageSeenByTarget(ownMessage, source({ activeMemberCount: 101 })), null, 'more than 100 members');
  assert.equal(messageSeenByTarget({ ...ownMessage, role: 'person', isOwnMessage: false }, group), null, 'incoming');
  assert.equal(messageSeenByTarget({ ...ownMessage, statusChips: ['sending'] }, group), null);
  assert.equal(messageSeenByTarget({ ...ownMessage, statusChips: ['failed'] }, group), null);
  assert.equal(messageSeenByTarget({ ...ownMessage, reactionConversationId: 'session:group:launch' }, group), null);
  assert.equal(messageSeenByTarget({ ...ownMessage, reactionTargetMessageId: null }, group), null);
  assert.ok(messageSeenByTarget({ ...ownMessage, statusChips: ['sent'] }, group), 'one tick still offers Not seen yet');
});

test('row states follow the readers request', () => {
  assert.deepEqual(seenRowState(null), { kind: 'hidden' });
  assert.deepEqual(seenRowState({ status: 'failed' }), { kind: 'hidden' });
  assert.deepEqual(seenRowState({ status: 'loading' }), { kind: 'loading' });
  assert.deepEqual(seenRowState({ status: 'ready', page: { total: 0, readers: [] } }), { kind: 'none' });
  assert.deepEqual(
    seenRowState({ status: 'ready', page: { total: 1, readers: [allReaders.readers[0]!] } }),
    { kind: 'one', reader: allReaders.readers[0] },
  );
  const several = seenRowState({ status: 'ready', page: allReaders });
  assert.equal(several.kind, 'several');
  assert.equal(several.kind === 'several' ? several.readers.length : 0, 4);
});

test('the Seen row renders loading, Not seen yet, one name, and N Seen', () => {
  const render = (request: Parameters<typeof MessageSeenByRow>[0]['request']) => renderToStaticMarkup(
    createElement(MessageSeenByRow, { source: source(), request, onOpen: () => undefined }),
  );
  const loading = render({ status: 'loading' });
  assert.match(loading, /role="status"/);
  assert.match(loading, /aria-label="Loading who has seen this"/);
  assert.equal(loading.match(/app-message-seen-skeleton-face/g)?.length, 2);

  const none = render({ status: 'ready', page: { total: 0, readers: [] } });
  assert.match(none, />Not seen yet</);
  assert.doesNotMatch(none, /<button/, 'Not seen yet cannot be chosen');

  const one = render({ status: 'ready', page: { total: 1, readers: [allReaders.readers[0]!] } });
  assert.match(one, /<button[^>]*title="Seen by Maya Patel"/);
  assert.match(one, />Maya Patel</);
  assert.equal(one.match(/data-identity-avatar/g)?.length, 1);

  const several = render({ status: 'ready', page: allReaders });
  assert.match(several, />8 Seen</);
  assert.match(several, /title="Seen by Maya Patel, Omar Haddad, Hana Sato, Alex Kim"/);
  assert.equal(several.match(/data-identity-avatar/g)?.length, 4);
  for (const markup of [loading, none, one, several]) {
    assert.doesNotMatch(markup, /SEEN|NOT SEEN/, 'no capitalised copy');
  }
  assert.equal(render({ status: 'failed' }), '', 'a failed fetch hides the row');
});

test('a readers response that arrives after cancelling is ignored', async () => {
  const pending = deferred<MessageReadersPage>();
  const settled: unknown[] = [];
  const cancel = requestMessageReaders({ fetchReaders: () => pending.promise }, { conversationId: 'c', messageId: 'm' }, 4, (value) => settled.push(value));
  cancel();
  pending.resolve(allReaders);
  await pending.promise;
  await Promise.resolve();
  assert.deepEqual(settled, []);
});

test('readers client asks the server for the bounded list', async () => {
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const page = await fetchMessageReaders({ conversationId: 'conversation:launch', messageId: 'server-message-1' }, 500, {
    loadSession: async () => ({ token: 'test-token' }),
    client: { request: async <T,>(path: string, init: RequestInit) => { requests.push({ path, init }); return allReaders as T; } },
  });

  assert.equal(page.total, 8);
  assert.equal(requests[0]?.path, '/v2/chat/conversations/conversation%3Alaunch/messages/server-message-1/readers?limit=100');
  assert.equal(requests[0]?.init.method, 'GET');
});

test('menu loads four readers on open, then the full list in order with read times', async () => {
  const dom = installDom();
  const calls: Array<{ target: MessageSeenByTarget; limit: number; response: ReturnType<typeof deferred<MessageReadersPage>> }> = [];
  const fetchReaders = (target: MessageSeenByTarget, limit: number) => {
    const response = deferred<MessageReadersPage>();
    calls.push({ target, limit, response });
    return response.promise;
  };
  try {
    await dom.render(groupMenu(ownMessage, fetchReaders));
    assert.equal(seenRow(dom.host)?.dataset.messageContextMenuSeenRow, 'loading');
    assert.deepEqual(calls.map((call) => call.limit), [4]);

    await act(async () => { calls[0]!.response.resolve({ total: 8, readers: allReaders.readers.slice(0, 4) }); });
    const row = seenRow(dom.host)!;
    assert.equal(row.tagName, 'BUTTON');
    assert.match(row.textContent ?? '', /8 Seen/);

    await act(async () => { row.click(); });
    assert.deepEqual(calls.map((call) => call.limit), [4, 100], 'the full list fetches when opened');
    assert.equal(dom.host.querySelector('[data-message-context-menu-action="quote"]'), null);
    assert.equal(dom.host.querySelectorAll('[data-message-seen-reader]').length, 4, 'the four known readers show while loading');
    assert.equal(dom.host.ownerDocument.activeElement?.getAttribute('aria-label'), 'Back to message actions');

    await act(async () => { calls[1]!.response.resolve(allReaders); });
    const rows = [...dom.host.querySelectorAll<HTMLElement>('[data-message-seen-reader]')];
    assert.deepEqual(rows.map((value) => value.dataset.messageSeenReader), allReaders.readers.map((reader) => reader.accountId));
    assert.equal(rows[0]?.querySelector('.app-dense-menu-meta')?.textContent, formatDesktopTranscriptTimeLabel(Date.parse(readAt(41))));
    assert.equal(rows[7]?.querySelector('.app-dense-menu-meta'), null, 'a reader without a read time shows no time');
    assert.match(rows[7]?.textContent ?? '', /Sofia Rossi/);

    await act(async () => { dom.host.querySelector<HTMLButtonElement>('[aria-label="Back to message actions"]')!.click(); });
    assert.ok(dom.host.querySelector('[data-message-context-menu-action="quote"]'));
    assert.equal(dom.host.ownerDocument.activeElement, seenRow(dom.host), 'focus returns to the Seen row');
    assert.equal(calls.length, 2, 'returning does not refetch');
  } finally {
    await dom.restore();
  }
});

test('one reader shows the name and opens a one-row list', async () => {
  const dom = installDom();
  const page: MessageReadersPage = { total: 1, readers: [{ accountId: 'acct_maya', readAt: readAt(41) }] };
  try {
    await dom.render(groupMenu(ownMessage, async () => page));
    assert.match(seenRow(dom.host)?.textContent ?? '', /Maya Patel/);
    await act(async () => { seenRow(dom.host)!.click(); });
    assert.equal(dom.host.querySelectorAll('[data-message-seen-reader]').length, 1);
  } finally {
    await dom.restore();
  }
});

test('the row is absent when the fetch fails, outside groups, on incoming messages, and in large groups', async () => {
  const dom = installDom();
  let calls = 0;
  const failing = () => { calls += 1; return Promise.reject(new Error('readers_unavailable')); };
  try {
    await dom.render(groupMenu(ownMessage, failing));
    assert.equal(seenRow(dom.host), null);
    assert.ok(dom.host.querySelector('[data-message-context-menu-action="quote"]'));

    calls = 0;
    await dom.render(createElement(MessageSeenByProvider, {
      isGroup: false, participants, fetchReaders: failing,
      children: createElement(MessageContextMenuContent, { msg: ownMessage }),
    }));
    assert.equal(seenRow(dom.host), null);
    await dom.render(groupMenu({ ...ownMessage, id: 'msg:incoming', role: 'person', isOwnMessage: false, sender: 'Maya Patel' }, failing));
    assert.equal(seenRow(dom.host), null);
    const largeGroup = Array.from({ length: 101 }, (_, index): ConversationParticipant => ({
      id: `human:acct_${index}`, name: `Person ${index}`, kind: 'human', role: 'person',
    }));
    await dom.render(groupMenu({ ...ownMessage, id: 'msg:large' }, failing, largeGroup));
    assert.equal(seenRow(dom.host), null);
    assert.equal(calls, 0, 'no request when the row cannot appear');
  } finally {
    await dom.restore();
  }
});

test('a response for a previous message is ignored after the menu moves on', async () => {
  const dom = installDom();
  const responses = new Map<string, ReturnType<typeof deferred<MessageReadersPage>>>();
  const fetchReaders = (target: MessageSeenByTarget) => {
    const response = deferred<MessageReadersPage>();
    responses.set(target.messageId, response);
    return response.promise;
  };
  try {
    await dom.render(groupMenu(ownMessage, fetchReaders));
    await dom.render(groupMenu({ ...ownMessage, id: 'msg:next', reactionTargetMessageId: 'server-message-2' }, fetchReaders));
    await act(async () => { responses.get('server-message-1')!.resolve(allReaders); });
    assert.equal(seenRow(dom.host)?.dataset.messageContextMenuSeenRow, 'loading');
    await act(async () => { responses.get('server-message-2')!.resolve({ total: 0, readers: [] }); });
    assert.match(seenRow(dom.host)?.textContent ?? '', /Not seen yet/);
  } finally {
    await dom.restore();
  }
});

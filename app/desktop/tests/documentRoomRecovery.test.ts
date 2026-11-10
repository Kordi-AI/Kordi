import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as Y from 'yjs';

import { presenceColor } from '../src/features/documents/documentPresence';
import { closingRoomCount, DocumentRoom, type CollabUser } from '../src/features/documents/editor/documentRoom';
import { createMemoryDocumentApi, sampleDocument } from './helpers/documentReaderFixtures';
import { createMemoryCollabRoom } from './helpers/memoryCollabRoom';

const ATTACHMENT = 'att_example_doc';
const SOCKET_PATH = `/v1/cloud/documents/${ATTACHMENT}/collab`;
const PRIYA: CollabUser = { name: 'Priya', color: presenceColor('acct_example_viewer'), accountId: 'acct_example_viewer' };
const ALEX: CollabUser = { name: 'Alex Morgan', color: presenceColor('acct_example_alex'), accountId: 'acct_example_alex' };

type Memory = ReturnType<typeof createMemoryCollabRoom>;
type Api = ReturnType<typeof createMemoryDocumentApi>;

/** Tickets that are refused while `offline`. */
function tickets() {
  const state = { offline: false, issued: 0 };
  const issue = async () => {
    if (state.offline) throw new Error('Collaboration is not available.');
    state.issued += 1;
    return { ticket: `ticket_example_${state.issued}`, url: SOCKET_PATH };
  };
  return { state, issue };
}

/** Runs fake time forward in small steps, letting promises settle between them. */
async function advance(context: TestContext, ms: number, step = 50) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    context.mock.timers.tick(step);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function roomFor(api: Api['api'], memory: Memory, user: CollabUser, clientId: number) {
  const room = new DocumentRoom({ api, attachmentId: ATTACHMENT, user, createProvider: memory.createProvider, markdown: () => `# Snapshot by ${user.name}` });
  room.ydoc.clientID = clientId;
  return room;
}

function typeInto(doc: Y.Doc, text: string) {
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('document').push([paragraph]);
}

/** Closes the room's socket the way the server would. */
function dropConnection(room: DocumentRoom) {
  (room.provider as unknown as { close(code?: number): void }).close(1006);
}

const count = (calls: Api['calls'], method: string) => calls.filter((call) => call.method === method).length;
const roomText = (doc: Y.Doc) => doc.getXmlFragment('document').toString();

test('a failed snapshot is tried again after 2, 5, 10 and then every 10 s, without further typing', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { api, calls } = createMemoryDocumentApi(sampleDocument('owner'), 0, { collabTicket: tickets().issue });
  const save = api.saveDocumentContent;
  let failures = 4;
  let attempts = 0;
  api.saveDocumentContent = async (attachmentId, input) => {
    attempts += 1;
    if (failures > 0) {
      failures -= 1;
      throw new Error('Could not save the document.');
    }
    return save(attachmentId, input);
  };
  const room = roomFor(api, createMemoryCollabRoom(), PRIYA, 3);
  room.start();
  try {
    await advance(context, 100);
    assert.equal(room.status, 'connected');
    typeInto(room.ydoc, 'One edit');
    // Debounce 2 s, then failures at 2 s, 4 s, 9 s and 19 s; the attempt at 29 s lands.
    const expected: Array<[number, number]> = [[2_100, 1], [4_100, 2], [9_100, 3], [19_100, 4], [29_100, 5]];
    let elapsed = 0;
    for (const [at, total] of expected) {
      await advance(context, at - elapsed);
      elapsed = at;
      assert.equal(attempts, total, `${total} attempts by ${at} ms`);
    }
    assert.equal(count(calls, 'saveDocumentContent'), 1, 'the last attempt reached the server');
    await advance(context, 20_000);
    assert.equal(attempts, 5, 'nothing more once it landed');
  } finally {
    room.destroy();
  }
});

test('changes that arrive while reconnecting are snapshotted once the connection syncs', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const access = tickets();
  const { api, calls } = createMemoryDocumentApi(sampleDocument('owner'), 0, { collabTicket: access.issue });
  const memory = createMemoryCollabRoom();
  const room = roomFor(api, memory, PRIYA, 3);
  room.start();
  try {
    await advance(context, 100);
    access.state.offline = true;
    dropConnection(room);
    // Someone else edits while this writer is away.
    typeInto(memory.server, 'Typed by someone else');
    await advance(context, 3_000);
    assert.equal(room.status, 'offline');
    assert.equal(count(calls, 'saveDocumentContent'), 0);
    access.state.offline = false;
    await advance(context, 15_000);
    assert.equal(room.status, 'connected');
    assert.match(roomText(room.ydoc), /Typed by someone else/);
    assert.equal(count(calls, 'saveDocumentContent'), 1, 'the writer snapshots what the reconnect brought');
  } finally {
    room.destroy();
  }
});

test('closing an offline bound room keeps it reconnecting until its edits reach the room, then it leaves', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const access = tickets();
  const { api, calls } = createMemoryDocumentApi(sampleDocument('owner'), 0, { collabTicket: access.issue });
  const memory = createMemoryCollabRoom();
  const leaving = roomFor(api, memory, PRIYA, 3);
  const staying = roomFor(api, memory, ALEX, 9);
  leaving.start();
  staying.start();
  try {
    await advance(context, 100);
    leaving.markBound(false);
    access.state.offline = true;
    dropConnection(leaving);
    typeInto(leaving.ydoc, 'Written while offline');
    leaving.destroy();
    assert.equal(closingRoomCount(), 1, 'it stays in the background');
    await advance(context, 5_000);
    assert.doesNotMatch(roomText(staying.ydoc), /Written while offline/);
    assert.equal(closingRoomCount(), 1);
    access.state.offline = false;
    await advance(context, 12_000);
    assert.match(roomText(staying.ydoc), /Written while offline/, 'the edits reached the room');
    assert.equal(closingRoomCount(), 0, 'and then it left');
    assert.equal(leaving.isDestroyed, true);
    assert.ok(count(calls, 'saveDocumentContent') >= 1, 'a snapshot was written');
    const requested = count(calls, 'requestCollabTicket');
    await advance(context, 20_000);
    assert.equal(count(calls, 'requestCollabTicket'), requested, 'no more reconnects');
  } finally {
    leaving.destroy();
    staying.destroy();
  }
});

test('closing an offline bound room without local edits leaves at once', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const access = tickets();
  const { api, calls } = createMemoryDocumentApi(sampleDocument('owner'), 0, { collabTicket: access.issue });
  const room = roomFor(api, createMemoryCollabRoom(), PRIYA, 3);
  room.start();
  await advance(context, 100);
  room.markBound(false);
  access.state.offline = true;
  dropConnection(room);
  room.destroy();
  assert.equal(closingRoomCount(), 0);
  assert.equal(room.isDestroyed, true);
  const requested = count(calls, 'requestCollabTicket');
  await advance(context, 20_000);
  assert.equal(count(calls, 'requestCollabTicket'), requested, 'no reconnects');
});

test('a closed offline room gives up after 30 s', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const access = tickets();
  const { api, calls } = createMemoryDocumentApi(sampleDocument('owner'), 0, { collabTicket: access.issue });
  const memory = createMemoryCollabRoom();
  const room = roomFor(api, memory, PRIYA, 3);
  room.start();
  await advance(context, 100);
  room.markBound(false);
  access.state.offline = true;
  dropConnection(room);
  typeInto(room.ydoc, 'Never delivered');
  room.destroy();
  await advance(context, 29_000);
  assert.equal(closingRoomCount(), 1, 'still trying');
  await advance(context, 2_000);
  assert.equal(closingRoomCount(), 0, 'gave up');
  assert.equal(room.isDestroyed, true);
  const requested = count(calls, 'requestCollabTicket');
  access.state.offline = false;
  await advance(context, 20_000);
  assert.equal(count(calls, 'requestCollabTicket'), requested, 'no reconnects after giving up');
  assert.doesNotMatch(memory.server.getXmlFragment('document').toString(), /Never delivered/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';

import type { Editor } from '@tiptap/core';

import { DocumentReader } from '../src/features/documents/DocumentReader';
import { DocumentReaderHostContext, type DocumentReaderHost } from '../src/features/documents/documentReaderHost';
import { presenceColor } from '../src/features/documents/documentPresence';
import type { DocumentResponse } from '../src/features/documents/documentShareTypes';
import { useCloudDocumentEdits } from '../src/features/documents/useCloudDocumentEdits';
import DocumentEditor from '../src/features/documents/editor/DocumentEditor';
import { selectionAnchor } from '../src/features/documents/editor/documentEditorSync';
import { DocumentRoom, type CollabUser } from '../src/features/documents/editor/documentRoom';
import { createMemoryDocumentApi, sampleDocument } from './helpers/documentReaderFixtures';
import { createMemoryCollabRoom } from './helpers/memoryCollabRoom';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

const ATTACHMENT = 'att_example_doc';
const SOCKET_PATH = `/v1/cloud/documents/${ATTACHMENT}/collab`;
const FAST = { reconnectDelaysMs: [10, 20], snapshotDelayMs: 20, snapshotRetryMs: [20], closeDrainMs: 10 };
const PRIYA: CollabUser = { name: 'Priya', color: presenceColor('acct_example_viewer'), accountId: 'acct_example_viewer' };
const ALEX: CollabUser = { name: 'Alex Morgan', color: presenceColor('acct_example_alex'), accountId: 'acct_example_alex' };

const TITLE = { id: 'k:title000', source: '# Notes' };
const INTRO = { id: 'k:intro000', source: 'Intro paragraph.' };
const OTHER = { id: 'k:other000', source: 'Other paragraph.' };

type Api = ReturnType<typeof createMemoryDocumentApi>;
type Memory = ReturnType<typeof createMemoryCollabRoom>;
type Block = { id: string; source: string };

function notesDocument(blocks: Block[] = [TITLE, INTRO, OTHER]): DocumentResponse {
  return { ...sampleDocument('owner'), revision: 3, reactions: [], comments: [], blocks: blocks.map((block) => ({ ...block, html: '' })) };
}

/** Stored Markdown with id comments, as an agent's save outside the room sends it. */
const markdownOf = (blocks: Block[]) => blocks.map((block) => `${block.source}\n<!-- ${block.id} -->`).join('\n\n');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (ms: number) => act(async () => { await sleep(ms); });

function stubLayout() {
  const view = globalThis.window as unknown as Window & typeof globalThis;
  const empty = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
  Object.assign(view.Range.prototype, { getClientRects: () => [], getBoundingClientRect: empty });
  Object.assign(view.HTMLElement.prototype, { getClientRects: () => [] });
}

/** Tickets held back until `open()`, refused while `offline`; `stale` marks the next one. */
function tickets() {
  const state = { offline: false, stale: false, issued: 0 };
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const issue = async () => {
    await gate;
    if (state.offline) throw new Error('Collaboration is not available.');
    state.issued += 1;
    const staleRevision = state.stale;
    state.stale = false;
    return { ticket: `ticket_example_${state.issued}`, url: SOCKET_PATH, ...(staleRevision ? { staleRevision } : {}) };
  };
  return { state, issue, open: () => open() };
}

/** Writes blocks into the server's room, as another editor's seed or edits would. */
async function writeServerRoom(memory: Memory, blocks: Block[]) {
  const { Editor: HeadlessEditor } = await import('@tiptap/core');
  const { documentEditorExtensions } = await import('../src/features/documents/editor/documentEditorExtensions');
  const { parseBlocks } = await import('../src/features/documents/editor/documentBlockIds');
  const { prosemirrorJSONToYXmlFragment } = await import('@tiptap/y-tiptap');
  const editor = new HeadlessEditor({ extensions: documentEditorExtensions() });
  try {
    prosemirrorJSONToYXmlFragment(editor.schema, parseBlocks(editor.markdown!, blocks).doc, memory.fragment());
  } finally {
    editor.destroy();
  }
}

const isBound = (editor: Editor | null | undefined) => Boolean(editor && !editor.isDestroyed && editor.extensionManager.extensions.some((extension) => extension.name === 'collaboration'));
const roomText = (memory: Memory) => memory.fragment().toString();
const saves = (calls: Api['calls']) => calls.filter((call) => call.method === 'saveDocumentContent').map((call) => call.args[1] as { mode?: string; source: string; baseRevision?: number });
const revisionedSaves = (calls: Api['calls']) => saves(calls).filter((save) => save.mode !== 'snapshot');

function blockEnd(editor: Editor, id: string) {
  let end = -1;
  editor.state.doc.forEach((node, offset) => { if (node.attrs.id === id) end = offset + node.nodeSize - 1; });
  assert.ok(end > 0, `block ${id}`);
  return end;
}

function typeInBlock(editor: Editor, id: string, text: string) {
  editor.chain().setTextSelection(blockEnd(editor, id)).insertContent(text).run();
}

const hostFor = (user: CollabUser): DocumentReaderHost => ({
  viewer: { accountId: user.accountId, displayName: user.name, kordiId: '987654321', avatarUrl: null },
  sessionId: 'session_example',
  agentName: 'Lab agent',
  people: [],
});

/** A reader as the viewer `user`; the editors it shows land in `seen`, the bound one last. */
function readerElement(api: Api['api'], memory: Memory, user: CollabUser, document: DocumentResponse, seen: Editor[]) {
  return createElement(DocumentReaderHostContext.Provider, { key: user.accountId, value: hostFor(user) }, createElement(DocumentReader, {
    attachmentId: ATTACHMENT,
    initialDocument: document,
    api,
    onEditor: (editor: Editor | null) => { if (editor) seen.push(editor); },
    collabTransport: { createProvider: memory.createProvider, timing: FAST },
  }));
}

const latestEditor = (seen: Editor[]) => seen[seen.length - 1] ?? null;

test('A: typing while the bound room is offline sends no save; the text reaches the other editor on reconnect', async () => {
  await withJsdomRoot(async (mount) => {
    stubLayout();
    const document = notesDocument();
    const access = tickets();
    access.open();
    const { api, calls } = createMemoryDocumentApi(document, 0, { collabTicket: access.issue, collabInit: async () => ({ initialize: true }), outsideRoom: true });
    const memory = createMemoryCollabRoom();
    const seen: Editor[] = [];
    await mount(readerElement(api, memory, PRIYA, document, seen));
    await waitForReactCondition(() => isBound(latestEditor(seen)) && /Intro paragraph/.test(latestEditor(seen)!.state.doc.textContent), 'the editor binds to the room');
    const other = new DocumentRoom({ api, attachmentId: ATTACHMENT, user: ALEX, createProvider: memory.createProvider, markdown: () => null, timing: FAST });
    other.start();
    try {
      await waitForReactCondition(() => other.status === 'connected', 'the other editor joins');
      await settle(100);
      assert.deepEqual(saves(calls), [], 'binding an unchanged document saves nothing');
      const before = saves(calls).length;
      access.state.offline = true;
      await act(async () => { memory.providers[0].close(1006); });
      await act(async () => { typeInBlock(latestEditor(seen)!, INTRO.id, ' Offline words.'); });
      await settle(1_000);
      assert.equal(saves(calls).length, before, 'no content save of any kind while the room is offline');
      access.state.offline = false;
      await waitForReactCondition(() => /Offline words\./.test(other.ydoc.getXmlFragment('document').toString()), 'the other editor gets the text after the reconnect');
      await settle(1_000);
      assert.deepEqual(revisionedSaves(calls), [], 'no revisioned save when the room connects or reconnects');
    } finally {
      await act(async () => { other.destroy(); });
    }
  });
});

/** Opens a reader whose room is held back, types into the intro, then lets the room in. */
async function typeBeforeTheRoom(mount: (element: ReturnType<typeof createElement>) => Promise<HTMLElement>, options: { init: boolean; serverBlocks?: Block[] }) {
  stubLayout();
  const document = notesDocument();
  const access = tickets();
  const { api, calls } = createMemoryDocumentApi(document, 0, { collabTicket: access.issue, collabInit: async () => ({ initialize: options.init }), outsideRoom: true });
  const memory = createMemoryCollabRoom();
  if (options.serverBlocks) await writeServerRoom(memory, options.serverBlocks);
  const seen: Editor[] = [];
  await mount(readerElement(api, memory, PRIYA, document, seen));
  await waitForReactCondition(() => /Intro paragraph/.test(latestEditor(seen)?.state.doc.textContent ?? ''), 'the editor loads');
  const unbound = latestEditor(seen)!;
  assert.equal(isBound(unbound), false);
  await act(async () => {
    typeInBlock(unbound, INTRO.id, ' Typed early.');
    unbound.view.focus();
  });
  const anchor = selectionAnchor(unbound);
  await act(async () => { access.open(); });
  return { api, calls, memory, seen, anchor, focused: unbound.isFocused };
}

test('B: text typed before the room is ready joins a room that already had content, and keeps the caret', async () => {
  await withJsdomRoot(async (mount) => {
    const view = await typeBeforeTheRoom(mount, { init: false, serverBlocks: [TITLE, INTRO, { ...OTHER, source: 'Other paragraph, edited in the room.' }] });
    await waitForReactCondition(() => isBound(latestEditor(view.seen)), 'the editor binds');
    const bound = latestEditor(view.seen)!;
    await waitForReactCondition(() => /Typed early\./.test(roomText(view.memory)), 'the early text is in the room');
    assert.match(roomText(view.memory), /Other paragraph, edited in the room\./, 'the room keeps what others changed elsewhere');
    await waitForReactCondition(() => /edited in the room/.test(bound.state.doc.textContent) && /Typed early/.test(bound.state.doc.textContent), 'the bound editor shows both');
    assert.equal(view.focused, true, 'the unbound editor had focus');
    await waitForReactCondition(() => bound.isFocused, 'the bound editor takes focus');
    assert.deepEqual(selectionAnchor(bound), view.anchor, 'the caret stays in the same block at the same offset');
    await settle(1_000);
    assert.deepEqual(revisionedSaves(view.calls), [], 'the draft is not saved as a revisioned save');
  });
});

test('B: text typed before the room is ready is in the seed when this editor seeds the room', async () => {
  await withJsdomRoot(async (mount) => {
    const view = await typeBeforeTheRoom(mount, { init: true });
    await waitForReactCondition(() => isBound(latestEditor(view.seen)), 'the editor binds');
    assert.match(roomText(view.memory), /Intro paragraph\. Typed early\./);
    await settle(1_000);
    assert.deepEqual(revisionedSaves(view.calls), []);
  });
});

test('B: text typed before the room is ready joins the seed someone else wrote while this editor waited', async () => {
  await withJsdomRoot(async (mount) => {
    const view = await typeBeforeTheRoom(mount, { init: false });
    await waitForReactCondition(() => view.calls.some((call) => call.method === 'initCollab'), 'it asks to seed and is refused');
    await settle(20);
    assert.equal(isBound(latestEditor(view.seen)), false, 'it waits for the seed');
    await act(async () => { await writeServerRoom(view.memory, [TITLE, INTRO, { ...OTHER, source: 'Other paragraph, seeded elsewhere.' }]); });
    await waitForReactCondition(() => isBound(latestEditor(view.seen)), 'the editor binds once the seed arrives');
    await waitForReactCondition(() => /Typed early\./.test(roomText(view.memory)), 'the early text is in the room');
    assert.match(roomText(view.memory), /Other paragraph, seeded elsewhere\./);
    await settle(1_000);
    assert.deepEqual(revisionedSaves(view.calls), []);
  });
});

test('B: binding drops the pending draft without saving it, and leaving the room does not bring it back', async () => {
  await withJsdomRoot(async (mount) => {
    const document = notesDocument();
    const { api, calls } = createMemoryDocumentApi(document);
    const view: { edits: ReturnType<typeof useCloudDocumentEdits> | null } = { edits: null };
    function Harness({ collaborating }: { collaborating: boolean }) {
      view.edits = useCloudDocumentEdits({ api, document, enabled: true, collaborating, onDocument: () => undefined, onAnnotations: () => undefined });
      return null;
    }
    await mount(createElement(Harness, { collaborating: false }));
    await act(async () => { view.edits!.updateSource(markdownOf([TITLE, { ...INTRO, source: 'Intro paragraph. Typed early.' }, OTHER])); });
    await mount(createElement(Harness, { collaborating: true }));
    assert.equal(view.edits!.draft, null, 'the draft is dropped at binding');
    await mount(createElement(Harness, { collaborating: false }));
    await settle(900);
    assert.deepEqual(saves(calls), [], 'neither binding nor leaving saves it');
  });
});

type Participant = { user: CollabUser; clientId: number; room: DocumentRoom | null; editors: Editor[]; notices: number; changes: number };

const participant = (user: CollabUser, clientId: number): Participant => ({ user, clientId, room: null, editors: [], notices: 0, changes: 0 });

/** Editors side by side; `store` is the document each view holds (what a `document.updated` refetch hands over). */
function editorsElement(api: Api['api'], memory: Memory, people: Participant[], initial: DocumentResponse, store: DocumentResponse, timing = FAST) {
  return createElement('div', null, ...people.map((person) => createElement(DocumentEditor, {
    key: person.user.accountId,
    collab: { api, attachmentId: ATTACHMENT, user: person.user },
    createProvider: memory.createProvider,
    roomTiming: timing,
    onRoom: (room: DocumentRoom) => { room.ydoc.clientID = person.clientId; person.room = room; },
    storeDocument: store,
    blocks: initial.blocks.map((block) => ({ id: block.id, source: block.source })),
    revisionKey: 'notes',
    editable: true,
    canComment: false,
    canReact: false,
    reactions: [],
    comments: [],
    composingBlock: null,
    renderAnnotations: () => null,
    onChange: () => { person.changes += 1; },
    onComment: () => undefined,
    onReact: () => undefined,
    onUpdatedElsewhere: () => { person.notices += 1; },
    onEditor: (editor: Editor | null) => { if (editor) person.editors.push(editor); },
  })));
}

/** Two editors bound to one seeded room, with a slow snapshot debounce so room edits wait to be snapshotted. */
async function boundPair(mount: (element: ReturnType<typeof createElement>) => Promise<HTMLElement>) {
  stubLayout();
  const initial = notesDocument();
  const access = tickets();
  access.open();
  let grants = 0;
  const { api, calls } = createMemoryDocumentApi(initial, 0, { collabTicket: access.issue, collabInit: async () => ({ initialize: grants++ === 0 }), outsideRoom: true });
  const memory = createMemoryCollabRoom();
  const writer = participant(PRIYA, 3);
  const other = participant(ALEX, 9);
  const timing = { ...FAST, snapshotDelayMs: 400 };
  const render = (store: DocumentResponse) => mount(editorsElement(api, memory, [writer, other], initial, store, timing));
  await render(initial);
  await waitForReactCondition(() => [writer, other].every((person) => isBound(latestEditor(person.editors)) && /Other paragraph/.test(latestEditor(person.editors)!.state.doc.textContent)), 'both editors bind');
  await waitForReactCondition(() => writer.room!.peers().length === 1, 'they see each other');
  await settle(500);
  assert.equal(writer.room!.isSnapshotWriter(), true);
  assert.equal(other.room!.isSnapshotWriter(), false);
  return { api, calls, memory, access, writer, other, render };
}

/** An agent's revisioned save outside the room that rewrites the intro. */
async function agentSave(api: Api['api']) {
  const current = await api.getDocument(ATTACHMENT);
  const blocks = current.blocks.map((block) => (block.id === INTRO.id ? { id: block.id, source: 'Intro rewritten by the agent.' } : { id: block.id, source: block.source }));
  const result = await api.saveDocumentContent(ATTACHMENT, { baseRevision: current.revision ?? 0, source: markdownOf(blocks) });
  assert.equal(result.status, 'saved');
  assert.equal(result.document.outsideRoomRevision, result.document.revision);
  return result.document;
}

test('C: the snapshot writer merges a save from outside the room it learns about; room edits elsewhere survive', async () => {
  await withJsdomRoot(async (mount) => {
    const pair = await boundPair(mount);
    await act(async () => { typeInBlock(latestEditor(pair.other.editors)!, OTHER.id, ' Edited by Alex.'); });
    await waitForReactCondition(() => /Edited by Alex/.test(roomText(pair.memory)), 'the room has the edit');
    const outside = await agentSave(pair.api);
    const otherKnown = pair.other.room!.known!.revision;
    await act(async () => { await pair.render(outside); });
    await waitForReactCondition(() => /Intro rewritten by the agent\./.test(roomText(pair.memory)), 'the outside save is merged into the room');
    assert.match(roomText(pair.memory), /Edited by Alex\./, 'the room edit in another block stays');
    await waitForReactCondition(() => saves(pair.calls).some((save) => save.baseRevision === outside.revision), 'the writer snapshots on the outside revision');
    const snapshot = saves(pair.calls).filter((save) => save.mode === 'snapshot').at(-1)!;
    assert.match(snapshot.source, /Intro rewritten by the agent\./);
    assert.match(snapshot.source, /Edited by Alex\./);
    assert.equal(pair.other.room!.known!.revision, otherKnown, 'the other editor does not take the outside revision as known');
    const latest = await pair.api.getDocument(ATTACHMENT);
    assert.ok((latest.revision ?? 0) > (latest.outsideRoomRevision ?? 0), 'the latest save is the room snapshot');
    await act(async () => { await pair.render(latest); });
    assert.equal(pair.other.room!.known!.revision, latest.revision, 'it takes a room snapshot as known');
    assert.equal(pair.writer.notices + pair.other.notices, 0, 'different blocks: no conflict notice');
  });
});

test('C: a snapshot refused for an older base merges the outside save in and snapshots again', async () => {
  await withJsdomRoot(async (mount) => {
    const pair = await boundPair(mount);
    await act(async () => { typeInBlock(latestEditor(pair.other.editors)!, OTHER.id, ' Edited by Alex.'); });
    const outside = await agentSave(pair.api);
    // Nobody hands the views the new document; the writer's debounced snapshot runs into the 409.
    await waitForReactCondition(() => saves(pair.calls).some((save) => save.mode === 'snapshot' && save.baseRevision === outside.revision), 'the writer snapshots again on the outside revision');
    const refused = saves(pair.calls).filter((save) => save.mode === 'snapshot' && (save.baseRevision ?? 0) < (outside.revision ?? 0));
    assert.ok(refused.length >= 1, 'the first snapshot was on the older base');
    const latest = await pair.api.getDocument(ATTACHMENT);
    assert.match(latest.blocks.map((block) => block.source).join('\n'), /Intro rewritten by the agent\.[\s\S]*Edited by Alex\./, 'the store has both');
    assert.match(roomText(pair.memory), /Intro rewritten by the agent\./);
    assert.equal(pair.writer.room!.known!.revision, latest.revision);
  });
});

test('C: a later ticket\'s stale hint brings a save made outside the room in after the reconnect', async () => {
  await withJsdomRoot(async (mount) => {
    const pair = await boundPair(mount);
    pair.access.state.offline = true;
    await act(async () => { pair.memory.providers.forEach((provider) => provider.close(1006)); });
    const changes = pair.writer.changes;
    await act(async () => { typeInBlock(latestEditor(pair.writer.editors)!, OTHER.id, ' Edited offline by Priya.'); });
    assert.equal(pair.writer.changes, changes, 'a bound editor reports no revisioned change while offline');
    const outside = await agentSave(pair.api);
    pair.access.state.stale = true;
    pair.access.state.offline = false;
    await waitForReactCondition(() => /Intro rewritten by the agent\./.test(roomText(pair.memory)), 'the stale hint merges the outside save into the room');
    assert.match(roomText(pair.memory), /Edited offline by Priya\./, 'the offline room edit stays');
    await waitForReactCondition(() => saves(pair.calls).some((save) => save.baseRevision === outside.revision), 'and the writer snapshots on it');
    assert.equal(pair.writer.room!.staleRevision || pair.other.room!.staleRevision, false, 'the hint was used');
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { DocumentResponse } from '../src/features/documents/documentShareTypes';
import { documentTitleFor, resetDocumentTitlesForTests } from '../src/features/documents/documentTitles';
import type { SessionArtifact } from '../src/kordi-app/types';
import { ArtifactCard, ArtifactThumbnailView } from '../src/pages/ArtifactCard';
import { readStoredArtifactLayout } from '../src/pages/artifactLayoutPreference';
import { ArtifactListRow } from '../src/pages/ArtifactListRow';
import { artifactThumbnailKey, loadArtifactThumbnail, THUMBNAIL_SOURCE_CHARS } from '../src/pages/artifactThumbnail';
import { openArtifactExternally } from '../src/pages/openArtifactExternally';

const doc = (id: string, path: string, extra: Partial<SessionArtifact> = {}): SessionArtifact => ({
  id, path, name: path.split('/').pop() ?? path, kind: 'document', category: 'artifact', summary: 'Created', ...extra,
});

const api = {
  getDocument: async (attachmentId: string) => ({
    attachmentId,
    title: 'Launch plan',
    blocks: [{ id: 'b1', source: '# Launch plan', html: '' }, { id: 'b2', source: 'Ship on Friday.', html: '' }],
  }) as unknown as DocumentResponse,
  getDocumentRaw: async () => '<h1>Pricing</h1>'.padEnd(THUMBNAIL_SOURCE_CHARS + 50, ' '),
};

test('the Artifacts tab starts in cards unless the list was chosen', () => {
  assert.equal(readStoredArtifactLayout({ getItem: () => null }), 'cards');
  assert.equal(readStoredArtifactLayout({ getItem: () => 'list' }), 'list');
  assert.equal(readStoredArtifactLayout({ getItem: () => 'grid' }), 'cards');
  assert.equal(readStoredArtifactLayout({ getItem: () => { throw new Error('blocked'); } }), 'cards');
});

test('a cloud document thumbnail reads its blocks, an HTML one its raw page, and both stay short', async () => {
  resetDocumentTitlesForTests();
  const markdown = await loadArtifactThumbnail(doc('a', 'notes/plan.md', { attachmentId: 'att_plan' }), { isNativeShell: false, api });
  assert.deepEqual(markdown, { kind: 'markdown', source: '# Launch plan\n\nShip on Friday.' });
  assert.equal(documentTitleFor('att_plan'), 'Launch plan', 'the title is remembered for the card label');

  const html = await loadArtifactThumbnail(doc('b', 'site/pricing.html', { attachmentId: 'att_page' }), { isNativeShell: false, api });
  assert.equal(html?.kind, 'html');
  assert.equal(html?.source.length, THUMBNAIL_SOURCE_CHARS);
});

test('images and files with nothing to read show the file-type mark', async () => {
  assert.equal(await loadArtifactThumbnail(doc('c', 'shots/hero.png', { kind: 'file' }), { isNativeShell: false, api }), null);
  // Not the desktop app and no cloud copy: nothing to read.
  assert.equal(await loadArtifactThumbnail(doc('d', 'src/app.ts', { kind: 'code' }), { isNativeShell: false, api: null }), null);
  const failing = { getDocument: async () => { throw new Error('offline'); }, getDocumentRaw: async () => { throw new Error('offline'); } };
  assert.equal(await loadArtifactThumbnail(doc('e', 'notes/plan.md', { attachmentId: 'att_x' }), { isNativeShell: false, api: failing }), null);
});

test('a thumbnail reloads after an edit, and a pinned file ignores the project root', () => {
  const artifact = doc('a', 'notes/plan.md', { timeLabel: '10:24' });
  assert.notEqual(artifactThumbnailKey(artifact), artifactThumbnailKey({ ...artifact, timeLabel: '10:31' }));
  assert.notEqual(artifactThumbnailKey(artifact), artifactThumbnailKey({ ...artifact, live: true }));
  assert.equal(artifactThumbnailKey({ ...artifact, pinned: true }, '/root/a'), artifactThumbnailKey({ ...artifact, pinned: true }, '/root/b'));
});

test('a card shows the title, the type pill, the creator and time, and Live for a file being written', () => {
  const markup = renderToStaticMarkup(createElement(ArtifactCard, {
    artifact: doc('a', 'notes/launch-brief.md', { timeLabel: '10:24', createdByAccountId: 'acct_priya' }),
    isActive: false,
    participants: [{ id: 'acct_priya', name: 'Priya Nair', kind: 'human', role: 'member' }],
    thumbnailContext: { isNativeShell: false, api: null },
    onOpen: () => {},
    fetchTitle: async () => ({ title: '' }),
  }));
  assert.match(markup, /data-artifact-card-title=""[^>]*>launch-brief\.md</);
  assert.match(markup, />MD</);
  assert.match(markup, /Priya Nair[^]*10:24/);
  assert.doesNotMatch(markup, /aria-current/, 'nothing is marked before it is opened');

  const live = renderToStaticMarkup(createElement(ArtifactCard, {
    artifact: doc('b', 'Untitled', { live: true, timeLabel: '10:30' }),
    isActive: true,
    participants: [],
    thumbnailContext: { isNativeShell: false, api: null },
    onOpen: () => {},
    fetchTitle: async () => ({ title: '' }),
  }));
  assert.match(live, />Live</);
  assert.doesNotMatch(live, /10:30/, 'Live replaces the time');
  assert.doesNotMatch(live, /app-artifact-card-type/, 'no type pill for a bare name');
  assert.match(live, /aria-current="true"/);
});

test('code and table thumbnails keep only the first lines and columns', () => {
  const code = renderToStaticMarkup(createElement(ArtifactThumbnailView, {
    thumbnail: { kind: 'source', source: Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n') }, path: 'src/a.ts',
  }));
  // The page measures itself before it draws, so server markup is the empty frame.
  assert.match(code, /app-artifact-card-code/);
  const html = renderToStaticMarkup(createElement(ArtifactThumbnailView, { thumbnail: { kind: 'html', source: '<script>alert(1)</script>' }, path: 'a.html' }));
  assert.doesNotMatch(html, /alert/, 'nothing renders before the frame has a size');
});

test('open in default app uses a fresh copy of a shared document, and the project file otherwise', async () => {
  const copies: Array<[string, string]> = [];
  const opened: Array<[string, string | null]> = [];
  const deps = {
    api,
    openCopy: async (name: string, contents: string) => { copies.push([name, contents]); },
    open: async (path: string, baseRoot: string | null) => { opened.push([path, baseRoot]); },
  };
  await openArtifactExternally(doc('a', 'notes/plan.md', { attachmentId: 'att_plan' }), '/project', deps);
  assert.deepEqual(copies, [['plan.md', '# Launch plan\n\nShip on Friday.']], 'the cloud copy carries everyone\'s edits');
  assert.deepEqual(opened, []);

  await openArtifactExternally(doc('b', 'src/app.ts', { kind: 'code' }), '/project', deps);
  await openArtifactExternally(doc('c', '/abs/pinned.md', { pinned: true }), '/project', deps);
  assert.deepEqual(opened, [['src/app.ts', '/project'], ['/abs/pinned.md', null]], 'a pinned file ignores the project root');

  const offline = { ...deps, api: { getDocument: async () => { throw new Error('offline'); }, getDocumentRaw: async () => { throw new Error('offline'); } } };
  await openArtifactExternally(doc('d', 'notes/draft.md', { attachmentId: 'att_draft' }), '/project', offline);
  assert.deepEqual(opened.at(-1), ['notes/draft.md', '/project'], 'without the server, the project file opens');

  await assert.rejects(openArtifactExternally(doc('e', 'missing.ts', { kind: 'code' }), null, {
    ...deps, open: async () => { throw new Error('Artifact file not found'); },
  }));
});

test('the open arrow shows on rows and cards only where a file can be opened', () => {
  const artifact = doc('a', 'notes/plan.md', { timeLabel: '10:24' });
  const rowWith = renderToStaticMarkup(createElement(ArtifactListRow, { artifact, location: 'notes', isActive: false, participants: [], onSelect: () => {}, onOpenExternal: () => {}, fetchTitle: async () => ({ title: '' }) }));
  assert.match(rowWith, /data-artifact-open-external=""[^>]*aria-label="Open plan\.md in its default app"/);
  const rowWithout = renderToStaticMarkup(createElement(ArtifactListRow, { artifact, location: 'notes', isActive: false, participants: [], onSelect: () => {}, fetchTitle: async () => ({ title: '' }) }));
  assert.doesNotMatch(rowWithout, /data-artifact-open-external/);
  // The row is one line: the name and its detail sit side by side.
  assert.match(rowWithout, /data-artifact-row-title=""[^>]*>plan\.md<\/span><span data-artifact-row-meta=""[^>]*>notes · Created · 10:24</);

  const card = renderToStaticMarkup(createElement(ArtifactCard, {
    artifact, isActive: false, participants: [], thumbnailContext: { isNativeShell: true, api: null }, onOpen: () => {}, onOpenExternal: () => {}, fetchTitle: async () => ({ title: '' }),
  }));
  assert.match(card, /class="app-artifact-card-open"[^>]*aria-label="Open plan\.md in its default app"/);
});
